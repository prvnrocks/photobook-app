import "server-only";
// PDF export status (M8 review S3): the poll side of /api/books/[id]/pdf, kept free of the
// renderer — no puppeteer, Chromium or sharp in this module's import graph
// (tests/pdf-status-route.test.ts walks it), so the lightweight
// /api/books/[id]/pdf/status route stays a small, cheap function.
//
// Ownership: the export row is read with the admin client AND an explicit user_id filter
// (getExportForOwner); the book (for the filename) with the user's session (RLS).

import { getMyBook } from "@/lib/db/books";
import {
  exportObjectPath,
  getExportForOwner,
  signExportUrl,
  supersedeExports,
  type ExportCaptionLang,
} from "@/lib/db/exports";
import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { isUuid } from "@/lib/uuid";
import { pdfFilename, SIGNED_URL_TTL_SECONDS } from "./rules";

/** A queued job older than this is re-kicked by heavy-route GET polls (its after() callback likely died). */
export const QUEUED_KICK_AFTER_MS = 10_000;

export interface ReadyExport {
  status: "ready";
  exportId: string;
  url: string;
  filename: string;
  bytes: number;
  pageCount: number;
}

export interface PendingExport {
  status: "queued" | "rendering";
  exportId: string;
}

export function captionLangOf(v: unknown): ExportCaptionLang {
  return v === "ar" ? "ar" : "en";
}

export function filenameFor(title: string | null | undefined, doc?: BookDoc | null): string {
  return pdfFilename(title || doc?.cover.title || "");
}

/** Marks a ready row whose PDF object is gone (never deletes — the daily cap counts rows). */
export async function markMissingFile(bookId: string, userId: string, exportId: string): Promise<void> {
  console.info(`[pdf-export] missing_file ${exportId}`);
  await supersedeExports(bookId, userId, [exportId], "missing_file");
}

export type ExportStateBody =
  | ReadyExport
  | { status: "queued" | "rendering" }
  /**
   * error: the job's code, or 'superseded' / 'missing_file' when the PDF was replaced by a newer
   * export / is gone — the client re-POSTs once to get the current PDF.
   */
  | { status: "failed"; error: string };

export type ExportStateResult = { found: false } | { found: true; body: ExportStateBody };

/**
 * The owner's job status; ready → fresh signed URL. `schedule` (heavy route only) re-kicks a job
 * that has stayed queued for QUEUED_KICK_AFTER_MS; the lightweight status route passes none and
 * the client re-POSTs instead (src/lib/pdf/ui.ts).
 */
export async function getExportState(
  bookId: string,
  userId: string,
  exportId: string,
  opts: { schedule?: (exportId: string) => void; now?: Date } = {},
): Promise<ExportStateResult> {
  if (!isUuid(bookId) || !isUuid(userId) || !isUuid(exportId)) return { found: false };
  const own = await getExportForOwner(exportId, userId);
  if (!own || own.bookId.toLowerCase() !== bookId.toLowerCase()) return { found: false };

  switch (own.status) {
    case "queued": {
      const age = (opts.now ?? new Date()).getTime() - Date.parse(own.createdAt);
      if (opts.schedule && Number.isFinite(age) && age >= QUEUED_KICK_AFTER_MS) opts.schedule(own.id);
      return { found: true, body: { status: "queued" } };
    }
    case "rendering":
      return { found: true, body: { status: "rendering" } };
    case "failed":
      return { found: true, body: { status: "failed", error: own.errorCode ?? "error" } };
    case "superseded":
      return {
        found: true,
        body: { status: "failed", error: own.errorCode === "missing_file" ? "missing_file" : "superseded" },
      };
    case "ready": {
      const book = await getMyBook(bookId); // RLS read: title for the filename, ownership again
      if (!book) return { found: false };
      const parsed = parseBookDoc(book.doc);
      const filename = filenameFor(book.title, parsed.ok ? parsed.doc : null);
      const url = await signExportUrl(exportObjectPath(userId, own.bookId, own.id), SIGNED_URL_TTL_SECONDS, filename);
      if (!url) {
        try {
          await markMissingFile(own.bookId, userId, own.id);
        } catch {
          // best effort: the next POST marks it again
        }
        return { found: true, body: { status: "failed", error: "missing_file" } };
      }
      return {
        found: true,
        body: { status: "ready", exportId: own.id, url, filename, bytes: own.bytes ?? 0, pageCount: own.pageCount ?? 0 },
      };
    }
  }
}
