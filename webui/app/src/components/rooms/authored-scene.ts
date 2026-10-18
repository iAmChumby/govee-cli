import type { AuthoredDeviceInput, CapturedDevice, DeviceSummary } from "@/lib/api";

/* ==================================================================
   Pure logic behind the authored room-scene editor (issue #2, G7).
   No React here, so every rule is testable in Node.
   ================================================================== */

export type AuthoredMode = "colour" | "white" | "diy";

/**
 * Colour-temperature range and DIY support per model.
 *
 * MIRROR of `govee_cli/transport.py` MODEL_SPECS (temp_min, temp_max,
 * cloud_diy), same pattern as MODEL_MATRIX in lamp3d/models/types.ts:
 * `GET /devices` sends no `capabilities`, so a row cannot learn its model's
 * range from the wire. The server re-checks at save time; this table only
 * keeps the slider honest. A model absent from the table has an UNKNOWN
 * range (see `rangeFor`), never an invented one.
 */
export const MODEL_TEMP: Readonly<Record<string, { min: number; max: number; diy: boolean }>> = {
  H6022: { min: 2700, max: 6500, diy: true },
  H6056: { min: 2000, max: 9000, diy: true },
  H6008: { min: 2700, max: 6500, diy: true },
  H6004: { min: 2700, max: 6500, diy: true },
};

/** The narrowest range every known model accepts; used (and labelled) for a
 *  model the table does not list. */
const UNKNOWN_MODEL_RANGE = { min: 2700, max: 6500 } as const;

export interface TempRange {
  min: number;
  max: number;
  /** false when the model is not in MODEL_TEMP and the range is a fallback. */
  known: boolean;
  /** true only for a model the table lists as cloud_diy. Unknown model: false. */
  diy: boolean;
}

export function rangeFor(model: string | null | undefined): TempRange {
  const known = model ? MODEL_TEMP[model] : undefined;
  if (known) return { min: known.min, max: known.max, known: true, diy: known.diy };
  return { ...UNKNOWN_MODEL_RANGE, known: false, diy: false };
}

export interface Draft {
  /** DeviceSummary.id: the cloud id room scenes store as `device_id`. */
  id: string;
  model: string | null;
  power: boolean;
  brightness: number;
  mode: AuthoredMode;
  /** "#RRGGBB" or null when no colour has been chosen yet. */
  color: string | null;
  kelvin: number;
  diyValue: number | null;
  diyName: string | null;
}

/** Neutral defaults on include. NEVER read from reported device state. */
export function defaultDraft(device: Pick<DeviceSummary, "id" | "model">): Draft {
  const range = rangeFor(device.model);
  return {
    id: device.id,
    model: device.model,
    power: true,
    brightness: 50,
    mode: "white",
    color: null,
    kelvin: Math.max(2700, range.min),
    diyValue: null,
    diyName: null,
  };
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function rgbToHex(rgb: [number, number, number]): string {
  return (
    "#" +
    rgb
      .map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

/**
 * Edit mode: rebuild a draft from a stored scene device.
 * off -> power off; basic + color_temp_k -> White; basic + color -> Colour;
 * diy -> DIY (payload.diy_value + label). Anything else (a mode an authored
 * scene never writes) falls back to the neutral defaults rather than a guess.
 */
export function draftFromScene(device: CapturedDevice): Draft {
  const base = defaultDraft({ id: device.device_id, model: device.model });
  const range = rangeFor(device.model);
  const brightness = clamp(Math.round(device.brightness ?? 50), 1, 100);
  if (device.mode === "off" || !device.power) {
    return { ...base, power: false, brightness };
  }
  if (device.mode === "diy") {
    const raw = device.payload?.["diy_value"];
    return {
      ...base,
      brightness,
      mode: "diy",
      diyValue: typeof raw === "number" ? raw : null,
      diyName: device.label ?? null,
    };
  }
  if (device.mode === "basic") {
    if (device.color_temp_k != null) {
      return {
        ...base,
        brightness,
        mode: "white",
        kelvin: clamp(device.color_temp_k, range.min, range.max),
      };
    }
    if (device.color) {
      return { ...base, brightness, mode: "colour", color: rgbToHex(device.color) };
    }
  }
  return { ...base, brightness };
}

/** First reason a draft cannot be saved, or null. */
export function draftProblem(d: Draft, label: string): string | null {
  if (!d.power) return null;
  if (d.mode === "colour" && !d.color) return `pick a colour for ${label}`;
  if (d.mode === "diy" && (d.diyValue === null || !d.diyName)) {
    return `choose a DIY scene for ${label}`;
  }
  return null;
}

export function toInput(d: Draft): AuthoredDeviceInput {
  if (!d.power) {
    return { device_id: d.id, power: false, brightness: d.brightness, mode: null };
  }
  if (d.mode === "colour") {
    return { device_id: d.id, power: true, brightness: d.brightness, mode: "colour", color: d.color };
  }
  if (d.mode === "white") {
    return {
      device_id: d.id,
      power: true,
      brightness: d.brightness,
      mode: "white",
      color_temp_k: d.kelvin,
    };
  }
  return {
    device_id: d.id,
    power: true,
    brightness: d.brightness,
    mode: "diy",
    diy_value: d.diyValue,
    diy_name: d.diyName,
  };
}

/** Why Save is disabled, or null when it can run. */
export function saveBlocker(args: {
  isNew: boolean;
  name: string;
  drafts: Draft[];
  labelOf: (id: string) => string;
}): string | null {
  if (args.drafts.length === 0) return "include at least one device";
  if (args.isNew && !args.name.trim()) return "name the scene";
  for (const d of args.drafts) {
    const problem = draftProblem(d, args.labelOf(d.id));
    if (problem) return problem;
  }
  return null;
}

/** "2 rules use this scene: Evening, Weekend — they will stop firing" */
export function referenceWarning(rules: string[]): string | null {
  if (rules.length === 0) return null;
  const noun = rules.length === 1 ? "rule uses" : "rules use";
  const verb = rules.length === 1 ? "it will stop firing" : "they will stop firing";
  return `${rules.length} ${noun} this scene: ${rules.join(", ")} — ${verb}`;
}
