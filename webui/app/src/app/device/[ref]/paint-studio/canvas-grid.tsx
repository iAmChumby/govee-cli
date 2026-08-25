"use client";

/**
 * The drawing surface: wrap-aware grid rendering + all pointer/gesture
 * handling (§5.7). Purely presentational + gesture — no color/tool logic
 * of its own; every gesture resolves to one of five callbacks the parent
 * wires to whatever the active tool means.
 *
 * Gesture state machine (§5.7, one `PointerEvent` code path, matching the
 * existing pattern in `ui/dial.tsx`):
 *
 *   pointerdown  → arm a 350ms long-press timer; nothing paints yet.
 *   pointermove  → first move past ~6px cancels the long-press timer and,
 *                  if it didn't already fire, starts a drag (`onDragStart`
 *                  then `onDragMove` per newly-entered cell, deduped so a
 *                  cell is never re-emitted while the pointer sits on it).
 *   timer fires  → `onLongPress` (the cell hasn't been painted — a hold
 *                  samples, it never dabs).
 *   pointerup    → long-press already fired: nothing further. A drag was
 *                  underway: `onDragEnd`. Neither: `onTap` — this is the
 *                  single-cell dab path, so a tap paints on *release*, not
 *                  on touchdown, which is what keeps it distinguishable
 *                  from a long-press in the first place.
 *
 * `touch-action: none` is scoped to this grid element only (via the
 * `touch-none` utility below), so two-finger page scroll still works
 * everywhere else on the page.
 */

import * as React from "react";

import { cn } from "@/lib/cn";
import type { Geometry } from "./device-geometry";

export interface CellHit {
  row: number;
  col: number;
  index: number;
}

export interface CanvasGridProps {
  geometry: Geometry;
  /** hex color per LED index, length `rows * cols`, raster order. */
  colors: readonly string[];
  onDragStart?: (hit: CellHit) => void;
  onDragMove?: (hit: CellHit) => void;
  onDragEnd?: () => void;
  onTap?: (hit: CellHit) => void;
  onLongPress?: (hit: CellHit) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
}

const MOVE_PX = 6;
const LONG_PRESS_MS = 350;

interface GestureState {
  pointerId: number;
  startX: number;
  startY: number;
  downHit: CellHit;
  lastIndex: number;
  moved: boolean;
  dragStarted: boolean;
  longPressFired: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export function CanvasGrid({
  geometry,
  colors,
  onDragStart,
  onDragMove,
  onDragEnd,
  onTap,
  onLongPress,
  disabled = false,
  ariaLabel = "Paint canvas",
  className,
  style,
}: CanvasGridProps) {
  const gridRef = React.useRef<HTMLDivElement>(null);
  const gestureRef = React.useRef<GestureState | null>(null);

  const hitFromPoint = React.useCallback(
    (clientX: number, clientY: number): CellHit | null => {
      const el = gridRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const x = Math.min(rect.width - 0.01, Math.max(0, clientX - rect.left));
      const y = Math.min(rect.height - 0.01, Math.max(0, clientY - rect.top));
      const col = Math.min(geometry.cols - 1, Math.floor((x / rect.width) * geometry.cols));
      const row = Math.min(geometry.rows - 1, Math.floor((y / rect.height) * geometry.rows));
      return { row, col, index: row * geometry.cols + col };
    },
    [geometry],
  );

  const clearTimer = (g: GestureState) => {
    if (g.timer) {
      clearTimeout(g.timer);
      g.timer = null;
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const hit = hitFromPoint(e.clientX, e.clientY);
    if (!hit) return;
    try {
      // Capture keeps a drag tracked once the finger/cursor leaves the grid
      // bounds — a nice-to-have, not a requirement for the gesture itself
      // to register. Some environments can reject this (observed: a
      // NotFoundError for a pointer id the browser doesn't consider
      // active), and an uncaught throw here would abort the handler before
      // the gesture state below is ever armed, silently dropping the whole
      // stroke/tap with no visible feedback — worth guarding on the studio's
      // primary drawing surface even though it can't happen with a real,
      // organically-generated pointerdown.
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // continue — the gesture still works without capture
    }

    const g: GestureState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      downHit: hit,
      lastIndex: hit.index,
      moved: false,
      dragStarted: false,
      longPressFired: false,
      timer: null,
    };
    gestureRef.current = g;
    g.timer = setTimeout(() => {
      const cur = gestureRef.current;
      if (!cur || cur !== g || cur.moved) return;
      cur.longPressFired = true;
      onLongPress?.(hit);
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;

    if (!g.moved) {
      const dist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
      if (dist > MOVE_PX) {
        g.moved = true;
        clearTimer(g);
        if (!g.longPressFired) {
          g.dragStarted = true;
          onDragStart?.(g.downHit);
        }
      }
    }

    if (!g.dragStarted || g.longPressFired) return;
    const hit = hitFromPoint(e.clientX, e.clientY);
    if (!hit || hit.index === g.lastIndex) return;
    g.lastIndex = hit.index;
    onDragMove?.(hit);
  };

  const endGesture = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    clearTimer(g);
    gestureRef.current = null;
    if (g.longPressFired) return;
    if (g.dragStarted) {
      onDragEnd?.();
    } else {
      onTap?.(g.downHit);
    }
  };

  React.useEffect(() => {
    return () => {
      const g = gestureRef.current;
      if (g) clearTimer(g);
    };
  }, []);

  return (
    <div
      ref={gridRef}
      role="group"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      className={cn(
        "grid touch-none select-none overflow-hidden rounded-card border border-hairline-strong",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
      style={{
        ...style,
        gridTemplateColumns: `repeat(${geometry.cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${geometry.rows}, minmax(0, 1fr))`,
      }}
    >
      {colors.map((hex, i) => (
        <div
          key={i}
          aria-hidden
          className="border-[0.5px] border-hairline"
          style={{ backgroundColor: hex }}
        />
      ))}
    </div>
  );
}
