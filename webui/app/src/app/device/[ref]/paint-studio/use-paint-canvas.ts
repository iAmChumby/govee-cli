"use client";

/**
 * Canvas state, undo/redo, and active tool/color/symmetry for the paint
 * studio. Owns exactly one `Uint8ClampedArray` (§5.1) plus the diff-based
 * undo stack (§5.7: "the whole stroke groups into one undo entry"),
 * capped at ~100 entries.
 *
 * The canvas and its history live in a ref, not `useState` — every
 * `pointermove` during a drag calls `paintCell`, and cloning a ~400-byte
 * array per touched cell is already cheap at this scale (max 132 LEDs);
 * routing that through nested `setState` updaters (undo needs to read
 * canvas + push redo + pop undo, all mutually dependent) would either
 * chain three synchronous setters per call or read stale closures. A
 * ref plus one `forceRender()` per mutation keeps every mutation a single
 * synchronous, easy-to-reason-about step while still re-rendering
 * consumers exactly when the visible canvas actually changes.
 */

import * as React from "react";

import type { CellDiff, Geometry, Rgb } from "./device-geometry";
import { ledIndex, totalLeds } from "./device-geometry";
import type { SymmetryAxis } from "./tools/symmetry";
import { symmetryDiffs } from "./tools/symmetry";

export type ToolId = "brush" | "fill" | "gradient" | "eyedropper";

const MAX_UNDO = 100;

function hexToRgb(hex: string): Rgb {
  const v = hex.replace("#", "");
  return [parseInt(v.slice(0, 2), 16) || 0, parseInt(v.slice(2, 4), 16) || 0, parseInt(v.slice(4, 6), 16) || 0];
}

function applyDiffsTo(canvas: Uint8ClampedArray, diffs: readonly CellDiff[]): Uint8ClampedArray {
  const next = canvas.slice() as Uint8ClampedArray;
  for (const d of diffs) {
    const o = d.index * 3;
    next[o] = d.to[0];
    next[o + 1] = d.to[1];
    next[o + 2] = d.to[2];
  }
  return next;
}

function invertDiffsTo(canvas: Uint8ClampedArray, diffs: readonly CellDiff[]): Uint8ClampedArray {
  const next = canvas.slice() as Uint8ClampedArray;
  for (const d of diffs) {
    const o = d.index * 3;
    next[o] = d.from[0];
    next[o + 1] = d.from[1];
    next[o + 2] = d.from[2];
  }
  return next;
}

export interface PaintCanvasState {
  canvas: Uint8ClampedArray;
  geometry: Geometry;

  tool: ToolId;
  setTool: (t: ToolId) => void;
  primaryColor: string;
  setPrimaryColor: (hex: string) => void;
  secondaryColor: string;
  setSecondaryColor: (hex: string) => void;
  symmetry: SymmetryAxis;
  setSymmetry: (a: SymmetryAxis) => void;

  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;

  /** Brush stroke lifecycle — one call each per gesture (§5.7). */
  beginStroke: () => void;
  paintCell: (row: number, col: number) => void;
  endStroke: () => void;

  /** One-shot ops (fill/gradient) commit their whole diff set atomically. */
  applyDiffs: (diffs: CellDiff[]) => void;

  colorAt: (row: number, col: number) => Rgb;
  loadCanvas: (data: Uint8ClampedArray) => void;
  clear: () => void;
}

