"use client";
// State + debounced saving for the upload screen's setup card (M13 T6, D-070). Every change is shown
// at once and sent with updateBookSetupAction after a short pause (changes made meanwhile are merged
// into one call; calls never overlap). The server re-checks every rule; a "locked" answer disables the
// card with the reason, other failures put the last saved value back. `flush()` sends whatever is
// still waiting — the auto-build calls it first so the AI reads the user's latest choices; `freeze()`
// then disables the card.
import { useCallback, useEffect, useRef, useState } from "react";
import { updateBookSetupAction } from "@/app/books/actions";
import { TITLE_MAX_CHARS, titleLength } from "@/app/books/form-state";
import type { CaptionLang, Occasion, Tone } from "@/lib/book/options";
import type { BookSetup, BookSetupPatch, UpdateBookSetupResult } from "@/lib/book/setup";
import type { BookFormat } from "@/lib/book/types";
import type { FormDesignStyle } from "@/lib/design/defaults";
import {
  hasFields,
  initialFollow,
  occasionPatch,
  type SetupFollow,
  type SetupLocks,
} from "@/lib/upload/setup-ui";

export type SetupSaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

const CHOICE_DELAY_MS = 400;
const TITLE_DELAY_MS = 900;
const SAVE_FAILED = "We couldn't save that change. Please try again.";

export type BookSetupController = ReturnType<typeof useBookSetup>;

export function useBookSetup(bookId: string, initial: BookSetup, initialLocks: SetupLocks) {
  const [setup, setSetup] = useState<BookSetup>(initial);
  const [titleDraft, setTitleDraft] = useState(initial.title ?? "");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [locks, setLocks] = useState<SetupLocks>(initialLocks);
  const [follow, setFollow] = useState<SetupFollow>(() => initialFollow(initial));
  const [status, setStatus] = useState<SetupSaveStatus>({ kind: "idle" });
  const [frozen, setFrozen] = useState(false);

  const confirmedRef = useRef<BookSetup>(initial);
  const pendingRef = useRef<BookSetupPatch>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  const frozenRef = useRef(false);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const send = useCallback(
    async (patch: BookSetupPatch): Promise<void> => {
      setStatus({ kind: "saving" });
      let res: UpdateBookSetupResult;
      try {
        res = await updateBookSetupAction(bookId, patch);
      } catch {
        res = { ok: false, error: "failed" };
      }
      if (unmountedRef.current) return;
      const waiting = hasFields(pendingRef.current);
      if (res.ok) {
        confirmedRef.current = res.setup;
        if (!waiting) setSetup((cur) => ({ ...res.setup, title: cur.title }));
        if (patch.title !== undefined) setTitleError(null);
        setStatus({ kind: "saved" });
        return;
      }
      if (res.error === "locked") {
        // Both reasons lock every setup field (M13 review: an edited album locks the details too),
        // so the controls disable now, without a reload.
        const reason = res.reason === "user_edited" ? "user_edited" : "ai_started";
        setLocks({ details: reason, design: reason });
        pendingRef.current = {};
        setSetup(confirmedRef.current);
        setTitleDraft(confirmedRef.current.title ?? "");
        setStatus({ kind: "idle" });
        return;
      }
      if (res.error === "invalid" && res.fieldErrors?.title) {
        setTitleError(res.fieldErrors.title);
        setStatus({ kind: "idle" });
        return;
      }
      // conflict (already retried on the server) / failed / signed out / not found
      setSetup(confirmedRef.current);
      setTitleDraft(confirmedRef.current.title ?? "");
      setStatus({ kind: "error", message: SAVE_FAILED });
    },
    [bookId],
  );

  /** Sends everything that's waiting (after any call in flight); resolves when saved or failed. */
  const flush = useCallback(async (): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    while (inflightRef.current) await inflightRef.current;
    const patch = pendingRef.current;
    if (!hasFields(patch)) return;
    pendingRef.current = {};
    const p = send(patch).finally(() => {
      inflightRef.current = null;
    });
    inflightRef.current = p;
    await p;
    // Changes made while that call ran.
    if (hasFields(pendingRef.current)) await flush();
  }, [send]);

  const queue = useCallback(
    (patch: BookSetupPatch, delay: number) => {
      if (frozenRef.current) return;
      pendingRef.current = { ...pendingRef.current, ...patch };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, delay);
    },
    [flush],
  );

  const apply = useCallback(
    (patch: BookSetupPatch, delay = CHOICE_DELAY_MS) => {
      if (frozenRef.current) return;
      setSetup((cur) => ({ ...cur, ...patch }) as BookSetup);
      setStatus({ kind: "idle" });
      queue(patch, delay);
    },
    [queue],
  );

  const setOccasion = (occasion: Occasion) => apply(occasionPatch(occasion, follow, locks));
  const setTone = (tone: Tone) => {
    setFollow((f) => ({ ...f, manualTone: true }));
    apply({ tone });
  };
  const setCaptionLang = (captionLang: CaptionLang) => apply({ captionLang });
  const setFormat = (format: BookFormat) => apply({ format });
  const setStyle = (designStyle: FormDesignStyle) => {
    setFollow((f) => ({ ...f, manualStyle: true }));
    apply({ designStyle });
  };
  const setTitle = (text: string) => {
    if (frozenRef.current) return;
    setTitleDraft(text);
    if (titleLength(text.trim()) > TITLE_MAX_CHARS) {
      setTitleError(`Title must be ${TITLE_MAX_CHARS} characters or fewer.`);
      return;
    }
    setTitleError(null);
    apply({ title: text.trim() === "" ? null : text }, TITLE_DELAY_MS);
  };

  /** Disable the card (the AI build is starting with these choices). */
  const freeze = useCallback(() => {
    frozenRef.current = true;
    setFrozen(true);
  }, []);

  /** Editable again (the automatic start didn't create a run). */
  const unfreeze = useCallback(() => {
    frozenRef.current = false;
    setFrozen(false);
  }, []);

  return {
    setup,
    titleDraft,
    titleError,
    locks,
    status,
    frozen,
    setOccasion,
    setTone,
    setCaptionLang,
    setFormat,
    setStyle,
    setTitle,
    flush,
    freeze,
    unfreeze,
  };
}
