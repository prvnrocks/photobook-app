import type { Breadcrumb, ErrorEvent, Event } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import {
  MAX_STRING,
  isSensitiveKey,
  scrubBreadcrumb,
  scrubEvent,
  scrubString,
  scrubUrl,
} from "@/lib/observability/scrub";
import { sentryOptions } from "@/lib/observability/sentry-options";

const UUID = "3f2b8c1e-9a7d-4e21-b0c4-5d6e7f809a1b";
const SIGNED_URL =
  "https://abc.supabase.co/storage/v1/object/sign/photos/u/1.jpg?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1cmwiOiJwaG90b3MvdS8xLmpwZyJ9.c2lnbmF0dXJlLXZhbHVlLTEyMzQ1";
const PRINT_TOKEN =
  "eyJ2IjoxLCJ4IjoiM2YyYjhjMWUiLCJiIjoiYWJjIiwiciI6MywiZiI6MCwidCI6MiwiZSI6MTcwMDAwMDAwMH0.Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1u";
const STATIC_PRINT_TOKEN = "AbCdEfGh1234567890IjKlMnOpQrStUv.WxYz0987654321AbCdEfGhIjKl";

function json(v: unknown) {
  return JSON.stringify(v);
}

describe("scrubString", () => {
  it("strips query strings from absolute signed URLs", () => {
    expect(scrubString(`failed to load ${SIGNED_URL} (403)`)).toBe(
      "failed to load https://abc.supabase.co/storage/v1/object/sign/photos/u/1.jpg (403)",
    );
  });

  it("strips query strings and token-bearing fragments from relative paths", () => {
    expect(scrubString(`GET /print/${UUID}?t=${PRINT_TOKEN} 500`)).toBe("GET /print/:id 500");
    expect(scrubString("/auth/confirm?token_hash=abc&type=magiclink")).toBe("/auth/confirm");
    expect(scrubString("https://app.example/#access_token=xyz&refresh_token=q")).toBe(
      "https://app.example/",
    );
  });

  it("keeps ordinary punctuation", () => {
    expect(scrubString("Is this ok? Yes. Error #5")).toBe("Is this ok? Yes. Error #5");
  });

  it("replaces /b/<slug> with /b/:slug, idempotently", () => {
    expect(scrubString("https://photobook.ae/b/sara-wedding-x7k2/og")).toBe(
      "https://photobook.ae/b/:slug/og",
    );
    expect(scrubString("/b/my-trip")).toBe("/b/:slug");
    expect(scrubString(scrubString("/b/my-trip"))).toBe("/b/:slug");
  });

  it("replaces UUIDs, emails and tokens", () => {
    expect(scrubString(`book ${UUID} of sara.k+test@example.ae`)).toBe("book :id of [email]");
    expect(scrubString(`print token ${PRINT_TOKEN} bad`)).toBe("print token [token] bad");
    expect(scrubString(`print token ${STATIC_PRINT_TOKEN} bad`)).toBe("print token [token] bad");
    expect(scrubString("sig 9fJ2kLm0pQ8rStUvWxYz12345678AbCd_-ef")).toBe("sig [token]");
    expect(scrubString("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc")).toBe("Bearer [token]");
  });

  it("leaves short identifiers and chunk hashes readable", () => {
    expect(scrubString("TypeError: Cannot read properties of undefined (reading 'photoId')")).toBe(
      "TypeError: Cannot read properties of undefined (reading 'photoId')",
    );
    expect(scrubString("app:///_next/static/chunks/page-1a2b3c4d5e6f7a8b.js")).toBe(
      "app:///_next/static/chunks/page-1a2b3c4d5e6f7a8b.js",
    );
  });

  it("truncates long strings without splitting surrogate pairs", () => {
    const out = scrubString("😀".repeat(MAX_STRING));
    expect(out.length).toBeLessThanOrEqual(MAX_STRING);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it("scrubUrl drops everything after ? or #", () => {
    expect(scrubUrl(`/api/books/${UUID}/pdf?x=1#y`)).toBe("/api/books/:id/pdf");
  });
});

describe("isSensitiveKey", () => {
  it.each([
    "caption",
    "captionText",
    "cover_title",
    "title",
    "text",
    "doc",
    "prompt",
    "output",
    "name",
    "user.name",
    "fileName",
    "description",
    "body",
    "x-print-token",
  ])("%s is sensitive", (k) => expect(isSensitiveKey(k)).toBe(true));

  it.each(["status", "context", "filename", "method", "pageCount", "status_code", "url"])(
    "%s is not sensitive",
    (k) => expect(isSensitiveKey(k)).toBe(false),
  );
});

describe("scrubEvent", () => {
  const base = (): ErrorEvent => ({
    type: undefined,
    event_id: "e1",
    message: `Publish failed for /b/sara-wedding (${UUID})`,
    user: { id: UUID, email: "a@b.co", ip_address: "1.2.3.4", username: "sara" },
    request: {
      method: "POST",
      url: `https://photobook.ae/books/${UUID}/edit?tab=captions`,
      query_string: "tab=captions",
      data: { doc: { pages: [{ caption: "Eid with Teta" }] } },
      cookies: { "sb-access-token": "secret" },
      env: { REMOTE_ADDR: "1.2.3.4" },
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone)",
        cookie: "sb=1",
        authorization: "Bearer x",
        "x-forwarded-for": "1.2.3.4",
        referer: "https://photobook.ae/b/sara-wedding",
        "x-print-token": PRINT_TOKEN,
        "x-vercel-protection-bypass": "bypass-secret",
      },
    },
    exception: {
      values: [
        {
          type: "Error",
          value: `Storage 403 for ${SIGNED_URL}`,
          stacktrace: {
            frames: [
              {
                filename: "app:///_next/static/chunks/app/b/page.js?v=abc",
                abs_path: "https://photobook.ae/_next/static/chunks/app/page.js?dpl=dpl_123",
                function: "render",
                vars: { caption: "Eid with Teta", photoId: UUID },
              },
            ],
          },
        },
      ],
    },
    extra: {
      caption: "Eid with Teta",
      bookTitle: "Sara's wedding",
      attempt: 2,
      nested: { promptText: "describe", status: `ok for ${UUID}`, deeper: { doc: {} } },
    },
    tags: { route: "/b/:slug", userEmail: "a@b.co", runtime: "node" },
    contexts: {
      os: { name: "iOS", version: "18.1" },
      browser: { name: "Mobile Safari", version: "18.1" },
      response: { headers: { "set-cookie": "x" }, status_code: 500 },
      book: { title: "Sara's wedding", pageCount: 20, slug: "sara-wedding" },
      caption: { text: "x" },
    },
    breadcrumbs: [
      {
        category: "fetch",
        data: { method: "GET", url: SIGNED_URL, status_code: 403 },
      },
    ],
  });

  it("drops user, request body, cookies, query, env and unsafe headers", () => {
    const out = scrubEvent(base());
    expect(out.user).toBeUndefined();
    expect(out.request).toEqual({
      method: "POST",
      url: "https://photobook.ae/books/:id/edit",
      headers: { "User-Agent": "Mozilla/5.0 (iPhone)" },
    });
  });

  it("scrubs message, exception values and stack frames", () => {
    const out = scrubEvent(base());
    expect(out.message).toBe("Publish failed for /b/:slug (:id)");
    const ex = out.exception!.values![0];
    expect(ex.value).toBe("Storage 403 for https://abc.supabase.co/storage/v1/object/sign/photos/u/1.jpg");
    const frame = ex.stacktrace!.frames![0];
    expect(frame.vars).toBeUndefined();
    expect(frame.filename).toBe("app:///_next/static/chunks/app/b/page.js");
    expect(frame.abs_path).toBe("https://photobook.ae/_next/static/chunks/app/page.js");
    expect(frame.function).toBe("render");
  });

  it("drops caption/title/prompt-like keys in extra, tags and custom contexts", () => {
    const out = scrubEvent(base());
    expect(out.extra).toEqual({ attempt: 2, nested: { status: "ok for :id", deeper: {} } });
    expect(out.tags).toEqual({ route: "/b/:slug", runtime: "node" });
    expect(out.contexts).toEqual({
      os: { name: "iOS", version: "18.1" },
      browser: { name: "Mobile Safari", version: "18.1" },
      book: { pageCount: 20 },
    });
  });

  it("scrubs breadcrumbs inside the event", () => {
    const out = scrubEvent(base());
    expect(out.breadcrumbs).toEqual([
      {
        category: "fetch",
        data: {
          method: "GET",
          url: "https://abc.supabase.co/storage/v1/object/sign/photos/u/1.jpg",
          status_code: 403,
        },
      },
    ]);
  });

  it("leaves no secret, id, email, slug or caption anywhere in the payload", () => {
    const s = json(scrubEvent(base()));
    for (const leak of [
      UUID,
      "a@b.co",
      "1.2.3.4",
      "sara-wedding",
      "Eid with Teta",
      "Sara's wedding",
      "token=",
      PRINT_TOKEN,
      "bypass-secret",
      "sb-access-token",
      "tab=captions",
      "describe",
    ]) {
      expect(s, leak).not.toContain(leak);
    }
  });

  it("does not mutate its input", () => {
    const ev = base();
    const before = json(ev);
    scrubEvent(ev);
    expect(json(ev)).toBe(before);
  });

  it("scrubs transaction names and span descriptions/data", () => {
    const tx: Event = {
      type: "transaction",
      transaction: "/b/sara-wedding?x=1",
      spans: [
        {
          span_id: "a",
          trace_id: "b",
          start_timestamp: 0,
          status: "ok",
          description: `GET https://abc.supabase.co/rest/v1/books?id=eq.${UUID}`,
          data: { "url.full": SIGNED_URL, "http.request.header.cookie": "x", caption: "hi" },
        },
      ],
    };
    const out = scrubEvent(tx);
    expect(out.transaction).toBe("/b/:slug");
    expect(out.spans![0].description).toBe("GET https://abc.supabase.co/rest/v1/books");
    expect(out.spans![0].data).toEqual({
      "url.full": "https://abc.supabase.co/storage/v1/object/sign/photos/u/1.jpg",
    });
  });
});

