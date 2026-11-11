// One-time editor coach line (M11 T13): "Tap a photo to swap, crop or change its layout".
// Remembered in localStorage once dismissed or once the user has tapped a photo. Storage can be
// unavailable (Safari private mode, blocked cookies, in-app browsers): every access is guarded, and
// without storage the line is hidden again for the rest of the page session after a dismiss.

export const EDITOR_COACH_KEY = "pb.editor.coach.v1";
export const EDITOR_COACH_TEXT = "Tap a photo to swap, crop or change its layout";

export type CoachStorage = Pick<Storage, "getItem" | "setItem">;

let memorySeen = false;
const listeners = new Set<() => void>();

function storage(): CoachStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** True once the coach line was dismissed (or the user tapped a photo). Never throws. */
export function coachSeen(store: CoachStorage | null = storage()): boolean {
  if (memorySeen) return true;
  try {
    return store?.getItem(EDITOR_COACH_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember the coach line as seen and notify subscribers. Never throws. */
export function markCoachSeen(store: CoachStorage | null = storage()): void {
  if (coachSeen(store)) return;
  memorySeen = true;
  try {
    store?.setItem(EDITOR_COACH_KEY, "1");
  } catch {
    // Storage full / blocked: the in-memory flag still hides it for this page session.
  }
  for (const l of listeners) l();
}

export function subscribeCoach(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Tests only: forget the in-memory flag. */
export function resetCoachMemoryForTests(): void {
  memorySeen = false;
}
