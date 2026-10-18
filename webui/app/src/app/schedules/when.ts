/**
 * The rule dialog's WHEN control, as pure functions.
 *
 * The stored spelling is the server's canonical string: `06:30`, `sunset`,
 * `sunset-1h15m`. The dialog edits it as `{kind, offsetMinutes}` and writes it
 * back. Two rules keep a stored value safe:
 *
 *  - parse then format returns the same string. A stored `sunset-1h10m` is
 *    never snapped to the 15-minute grid just because the dialog was opened.
 *  - the stepper steps FROM the stored value (70 -> 85 or 55), it does not
 *    round first.
 *
 * Offsets are signed minutes: negative = before the event, positive = after.
 */

export type WhenKind = "clock" | "sunrise" | "sunset";
export type SunKind = Exclude<WhenKind, "clock">;

export type When =
  | { kind: "clock"; time: string }
  | { kind: SunKind; offsetMinutes: number };

export const STEP_MINUTES = 15;
export const MAX_OFFSET_MINUTES = 360;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const SUN = /^(sunrise|sunset)(?:([+-])(?:(\d+)h)?(?:(\d+)m)?)?$/;

export function isSun(kind: WhenKind): kind is SunKind {
  return kind !== "clock";
}

export function parseWhen(canonical: string): When | null {
  const text = canonical.trim();
  if (CLOCK.test(text)) return { kind: "clock", time: text };
  const m = SUN.exec(text);
  if (!m) return null;
  const [, kind, sign, h, m2] = m;
  if (sign === undefined) return { kind: kind as SunKind, offsetMinutes: 0 };
  if (h === undefined && m2 === undefined) return null;
  const total = Number(h ?? 0) * 60 + Number(m2 ?? 0);
  return { kind: kind as SunKind, offsetMinutes: sign === "-" ? -total : total };
}

/** `offsetMinutes` as the canonical suffix: `-1h10m`, `+45m`, `` for zero. */
function offsetSuffix(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "";
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${offsetMinutes < 0 ? "-" : "+"}${h ? `${h}h` : ""}${m ? `${m}m` : ""}`;
}

export function formatWhen(when: When): string {
  return when.kind === "clock" ? when.time : `${when.kind}${offsetSuffix(when.offsetMinutes)}`;
}

/** One stepper press. `direction` -1 = earlier, +1 = later. Clamped to 0..6 h either side. */
export function stepOffset(offsetMinutes: number, direction: -1 | 1): number {
  const next = offsetMinutes + direction * STEP_MINUTES;
  return Math.max(-MAX_OFFSET_MINUTES, Math.min(MAX_OFFSET_MINUTES, next));
}

function spaced(abs: number): string {
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return [h ? `${h} h` : "", m ? `${m} m` : ""].filter(Boolean).join(" ");
}

/** "1 h 10 m before sunset" | "at sunset". */
export function offsetLabel(kind: SunKind, offsetMinutes: number): string {
  if (offsetMinutes === 0) return `at ${kind}`;
  return `${spaced(Math.abs(offsetMinutes))} ${offsetMinutes < 0 ? "before" : "after"} ${kind}`;
}

/** Compact, for the timeline: "sunset −1h10m", "sunrise +45m", "sunset". */
export function shortWhen(kind: SunKind, offsetMinutes: number): string {
  const suffix = offsetSuffix(offsetMinutes).replace("-", "−");
  return suffix ? `${kind} ${suffix}` : kind;
}
