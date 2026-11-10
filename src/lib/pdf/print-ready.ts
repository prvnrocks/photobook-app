// Ready signal for the print page (M8 T5/T6 contract, D-052). Pure controller so it is
// unit-testable with fakes; <PrintReady> wires it to the real document/window.
//
// Ready = every <img> has decode()d or failed (a failure is recorded as error "image" but still
// counts as settled) AND document.fonts.ready resolved — or the hard cap elapsed (timeout).

/** Hard cap: after this the page reports ready anyway, flagged as a timeout. */
export const PRINT_READY_TIMEOUT_MS = 20_000;

export interface PrintReadyResult {
  /** "image" when at least one image failed to load/decode. */
  error: "image" | null;
  timeout: boolean;
}

export interface PrintReadyDeps {
  images: Iterable<{ decode(): Promise<void> }>;
  fontsReady: Promise<unknown>;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function waitForPrintReady(deps: PrintReadyDeps): Promise<PrintReadyResult> {
  const timeoutMs = deps.timeoutMs ?? PRINT_READY_TIMEOUT_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let imageError = false;
  const decodes = Array.from(deps.images, (img) => {
    let p: Promise<void>;
    try {
      p = Promise.resolve(img.decode());
    } catch {
      p = Promise.reject(new Error("decode threw"));
    }
    return p.then(
      () => undefined,
      () => {
        imageError = true;
      },
    );
  });
  // A rejected fonts.ready (should not happen) must not block the PDF either.
  const fonts = Promise.resolve(deps.fontsReady).then(
    () => undefined,
    () => undefined,
  );

  return new Promise<PrintReadyResult>((resolve) => {
    let done = false;
    const handle = setTimer(() => {
      if (done) return;
      done = true;
      resolve({ error: imageError ? "image" : null, timeout: true });
    }, timeoutMs);
    void Promise.all([...decodes, fonts]).then(() => {
      if (done) return;
      done = true;
      clearTimer(handle);
      resolve({ error: imageError ? "image" : null, timeout: false });
    });
  });
}

/** The window globals the renderer polls (T6 reads these with page.waitForFunction). */
export interface PrintReadyGlobals {
  __PRINT_READY__?: boolean;
  __PRINT_ERROR__?: "image";
  __PRINT_TIMEOUT__?: boolean;
}

/** Writes the result to the window globals; error/timeout flags are set BEFORE ready. */
export function publishPrintReady(target: PrintReadyGlobals, result: PrintReadyResult): void {
  if (result.error) target.__PRINT_ERROR__ = result.error;
  if (result.timeout) target.__PRINT_TIMEOUT__ = true;
  target.__PRINT_READY__ = true;
}
