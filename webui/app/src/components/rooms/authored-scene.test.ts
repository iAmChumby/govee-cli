import { describe, expect, it } from "vitest";

import type { CapturedDevice } from "@/lib/api";
import {
  defaultDraft,
  draftFromScene,
  rangeFor,
  referenceWarning,
  saveBlocker,
  toInput,
} from "./authored-scene";

function captured(over: Partial<CapturedDevice>): CapturedDevice {
  return {
    device_id: "d1",
    model: "H6056",
    power: true,
    brightness: 70,
    color: null,
    color_temp_k: null,
    mode: "basic",
    label: null,
    payload: null,
    ...over,
  };
}

describe("authored scene defaults", () => {
  it("starts white at max(2700, temp_min), power on, brightness 50", () => {
    expect(defaultDraft({ id: "a", model: "H6056" })).toMatchObject({
      power: true, brightness: 50, mode: "white", kelvin: 2700,
    });
    expect(defaultDraft({ id: "a", model: "H6022" }).kelvin).toBe(2700);
  });

  it("bounds white by the model range and hides DIY for an unlisted model", () => {
    expect(rangeFor("H6056")).toMatchObject({ min: 2000, max: 9000, diy: true });
    expect(rangeFor("H6022")).toMatchObject({ min: 2700, max: 6500, diy: true });
    expect(rangeFor("H9999")).toMatchObject({ known: false, diy: false });
  });
});

describe("edit prefill", () => {
  it("maps off, white, colour and diy", () => {
    expect(draftFromScene(captured({ mode: "off", power: false })).power).toBe(false);
    expect(draftFromScene(captured({ color_temp_k: 9500 }))).toMatchObject({ mode: "white", kelvin: 9000 });
    expect(draftFromScene(captured({ color: [255, 0, 16] }))).toMatchObject({ mode: "colour", color: "#FF0010" });
    expect(
      draftFromScene(captured({ mode: "diy", label: "Sunset", payload: { diy_value: 7 } })),
    ).toMatchObject({ mode: "diy", diyValue: 7, diyName: "Sunset" });
  });
});

describe("save blocker and payload", () => {
  const label = (id: string) => id;
  it("needs at least one device, with the stated reason", () => {
    expect(saveBlocker({ isNew: true, name: "x", drafts: [], labelOf: label })).toBe(
      "include at least one device",
    );
  });
  it("blocks an unchosen colour or DIY scene", () => {
    const c = { ...defaultDraft({ id: "a", model: "H6056" }), mode: "colour" as const };
    expect(saveBlocker({ isNew: false, name: "", drafts: [c], labelOf: label })).toMatch(/colour/);
    const d = { ...c, mode: "diy" as const };
    expect(saveBlocker({ isNew: false, name: "", drafts: [d], labelOf: label })).toMatch(/DIY/);
  });
  it("sends mode null for a powered-off device", () => {
    const d = { ...defaultDraft({ id: "a", model: "H6056" }), power: false };
    expect(toInput(d)).toMatchObject({ power: false, mode: null });
  });
});

describe("delete warning", () => {
  it("names the referencing rules", () => {
    expect(referenceWarning(["Evening", "Weekend"])).toBe(
      "2 rules use this scene: Evening, Weekend — they will stop firing",
    );
    expect(referenceWarning([])).toBeNull();
  });
});
