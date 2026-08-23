import * as React from "react";

/**
 * Custom SVG glyphs for key controls. Utility chrome uses lucide-react;
 * anything that reads as an instrument control is drawn by hand here so
 * stroke weights and geometry stay consistent with the design language.
 */

interface GlyphProps {
  size?: number;
  className?: string;
}

function base(size: number | undefined, className: string | undefined) {
  return {
    width: size ?? 16,
    height: size ?? 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
}

/** Incandescent filament mark — two posts with a glowing coil between. */
export function FilamentMark({ size, className }: GlyphProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4.5 8v8M19.5 8v8" />
      <path d="M4.5 12c3.2-5.6 4.8 5.6 7.5 0s4.3-5.6 7.5 0" />
    </svg>
  );
}

/** Classic power symbol — ring with a gap at twelve o'clock. */
export function PowerGlyph({ size, className }: GlyphProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 3.5v7.5" />
      <path d="M7.2 6.6a7 7 0 1 0 9.6 0" />
    </svg>
  );
}

const SUN_RAYS = Array.from({ length: 8 }, (_, i) => {
  const angle = (i * Math.PI) / 4;
  const inner = 7;
  const outer = 10;
  // Round to 3 decimals so server and client emit identical attribute
  // strings (libm ulp differences would otherwise hydrate-mismatch).
  const r3 = (n: number) => Number(n.toFixed(3));
  return {
    x1: r3(12 + inner * Math.cos(angle)),
    y1: r3(12 + inner * Math.sin(angle)),
    x2: r3(12 + outer * Math.cos(angle)),
    y2: r3(12 + outer * Math.sin(angle)),
  };
});

/** Hand-drawn sun for the theme toggle morph. */
export function SunGlyph({ size, className }: GlyphProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx={12} cy={12} r={4} />
      {SUN_RAYS.map((r, i) => (
        <line key={i} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} />
      ))}
    </svg>
  );
}

/** Crescent moon for the theme toggle morph. */
export function MoonGlyph({ size, className }: GlyphProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M20.4 13.2A8.4 8.4 0 1 1 10.8 3.6a6.6 6.6 0 0 0 9.6 9.6z" />
    </svg>
  );
}
