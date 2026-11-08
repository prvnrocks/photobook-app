"use client";
// Returns `value`, but changes at most once per `intervalMs` (the latest value is
// shown at the end of each interval). For aria-live regions that would otherwise
// announce every tick. `intervalMs` 0 = follow immediately.
import { useEffect, useRef, useState } from "react";

export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value);
  const lastRef = useRef(0);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const wait = Math.max(0, lastRef.current + intervalMs - Date.now());
    const t = setTimeout(() => {
      lastRef.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(t);
  }, [value, shown, intervalMs]);
  return shown;
}