export function usePaintCanvas(geometry: Geometry): PaintCanvasState {
  const size = totalLeds(geometry) * 3;
  const canvasRef = React.useRef<Uint8ClampedArray>(new Uint8ClampedArray(size));
  const undoRef = React.useRef<CellDiff[][]>([]);
  const redoRef = React.useRef<CellDiff[][]>([]);
  const strokeRef = React.useRef<Map<number, CellDiff> | null>(null);
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);

  // Geometry changes (switching devices) reset the canvas — a stale H6022
  // buffer must never be reinterpreted as an H6056's shape.
  const geometryKey = `${geometry.rows}x${geometry.cols}x${geometry.wrapCol}`;
  const lastGeometryKey = React.useRef(geometryKey);
  if (lastGeometryKey.current !== geometryKey) {
    lastGeometryKey.current = geometryKey;
    canvasRef.current = new Uint8ClampedArray(size);
    undoRef.current = [];
    redoRef.current = [];
    strokeRef.current = null;
  }

  const [tool, setTool] = React.useState<ToolId>("brush");
  const [primaryColor, setPrimaryColor] = React.useState("#8A5CFF");
  const [secondaryColor, setSecondaryColor] = React.useState("#3D7BFF");
  const [symmetry, setSymmetry] = React.useState<SymmetryAxis>("none");

  const commit = React.useCallback((diffs: CellDiff[]) => {
    if (diffs.length === 0) return;
    canvasRef.current = applyDiffsTo(canvasRef.current, diffs);
    undoRef.current = [...undoRef.current.slice(-(MAX_UNDO - 1)), diffs];
    redoRef.current = [];
    forceRender();
  }, []);

  const beginStroke = React.useCallback(() => {
    strokeRef.current = new Map();
  }, []);

  const paintCell = React.useCallback(
    (row: number, col: number) => {
      const map = strokeRef.current;
      if (!map) return;
      const idx = ledIndex(geometry, row, col);
      const rgb = hexToRgb(primaryColor);
      const canvas = canvasRef.current;

      const touch = (index: number, to: Rgb) => {
        const o = index * 3;
        if (canvas[o] === to[0] && canvas[o + 1] === to[1] && canvas[o + 2] === to[2]) return null;
        const existing = map.get(index);
        if (existing) {
          existing.to = to;
          return { index, from: existing.from, to } as CellDiff;
        }
        const from: Rgb = [canvas[o], canvas[o + 1], canvas[o + 2]];
        const diff: CellDiff = { index, from, to };
        map.set(index, diff);
        return diff;
      };

      const primary = touch(idx, rgb);
      const applied: CellDiff[] = [];
      if (primary) applied.push(primary);

      if (symmetry !== "none") {
        for (const mirrored of symmetryDiffs(canvas, geometry, primary ? [primary] : [{ index: idx, from: rgb, to: rgb }], symmetry)) {
          const m = touch(mirrored.index, mirrored.to);
          if (m) applied.push(m);
        }
      }

      if (applied.length === 0) return;
      canvasRef.current = applyDiffsTo(canvas, applied);
      forceRender();
    },
    [geometry, primaryColor, symmetry],
  );

  const endStroke = React.useCallback(() => {
    const map = strokeRef.current;
    strokeRef.current = null;
    if (!map || map.size === 0) return;
    undoRef.current = [...undoRef.current.slice(-(MAX_UNDO - 1)), Array.from(map.values())];
    redoRef.current = [];
    forceRender();
  }, []);

  const applyDiffs = React.useCallback((diffs: CellDiff[]) => commit(diffs), [commit]);

  const undo = React.useCallback(() => {
    const stack = undoRef.current;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1];
    undoRef.current = stack.slice(0, -1);
    redoRef.current = [...redoRef.current, entry];
    canvasRef.current = invertDiffsTo(canvasRef.current, entry);
    forceRender();
  }, []);

  const redo = React.useCallback(() => {
    const stack = redoRef.current;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1];
    redoRef.current = stack.slice(0, -1);
    undoRef.current = [...undoRef.current, entry];
    canvasRef.current = applyDiffsTo(canvasRef.current, entry);
    forceRender();
  }, []);

  const colorAt = React.useCallback(
    (row: number, col: number): Rgb => {
      const o = ledIndex(geometry, row, col) * 3;
      const c = canvasRef.current;
      return [c[o], c[o + 1], c[o + 2]];
    },
    [geometry],
  );

  const loadCanvas = React.useCallback(
    (data: Uint8ClampedArray) => {
      canvasRef.current =
        data.length === size ? (data.slice() as Uint8ClampedArray) : new Uint8ClampedArray(size);
      undoRef.current = [];
      redoRef.current = [];
      strokeRef.current = null;
      forceRender();
    },
    [size],
  );

  const clear = React.useCallback(() => {
    const diffs: CellDiff[] = [];
    const canvas = canvasRef.current;
    for (let i = 0; i < canvas.length / 3; i += 1) {
      const o = i * 3;
      if (canvas[o] === 0 && canvas[o + 1] === 0 && canvas[o + 2] === 0) continue;
      diffs.push({ index: i, from: [canvas[o], canvas[o + 1], canvas[o + 2]], to: [0, 0, 0] });
    }
    commit(diffs);
  }, [commit]);

  return {
    canvas: canvasRef.current,
    geometry,
    tool,
    setTool,
    primaryColor,
    setPrimaryColor,
    secondaryColor,
    setSecondaryColor,
    symmetry,
    setSymmetry,
    canUndo: undoRef.current.length > 0,
    canRedo: redoRef.current.length > 0,
    undo,
    redo,
    beginStroke,
    paintCell,
    endStroke,
    applyDiffs,
    colorAt,
    loadCanvas,
    clear,
  };
}
