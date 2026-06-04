import { useCallback, useEffect, useRef } from "react";

// useDraftAutosave debounces saves of a draft body and retries with
// exponential backoff on failure. It calls `save(value)` at most once per
// in-flight request; whenever the value changes during the delay, the
// pending timer is restarted. When the component unmounts (or `flush` is
// invoked, e.g. on send) a final save runs synchronously if the latest
// value has not yet been persisted.
//
// Caller is responsible for tearing down the draft (e.g. after
// send/delete) by calling cancel() so the trailing save doesn't resurrect
// a stale value.
export interface DraftAutosaveOptions {
  // Minimum delay before the first save attempt after the latest change,
  // in ms. Defaults to 600ms.
  baseDelayMs?: number;
  // Maximum backoff between retries, in ms. Defaults to 10_000ms.
  maxDelayMs?: number;
}

export interface DraftAutosaveControls {
  // Record a new value. Schedules a save unless one is already in flight
  // with the same value (in which case nothing happens).
  schedule(value: string): void;
  // Cancel any pending save without persisting. Used after send/delete.
  cancel(): void;
  // Force any pending save to run now (fire-and-forget). Idempotent.
  flush(): void;
}

export function useDraftAutosave(
  save: (value: string) => Promise<void>,
  options: DraftAutosaveOptions = {},
): DraftAutosaveControls {
  const { baseDelayMs = 600, maxDelayMs = 10_000 } = options;
  const saveRef = useRef(save);
  saveRef.current = save;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  // pendingValue is set whenever schedule() is called and cleared once that
  // exact value has been persisted. A trailing save runs when an in-flight
  // save finishes if pendingValue diverged in the meantime.
  const pendingValueRef = useRef<string | null>(null);
  const lastSavedRef = useRef<string | null>(null);
  const failureCountRef = useRef(0);

  const computeDelay = useCallback(() => {
    if (failureCountRef.current === 0) return baseDelayMs;
    // Exponential backoff: base * 2^failures, capped.
    const delay = baseDelayMs * Math.pow(2, failureCountRef.current);
    return Math.min(delay, maxDelayMs);
  }, [baseDelayMs, maxDelayMs]);

  const run = useCallback(async () => {
    if (inFlightRef.current) return;
    const value = pendingValueRef.current;
    if (value === null) return;
    if (value === lastSavedRef.current) {
      pendingValueRef.current = null;
      return;
    }
    inFlightRef.current = true;
    try {
      await saveRef.current(value);
      lastSavedRef.current = value;
      failureCountRef.current = 0;
      // If the value changed during the in-flight save, leave
      // pendingValueRef alone; otherwise clear it.
      if (pendingValueRef.current === value) {
        pendingValueRef.current = null;
      }
    } catch (err) {
      // Keep pendingValueRef so we retry; bump backoff.
      failureCountRef.current += 1;
      // Log but don't surface — autosave is best-effort.
      console.warn("Draft autosave failed; will retry", err);
    } finally {
      inFlightRef.current = false;
      // If more changes arrived (or the save failed), re-schedule.
      if (pendingValueRef.current !== null) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(run, computeDelay());
      }
    }
  }, [computeDelay]);

  const schedule = useCallback(
    (value: string) => {
      pendingValueRef.current = value;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(run, computeDelay());
    },
    [run, computeDelay],
  );

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingValueRef.current = null;
  }, []);

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void run();
  }, [run]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // Trailing save on unmount: fire-and-forget. The browser may not
      // deliver it, but for navigation within the SPA it works fine.
      void run();
    };
  }, [run]);

  return { schedule, cancel, flush };
}
