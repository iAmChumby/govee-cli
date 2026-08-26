import { describe, expect, test } from "vitest";
import {
  clampScissor,
  createViewRegistry,
  cssSize,
  deviceSize,
  intersectRect,
  isOnScreen,
  scissorFromRect,
  type ScreenRect,
} from "./views";

/** Builds a stub element exposing only `getBoundingClientRect`, the one DOM
 *  method `views.ts` ever calls — proof the registry never reaches for
 *  anything else from a real `HTMLElement`. */
function stubElement(rect: ScreenRect): HTMLElement {
  return { getBoundingClientRect: () => rect } as unknown as HTMLElement;
}

/** A stub element whose reported rect can change between `readBoxes()`
 *  calls, for tests that simulate scrolling. */
function movableStubElement(rect: ScreenRect): { element: HTMLElement; move: (r: ScreenRect) => void } {
  let current = rect;
  const element = { getBoundingClientRect: () => current } as unknown as HTMLElement;
  return { element, move: (r: ScreenRect) => { current = r; } };
}

describe("scissorFromRect", () => {
  test("flips y: a box at the top of the canvas lands at high device-pixel y (dpr 1)", () => {
    const canvas = cssSize(400, 300);
    const box: ScreenRect = { left: 0, top: 0, width: 120, height: 50 };
    expect(scissorFromRect(box, canvas, 1)).toEqual({ x: 0, y: 250, width: 120, height: 50 });
  });

  test("agrees with the dpr-1 case after scaling, at dpr 2", () => {
    const canvas = cssSize(400, 300);
    const box: ScreenRect = { left: 0, top: 0, width: 120, height: 50 };
    const dpr1 = scissorFromRect(box, canvas, 1);
    const dpr2 = scissorFromRect(box, canvas, 2);
    expect(dpr2).toEqual({
      x: dpr1.x * 2,
      y: dpr1.y * 2,
      width: dpr1.width * 2,
      height: dpr1.height * 2,
    });
    expect(dpr2).toEqual({ x: 0, y: 500, width: 240, height: 100 });
  });

  test("a box offset from the top-left still flips correctly", () => {
    const canvas = cssSize(400, 300);
    const box: ScreenRect = { left: 40, top: 200, width: 100, height: 60 };
    // device px: x=40, bottom edge at (200+60)=260 from top -> y = 300-260 = 40
    expect(scissorFromRect(box, canvas, 1)).toEqual({ x: 40, y: 40, width: 100, height: 60 });
  });

  test("a box exactly filling the canvas maps to the full canvas scissor", () => {
    const canvas = cssSize(400, 300);
    const box: ScreenRect = { left: 0, top: 0, width: 400, height: 300 };
    expect(scissorFromRect(box, canvas, 1)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(scissorFromRect(box, canvas, 2)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });
});

describe("isOnScreen", () => {
  const canvas = cssSize(400, 300);

  test("a box fully inside the canvas is on screen", () => {
    expect(isOnScreen({ left: 10, top: 10, width: 50, height: 50 }, canvas)).toBe(true);
  });

  test("a box overlapping just one pixel across an edge is on screen", () => {
    expect(isOnScreen({ left: 399, top: 10, width: 50, height: 50 }, canvas)).toBe(true);
  });

  test("a box merely touching the right edge from outside is off screen", () => {
    // left edge of the box is exactly the canvas's right edge: zero overlap.
    expect(isOnScreen({ left: 400, top: 10, width: 50, height: 50 }, canvas)).toBe(false);
  });

  test("a box one pixel past the right edge is off screen", () => {
    expect(isOnScreen({ left: 401, top: 10, width: 50, height: 50 }, canvas)).toBe(false);
  });

  test("a box whose right edge exactly meets the canvas's right edge from inside is on screen", () => {
    expect(isOnScreen({ left: 350, top: 10, width: 50, height: 50 }, canvas)).toBe(true);
  });

  test("a box touching the bottom edge from outside (top === canvas.height) is off screen", () => {
    expect(isOnScreen({ left: 10, top: 300, width: 50, height: 50 }, canvas)).toBe(false);
  });

  test("a zero-width box is off screen even if positioned inside the canvas", () => {
    expect(isOnScreen({ left: 10, top: 10, width: 0, height: 50 }, canvas)).toBe(false);
  });

  test("a zero-height box is off screen even if positioned inside the canvas", () => {
    expect(isOnScreen({ left: 10, top: 10, width: 50, height: 0 }, canvas)).toBe(false);
  });

  test("a box entirely to the left of the canvas is off screen", () => {
    expect(isOnScreen({ left: -100, top: 10, width: 50, height: 50 }, canvas)).toBe(false);
  });
});

describe("clampScissor", () => {
  const canvas = deviceSize(400, 300);

  test("a rect fully inside the canvas is unchanged", () => {
    const r = { x: 10, y: 10, width: 50, height: 50 };
    expect(clampScissor(r, canvas)).toEqual(r);
  });

  test("trims a rect that hangs off the right and top edges", () => {
    const r = { x: 350, y: 250, width: 100, height: 100 };
    expect(clampScissor(r, canvas)).toEqual({ x: 350, y: 250, width: 50, height: 50 });
  });

  test("trims a rect with a negative origin (hangs off the left/bottom)", () => {
    const r = { x: -20, y: -30, width: 60, height: 80 };
    expect(clampScissor(r, canvas)).toEqual({ x: 0, y: 0, width: 40, height: 50 });
  });

  test("returns null for a rect fully off the right edge", () => {
    const r = { x: 500, y: 10, width: 50, height: 50 };
    expect(clampScissor(r, canvas)).toBeNull();
  });

  test("returns null for a rect fully off the bottom (negative y beyond height)", () => {
    const r = { x: 10, y: -100, width: 50, height: 50 };
    expect(clampScissor(r, canvas)).toBeNull();
  });

  test("returns null for a rect that only touches an edge (zero remaining area)", () => {
    const r = { x: 400, y: 10, width: 50, height: 50 };
    expect(clampScissor(r, canvas)).toBeNull();
  });
});

describe("intersectRect", () => {
  test("overlapping rects intersect to the shared region", () => {
    const a: ScreenRect = { left: 0, top: 0, width: 100, height: 100 };
    const b: ScreenRect = { left: 50, top: 20, width: 100, height: 100 };
    expect(intersectRect(a, b)).toEqual({ left: 50, top: 20, width: 50, height: 80 });
  });

  test("is symmetric in its arguments", () => {
    const a: ScreenRect = { left: 0, top: 0, width: 100, height: 100 };
    const b: ScreenRect = { left: 50, top: 20, width: 100, height: 100 };
    expect(intersectRect(a, b)).toEqual(intersectRect(b, a));
  });

  test("one rect fully containing another intersects to the smaller one", () => {
    const outer: ScreenRect = { left: 0, top: 0, width: 200, height: 200 };
    const inner: ScreenRect = { left: 20, top: 20, width: 10, height: 10 };
    expect(intersectRect(outer, inner)).toEqual(inner);
  });

  test("disjoint rects have no intersection", () => {
    const a: ScreenRect = { left: 0, top: 0, width: 10, height: 10 };
    const b: ScreenRect = { left: 100, top: 100, width: 10, height: 10 };
    expect(intersectRect(a, b)).toBeNull();
  });

  test("rects that only touch at an edge have zero-area overlap, which is null", () => {
    const a: ScreenRect = { left: 0, top: 0, width: 10, height: 10 };
    const b: ScreenRect = { left: 10, top: 0, width: 10, height: 10 };
    expect(intersectRect(a, b)).toBeNull();
  });
});

describe("createViewRegistry", () => {
  const canvas = cssSize(400, 300);

  test("register + list round-trips a view with initial null/false bookkeeping", () => {
    const registry = createViewRegistry();
    const element = stubElement({ left: 0, top: 0, width: 100, height: 100 });
    registry.register({ id: "hero-1", element, tier: "hero" });
    const views = registry.list();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: "hero-1",
      tier: "hero",
      visible: false,
      box: null,
      lastVisibleAt: 0,
    });
  });

  test("unregister removes the view, and the disposer is idempotent", () => {
    const registry = createViewRegistry();
    const element = stubElement({ left: 0, top: 0, width: 100, height: 100 });
    const unregister = registry.register({ id: "plate-1", element, tier: "plate" });
    expect(registry.list()).toHaveLength(1);
    unregister();
    expect(registry.list()).toHaveLength(0);
    // Calling it again must not throw and must not touch anything else.
    expect(() => unregister()).not.toThrow();
    expect(registry.list()).toHaveLength(0);
  });

  test("unregister does not remove a different view re-registered under the same id", () => {
    const registry = createViewRegistry();
    const elementA = stubElement({ left: 0, top: 0, width: 10, height: 10 });
    const elementB = stubElement({ left: 0, top: 0, width: 20, height: 20 });
    const unregisterA = registry.register({ id: "dup", element: elementA, tier: "plate" });
    unregisterA();
    registry.register({ id: "dup", element: elementB, tier: "plate" });
    // The stale disposer from the first registration must not evict the
    // second view that now legitimately holds this id.
    unregisterA();
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].element).toBe(elementB);
  });

  test("readBoxes marks a view visible when its rect is inside the canvas", () => {
    const registry = createViewRegistry();
    const element = stubElement({ left: 10, top: 10, width: 50, height: 50 });
    registry.register({ id: "p1", element, tier: "plate" });
    registry.readBoxes(canvas, 1000);
    const [view] = registry.list();
    expect(view.visible).toBe(true);
    expect(view.box).toEqual({ left: 10, top: 10, width: 50, height: 50 });
    expect(view.lastVisibleAt).toBe(1000);
  });

  test("readBoxes marks a view invisible when its rect leaves the canvas", () => {
    const registry = createViewRegistry();
    const { element, move } = movableStubElement({ left: 10, top: 10, width: 50, height: 50 });
    registry.register({ id: "p1", element, tier: "plate" });
    registry.readBoxes(canvas, 1000);
    expect(registry.list()[0].visible).toBe(true);

    // Simulate the element scrolling off the right edge of the canvas.
    move({ left: 5000, top: 10, width: 50, height: 50 });
    registry.readBoxes(canvas, 2000);
    const [view] = registry.list();
    expect(view.visible).toBe(false);
    expect(view.box).toEqual({ left: 5000, top: 10, width: 50, height: 50 });
    // lastVisibleAt keeps the timestamp of its last real appearance, not
    // the moment it was discovered to be gone.
    expect(view.lastVisibleAt).toBe(1000);
  });

  test("readBoxes stamps lastVisibleAt only on the transition into visibility", () => {
    const registry = createViewRegistry();
    const element = stubElement({ left: 10, top: 10, width: 50, height: 50 });
    registry.register({ id: "p1", element, tier: "plate" });
    registry.readBoxes(canvas, 1000);
    registry.readBoxes(canvas, 2000);
    registry.readBoxes(canvas, 3000);
    // Stayed visible the whole time: the timestamp is frozen at first arrival.
    expect(registry.list()[0].lastVisibleAt).toBe(1000);
  });

  test("readBoxes: a view fully outside its clipTo ancestor is not visible", () => {
    const registry = createViewRegistry();
    const element = stubElement({ left: 10, top: 10, width: 50, height: 50 });
    // The clip ancestor (e.g. the scrolling `main`) sits entirely below the
    // view's own box — think a plate scrolled up under the fixed TopBar.
    const clip = stubElement({ left: 0, top: 200, width: 400, height: 100 });
    registry.register({ id: "p1", element, tier: "plate", clipTo: clip });
    registry.readBoxes(canvas, 1000);
    const [view] = registry.list();
    expect(view.visible).toBe(false);
  });

  test("readBoxes: a view partly outside clipTo is visible with clipBox trimmed to the overlap, but box stays the full element rect", () => {
    const registry = createViewRegistry();
    const element = stubElement({ left: 10, top: -20, width: 50, height: 50 });
    // Clip ancestor starts at top=0 — the top 20px of the element's own box
    // sit above it (e.g. scrolled just above the fixed TopBar).
    const clip = stubElement({ left: 0, top: 0, width: 400, height: 300 });
    registry.register({ id: "p1", element, tier: "plate", clipTo: clip });
    registry.readBoxes(canvas, 1000);
    const [view] = registry.list();
    expect(view.visible).toBe(true);
    // This is the regression case for the shrink/grow-while-scrolling bug:
    // `box` (what frames the camera) must stay the view's own full rect...
    expect(view.box).toEqual({ left: 10, top: -20, width: 50, height: 50 });
    // ...while `clipBox` (what limits painted pixels) is the trimmed overlap.
    expect(view.clipBox).toEqual({ left: 10, top: 0, width: 50, height: 30 });
  });

  test("readBoxes: a view whose clipTo trims its top half reports a clipBox covering only the visible half, while box and its aspect ratio stay those of the full element", () => {
    const registry = createViewRegistry();
    // A 100x100 element half-covered from the top by a fixed bar sitting over
    // its clipping ancestor — the exact "stage scrolled under the TopBar"
    // shape the bug report described.
    const element = stubElement({ left: 0, top: -50, width: 100, height: 100 });
    const clip = stubElement({ left: 0, top: 0, width: 400, height: 300 });
    registry.register({ id: "p1", element, tier: "plate", clipTo: clip });
    registry.readBoxes(canvas, 1000);
    const [view] = registry.list();

    expect(view.box).toEqual({ left: 0, top: -50, width: 100, height: 100 });
    expect(view.box!.width / view.box!.height).toBe(1); // full element's own aspect ratio, untouched
    expect(view.clipBox).toEqual({ left: 0, top: 0, width: 100, height: 50 });
  });

  test("readBoxes: a view with no clipTo gets a clipBox identical to its box", () => {
    const registry = createViewRegistry();
    const element = stubElement({ left: 5, top: 5, width: 40, height: 30 });
    registry.register({ id: "p1", element, tier: "plate" });
    registry.readBoxes(canvas, 1000);
    const [view] = registry.list();
    expect(view.clipBox).toEqual(view.box);
  });

  test("readBoxes: clipBox is a zero-area rect (not the full box) when clipTo doesn't overlap at all", () => {
    const registry = createViewRegistry();
    const element = stubElement({ left: 10, top: 10, width: 50, height: 50 });
    const clip = stubElement({ left: 0, top: 200, width: 400, height: 100 });
    registry.register({ id: "p1", element, tier: "plate", clipTo: clip });
    registry.readBoxes(canvas, 1000);
    const [view] = registry.list();
    expect(view.visible).toBe(false);
    expect(view.box).toEqual({ left: 10, top: 10, width: 50, height: 50 });
    expect(view.clipBox).toEqual({ left: 10, top: 10, width: 0, height: 0 });
  });

  test("readBoxes: leaving the screen immediately clears an active slot", () => {
    const registry = createViewRegistry();
    const { element, move } = movableStubElement({ left: 10, top: 10, width: 50, height: 50 });
    registry.register({ id: "p1", element, tier: "plate" });
    registry.readBoxes(canvas, 1000);
    registry.drawSets(4, 1000);
    expect(registry.list()[0].active).toBe(true);

    move({ left: 5000, top: 10, width: 50, height: 50 });
    registry.readBoxes(canvas, 2000);
    expect(registry.list()[0].active).toBe(false);
  });

  test("drawSets: hero always active even with 20 plates registered", () => {
    const registry = createViewRegistry();
    registry.register({
      id: "hero",
      element: stubElement({ left: 0, top: 0, width: 200, height: 200 }),
      tier: "hero",
    });
    for (let i = 0; i < 20; i++) {
      registry.register({
        id: `plate-${i}`,
        element: stubElement({ left: 0, top: 0, width: 50, height: 50 }),
        tier: "plate",
      });
    }
    registry.readBoxes(canvas, 1000);
    const { active } = registry.drawSets(4, 2000);
    expect(active.some((v) => v.id === "hero")).toBe(true);
  });

  test("drawSets: exactly plateBudget plates land in active, the most recently visible ones", () => {
    const registry = createViewRegistry();
    registry.register({
      id: "hero",
      element: stubElement({ left: 0, top: 0, width: 200, height: 200 }),
      tier: "hero",
    });
    // Register 6 plates and bring them into view one at a time at
    // increasing timestamps, so "most recently visible" has a clear answer.
    const ids = ["p0", "p1", "p2", "p3", "p4", "p5"];
    const stubs = ids.map(() => movableStubElement({ left: -1000, top: 0, width: 50, height: 50 }));
    ids.forEach((id, i) => registry.register({ id, element: stubs[i].element, tier: "plate" }));

    ids.forEach((_, i) => {
      stubs[i].move({ left: 0, top: 0, width: 50, height: 50 });
      registry.readBoxes(canvas, 1000 + i * 100); // p0 arrives first, p5 last
    });

    const { active, slow } = registry.drawSets(4, 9999);
    const activeIds = active.map((v) => v.id).filter((id) => id !== "hero");
    const slowIds = slow.map((v) => v.id);

    expect(activeIds.sort()).toEqual(["p2", "p3", "p4", "p5"]);
    expect(slowIds.sort()).toEqual(["p0", "p1"]);
  });

  test("drawSets: tie-break when candidates share lastVisibleAt favors the lower id", () => {
    const registry = createViewRegistry();
    // All arrive in the same readBoxes call, so lastVisibleAt ties exactly;
    // none has ever been active, so lastActiveAt ties at 0 too. The only
    // thing left to break the tie is id, and the promotion order must be
    // pinned rather than left to insertion-order happenstance.
    const ids = ["zeta", "alpha", "mu"];
    ids.forEach((id) => {
      registry.register({
        id,
        element: stubElement({ left: 0, top: 0, width: 50, height: 50 }),
        tier: "plate",
      });
    });
    registry.readBoxes(canvas, 1000);
    const { active, slow } = registry.drawSets(1, 2000);
    expect(active.map((v) => v.id)).toEqual(["alpha"]);
    expect(slow.map((v) => v.id).sort()).toEqual(["mu", "zeta"]);
  });

  test("drawSets: an off-screen view appears in neither active nor slow", () => {
    const registry = createViewRegistry();
    registry.register({
      id: "onscreen",
      element: stubElement({ left: 0, top: 0, width: 50, height: 50 }),
      tier: "plate",
    });
    registry.register({
      id: "offscreen",
      element: stubElement({ left: 5000, top: 0, width: 50, height: 50 }),
      tier: "plate",
    });
    registry.readBoxes(canvas, 1000);
    const { active, slow } = registry.drawSets(4, 2000);
    const allIds = [...active, ...slow].map((v) => v.id);
    expect(allIds).toContain("onscreen");
    expect(allIds).not.toContain("offscreen");
  });

  test("drawSets budget of 0 sends all visible plates to slow, hero still active", () => {
    const registry = createViewRegistry();
    registry.register({
      id: "hero",
      element: stubElement({ left: 0, top: 0, width: 200, height: 200 }),
      tier: "hero",
    });
    registry.register({
      id: "p0",
      element: stubElement({ left: 0, top: 0, width: 50, height: 50 }),
      tier: "plate",
    });
    registry.readBoxes(canvas, 1000);
    const { active, slow } = registry.drawSets(0, 2000);
    expect(active.map((v) => v.id)).toEqual(["hero"]);
    expect(slow.map((v) => v.id)).toEqual(["p0"]);
  });

  test("drawSets: a steadily-visible incumbent is not displaced the instant a new plate arrives", () => {
    // The exact bug report: a plate active for a couple of frames must not
    // be evicted on the single frame a second plate scrolls into view.
    const registry = createViewRegistry();
    const p0 = stubElement({ left: 0, top: 0, width: 50, height: 50 });
    registry.register({ id: "p0", element: p0, tier: "plate" });
    registry.readBoxes(canvas, 1000);
    registry.drawSets(1, 1000);
    registry.drawSets(1, 1050);

    const p1Stub = movableStubElement({ left: -1000, top: 0, width: 50, height: 50 });
    registry.register({ id: "p1", element: p1Stub.element, tier: "plate" });
    p1Stub.move({ left: 0, top: 0, width: 50, height: 50 });
    registry.readBoxes(canvas, 1100); // p1 arrives with a newer lastVisibleAt than p0's

    const { active, slow } = registry.drawSets(1, 1100);
    expect(active.map((v) => v.id)).toEqual(["p0"]);
    expect(slow.map((v) => v.id)).toEqual(["p1"]);
  });

  test("drawSets: over many frames, every continuously-visible plate gets an active turn, and none is starved forever", () => {
    const registry = createViewRegistry();
    const ids = ["p0", "p1", "p2", "p3", "p4", "p5"];
    const stubs = ids.map(() => movableStubElement({ left: -1000, top: 0, width: 50, height: 50 }));
    ids.forEach((id, i) => registry.register({ id, element: stubs[i].element, tier: "plate" }));

    // Bring them all into view at staggered arrival times, the same way a
    // dashboard grid fills in as the user scrolls.
    let now = 1000;
    ids.forEach((_, i) => {
      stubs[i].move({ left: 0, top: 0, width: 50, height: 50 });
      registry.readBoxes(canvas, now);
      now += 100;
    });

    // Fewer slots than plates, so there is real, sustained contention —
    // exactly the condition under which the old sort could starve a plate
    // forever.
    const plateBudget = 2;
    const everActive = new Set<string>();
    for (let frame = 0; frame < 50; frame++) {
      now += 60; // well past ROTATION_HOLD_MS every few frames
      registry.readBoxes(canvas, now);
      const { active } = registry.drawSets(plateBudget, now);
      for (const v of active) everActive.add(v.id);
    }

    for (const id of ids) {
      expect(everActive.has(id)).toBe(true);
    }
  });

  test("drawSets: with no contention (budget covers every visible plate), nothing is ever demoted", () => {
    const registry = createViewRegistry();
    const ids = ["p0", "p1", "p2"];
    ids.forEach((id) => {
      registry.register({
        id,
        element: stubElement({ left: 0, top: 0, width: 50, height: 50 }),
        tier: "plate",
      });
    });
    registry.readBoxes(canvas, 1000);

    let now = 1000;
    for (let frame = 0; frame < 20; frame++) {
      now += 1000; // far past ROTATION_HOLD_MS, but nobody is waiting
      const { active, slow } = registry.drawSets(3, now);
      expect(active.map((v) => v.id).sort()).toEqual(ids);
      expect(slow).toHaveLength(0);
    }
  });
});
