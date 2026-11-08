// Device sniffing for small UX hints only (never for features or security). Pure.

/** iPhone / iPod / iPad, incl. iPadOS 13+ which reports "MacIntel" + touch. */
export function isIosDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return platform === "MacIntel" && maxTouchPoints > 1;
}
