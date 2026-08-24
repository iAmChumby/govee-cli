"use client";

import * as React from "react";

/**
 * Trailing-edge throttle for continuous inputs that lack a commit event
 * (the Dial emits on every pointer/keyboard change; the native color
 * picker fires per-tick while its dialog is open).
 *
 * Every call reschedules a timer; `commit` fires `delay` ms after the
 * last call, so a drag emits at most one mutation per quiet window and
 * the final value always lands. The pending value is dropped on unmount
 * (a 150ms tail is not worth firing mutations from cleanup).
 */
export function useTrailingCommit<T>(commit: (value: T) => void, delay = 150): (value: T) => void {
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = React.useRef<T | null>(null);
  const commitRef = React.useRef(commit);
  commitRef.current = commit;

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return React.useCallback(
    (value: T) => {
      pending.current = value;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const v = pending.current;
        pending.current = null;
        if (v !== null) commitRef.current(v);
      }, delay);
    },
    [delay],
  );
}