describe("scrubBreadcrumb", () => {
  it("scrubs navigation from/to", () => {
    const b: Breadcrumb = {
      category: "navigation",
      data: { from: `/books/${UUID}/edit?x=1`, to: "/b/sara-wedding" },
    };
    expect(scrubBreadcrumb(b).data).toEqual({ from: "/books/:id/edit", to: "/b/:slug" });
  });

  it("removes DOM attributes (alt/title/aria-label can hold captions) from ui selectors", () => {
    const b: Breadcrumb = {
      category: "ui.click",
      message: 'div.page > img.photo[alt="Eid with Teta"][title="Sara"]',
    };
    expect(scrubBreadcrumb(b).message).toBe("div.page > img.photo");
  });

  it("drops console arguments and scrubs the console message", () => {
    const b: Breadcrumb = {
      category: "console",
      level: "warning",
      message: `caption save failed for ${UUID}: a@b.co`,
      data: { arguments: ["caption save failed", { caption: "Eid with Teta" }], logger: "console" },
    };
    expect(scrubBreadcrumb(b)).toEqual({
      category: "console",
      level: "warning",
      message: "caption save failed for :id: [email]",
      data: { logger: "console" },
    });
  });

  it("drops sensitive keys in nested breadcrumb data", () => {
    const b: Breadcrumb = {
      category: "app",
      data: {
        step: "captions",
        detail: { book: { title: "Sara", pages: [{ caption: "x", layout: "full" }] }, id: UUID },
      },
    };
    expect(scrubBreadcrumb(b).data).toEqual({
      step: "captions",
      detail: { book: { pages: [{ layout: "full" }] }, id: ":id" },
    });
  });

  it("removes data entirely when nothing safe is left", () => {
    expect(scrubBreadcrumb({ category: "app", data: { caption: "x" } })).toEqual({ category: "app" });
  });
});

describe("sentryOptions", () => {
  it("is disabled without a DSN", () => {
    expect(sentryOptions({ dsn: undefined, environment: undefined })).toMatchObject({
      enabled: false,
      dsn: undefined,
      environment: "development",
    });
    expect(sentryOptions({ dsn: "  ", environment: "preview" }).enabled).toBe(false);
  });

  it("is privacy-first when enabled", () => {
    const o = sentryOptions({ dsn: "https://k@o1.ingest.de.sentry.io/1", environment: "production" });
    expect(o.enabled).toBe(true);
    expect(o.environment).toBe("production");
    expect(o.sendDefaultPii).toBe(false);
    expect(o.tracePropagationTargets).toEqual([]);
    expect(o).not.toHaveProperty("tracesSampleRate");
    expect(o).not.toHaveProperty("replaysSessionSampleRate");
    expect(o).not.toHaveProperty("integrations");
    expect(o.beforeSend).toBe(scrubEvent);
    expect(o.beforeSendTransaction).toBe(scrubEvent);
    expect(o.beforeBreadcrumb).toBe(scrubBreadcrumb);
  });
});
