#!/usr/bin/env python3
"""Record (and re-check) the computed identity styles that #34 freezes.

The purge (#30/M3) may promote and restructure the identity components; it may
not restyle them. Class snapshots catch a changed class attribute, but not a
changed token *value* or a global rule that lands on the same element. So this
script asks a real Chromium, in both themes, what the browser actually
computed for each identity part, and writes it beside the app source.

    # record the snapshot (mock stack, port 6456)
    python scripts/identity_styles.py record --base http://127.0.0.1:6456

    # compare the running app against the committed snapshot; exit 1 on change
    python scripts/identity_styles.py check --base http://127.0.0.1:6456

What is frozen, and why (CONSENSUS.md #34):

  * Switch  — track/thumb/fill, neutral and `hue`-tinted. #34's LOW note makes
              the prop-driven tinted Switch's *computed* styles part of the
              freeze, not just its classes.
  * Slider  — track/fill/thumb/inner dot/bubble, neutral and `tint` while
              dragging (the only state in which the tint paints).
  * StatusDot — the 7x7 dot and its labelled second-channel ring. Frozen only
              after #15, which this branch already contains.
  * Chip    — the hairline chip's neutral and accent tones (the other tones'
              class maps are pinned by identity-freeze.test.ts).
  * SectionLabel — explicitly frozen at section-label.tsx:12-23; #16 may not
              touch it, so its computed styles are the control.
  * Dial    — arc, tick ring, indicator, readout and unit (the instrument's
              identity; no current consumer passes `tint`, so neutral only).
  * Brand   — the "filament" wordmark and its breathe dot (top-bar.tsx); the
              FilamentMark glyph is not mounted in the app UI.

Element identity is a selector, never text: a selector that stops matching is
itself a finding (the part moved or was restyled), so this fails loudly.

Values are deliberately not compared across Chromium versions by CI — the
committed JSON is the recorded truth, and `identity-freeze.test.ts` guards the
inputs (component class strings + tokens.css + globals.css hashes) in `npm
test`. Run `check` on the machine the snapshot came from.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "webui" / "app"
DEFAULT_OUT = APP / "src" / "styles" / "identity-styles.snapshot.json"

VIEWPORT = {"width": 1440, "height": 900}
READY = "Shelf Lamp"

# Properties that carry a visual identity. Transform/animation phase is
# excluded on purpose: motion is expected to run, and a spring's current
# transform is not a style decision. Animation *name* and *duration* are
# included where a part animates (the dot's breathe).
PROPS = [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "text-transform",
    "color",
    "background-color",
    "background-image",
    "border-top-width",
    "border-top-style",
    "border-top-color",
    "border-right-width",
    "border-right-color",
    "border-bottom-width",
    "border-bottom-color",
    "border-left-width",
    "border-left-color",
    "border-top-left-radius",
    "box-shadow",
    "opacity",
    "width",
    "height",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "column-gap",
    "stroke",
    "stroke-width",
    "fill",
    "animation-name",
    "animation-duration",
]

# A breathing dot's opacity and a dragged slider's spring-driven width are not
# style decisions; they are the phase of an animation or the pointer's resting
# place, and two identical runs disagree. Everything else about those parts is
# still frozen.
IGNORE: dict[str, set[str]] = {
    "brand.dot": {"opacity"},
    "statusdot.labelled.dot": {"opacity"},
    "statusdot.plain.dot": {"opacity"},
    "slider.tinted.fill": {"width", "height"},
}

GET_STYLE = r"""
(args) => {
  const { selector, props, index } = args;
  const all = document.querySelectorAll(selector);
  const el = all[index ?? 0];
  if (!el) return null;
  const cs = getComputedStyle(el);
  const out = {};
  for (const p of props) out[p] = cs.getPropertyValue(p);
  out["@tag"] = el.tagName.toLowerCase();
  out["@class"] = el.getAttribute("class") || "";
  return out;
}
"""

# route -> list of (part, selector, index, note)
PARTS = {
    "/": [
        ("brand.wordmark", "header span.tracking-display", 0,
         "the wordmark's type, weight, tracking and colour"),
        ("brand.dot", "header span.animate-dot-breathe", 0,
         "the 5px status pinhole beside the wordmark, including its breathe"),
        ("chip.neutral", "span.rounded-chip.border.border-hairline.text-mid", 0,
         "hairline chip: the model/transport tag"),
        ("switch.hue.track", "button[role=switch] > span.h-7.w-12", 0,
         "#34 LOW note: prop-driven tinted Switch, track"),
        ("switch.hue.fill", "button[role=switch] > span.h-7.w-12 > span[aria-hidden]", 0,
         "#34 LOW note: the `hue` gradient fill"),
        ("switch.hue.thumb", "button[role=switch] > span.h-7.w-12 > span[aria-hidden]:last-child", 0,
         "#34 LOW note: the 22px thumb"),
        ("slider.fill", ".slider-thumb", 0, None),  # replaced by the drag pass
        ("statusdot.labelled.dot", 'span[class*="h-[7px]"][class*="ring-1"]', 0,
         "the labelled StatusDot's dot (second channel ring)"),
    ],
    "/device/Shelf%20Lamp": [
        ("sectionLabel.index", "div.flex.select-none.items-center.gap-2 > span.font-mono", 0,
         "SectionLabel's mono index — explicitly frozen, #16 must not touch it"),
        ("sectionLabel.dash", "div.flex.select-none.items-center.gap-2 > span[aria-hidden]", 0,
         "SectionLabel's em dash"),
        ("sectionLabel.title", "div.flex.select-none.items-center.gap-2 > span.tracking-micro", 0,
         "SectionLabel's 11px uppercase title"),
        ("chip.accent", "span.rounded-chip.border.bg-accent-dim", 0,
         "accent chip: the device model tag"),
        ("switch.neutral.track", "button[role=switch] > span.h-7.w-12", 0,
         "neutral Switch track"),
        ("switch.neutral.thumb", "button[role=switch] > span.h-7.w-12 > span[aria-hidden]:last-child", 0,
         "neutral Switch thumb"),
        ("statusdot.plain.dot", 'span[class*="h-[7px]"]:not([class*="ring-1"])', 0,
         "unlabelled StatusDot: 7x7, colour is the only channel"),
        ("slider.track", '[class*="slider-thumb"]', 0, None),  # replaced below
        ("slider.neutral.thumb", ".slider-thumb", 0,
         "neutral Slider thumb chip (20px)"),
        ("slider.neutral.dot", ".slider-thumb > span[aria-hidden]", 0,
         "the thumb's inner accent dot"),
        ("dial.root", "div[role=slider]", 0,
         "the Dial's box (160px on this route)"),
        ("dial.arc", "div[role=slider] > svg > path", 0,
         "the 270-degree progress arc"),
        ("dial.rim", "div[role=slider] > svg > circle:nth-of-type(1)", 0,
         "the knurled rim"),
        ("dial.face", "div[role=slider] > svg > circle:nth-of-type(2)", 0,
         "the machined face"),
        ("dial.indicator", "div[role=slider] > div[aria-hidden] > span", 0,
         "the rotating indicator"),
        ("dial.readout", "div[role=slider] .font-mono.text-sm", 0,
         "the numeric readout"),
        ("dial.unit", "div[role=slider] .text-data", 0,
         "the unit under the readout"),
    ],
}


def sha256(path: Path) -> str:
    """Hash a file's CONTENT, not the checkout's line endings.

    `core.autocrlf` rewrites the working tree on Windows (CRLF) and not in
    CI on Linux (LF), so a raw-byte hash of a text file differs between the
    machine that recorded the snapshot and the machine that checks it — the
    gate then fails in CI for a file nobody changed. Every freeze input is
    a text file, so CRLF is normalised to LF before the hash: the hash
    describes the file, not the platform it was checked out on.

    The test in `identity-freeze.test.ts` normalises the same way; the two
    must agree byte for byte.
    """
    data = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def style_inputs() -> dict[str, str]:
    """The styling inputs the identity is painted with.

    Not a fixed list: every `*.css` under `webui/app/src` is included, so a
    stylesheet added later is a change to the identity, not a loophole. The
    document that decides which font families and which stylesheet reach the
    page (`app/layout.tsx` - the `next/font` calls and the CSS imports) and
    the PostCSS/Tailwind pipeline are inputs too.
    """
    files: dict[str, Path] = {
        "webui/app/src/app/layout.tsx": APP / "src" / "app" / "layout.tsx",
        "webui/app/postcss.config.mjs": APP / "postcss.config.mjs",
    }
    for css in sorted((APP / "src").rglob("*.css")):
        rel = css.relative_to(ROOT).as_posix()
        files[rel] = css
    missing = [k for k, p in files.items() if not p.exists()]
    if missing:
        raise SystemExit(f"missing style inputs: {missing}")
    return {k: sha256(p) for k, p in files.items()}


def inputs() -> dict[str, str]:
    """Every file the frozen identity depends on, hashed.

    Two groups, and the difference matters:

    * the frozen sources — the identity components themselves and the typed
      token module. A class edit in one of them changes the markup
      snapshot; a value edit changes this hash.
    * the styling inputs — every stylesheet under `src`, the document that
      decides which fonts reach the page, and the PostCSS pipeline. A token
      value, a base rule, a new stylesheet or a different font family all
      land on the same elements as a class edit does, so they are hashed
      here too.
    """
    files = {
        "webui/app/src/components/ui/switch.tsx": APP / "src" / "components" / "ui" / "switch.tsx",
        "webui/app/src/components/ui/slider.tsx": APP / "src" / "components" / "ui" / "slider.tsx",
        "webui/app/src/components/ui/status-dot.tsx": APP / "src" / "components" / "ui" / "status-dot.tsx",
        "webui/app/src/components/ui/chip.tsx": APP / "src" / "components" / "ui" / "chip.tsx",
        "webui/app/src/components/ui/section-label.tsx": APP / "src" / "components" / "ui" / "section-label.tsx",
        "webui/app/src/components/ui/dial.tsx": APP / "src" / "components" / "ui" / "dial.tsx",
        # CONSENSUS.md:240 names Panel, Odometer and StatusStrip in the same
        # breath as the rest of the identity set. They were not frozen in
        # the first pass; these three entries are that gap closing.
        "webui/app/src/components/ui/panel.tsx": APP / "src" / "components" / "ui" / "panel.tsx",
        "webui/app/src/components/ui/odometer.tsx": APP / "src" / "components" / "ui" / "odometer.tsx",
        "webui/app/src/components/shell/status-strip.tsx": APP / "src" / "components" / "shell" / "status-strip.tsx",
        "webui/app/src/components/shell/top-bar.tsx": APP / "src" / "components" / "shell" / "top-bar.tsx",
        # QUICK_COLORS and the paint palette: typed tokens with one owner
        # (#34 "QUICK_COLORS -> typed tokens"). The swatch values are part
        # of the console's identity, so a palette edit fails the gate.
        "webui/app/src/lib/color-tokens.ts": APP / "src" / "lib" / "color-tokens.ts",
    }
    missing = [k for k, p in files.items() if not p.exists()]
    if missing:
        raise SystemExit(f"missing freeze inputs: {missing}")
    out = {k: sha256(p) for k, p in files.items()}
    out.update(style_inputs())
    return dict(sorted(out.items()))


ROUTE_ANCHOR = {
    "/": "button[role=switch]",
    "/device/Shelf%20Lamp": "div[role=slider]",
}


def wait_ready(page, route: str) -> None:
    page.wait_for_function(
        "(needle) => document.body.innerText.toLowerCase().includes(needle)",
        arg=READY.lower(),
        timeout=30_000,
    )
    # The body text appears before the light tab has mounted; the anchor is the
    # thing being measured, so wait for it rather than for a skeleton.
    page.wait_for_selector(ROUTE_ANCHOR[route], timeout=30_000)
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(1200)


def read_part(page, selector: str, index: int, part: str = "") -> dict:
    value = page.evaluate(GET_STYLE, {"selector": selector, "props": PROPS, "index": index})
    if value is None:
        raise SystemExit(f"selector did not match: {selector!r} (index {index})")
    for prop in IGNORE.get(part, ()):
        value.pop(prop, None)
    return value


def read_stable(page, selector: str, index: int, part: str = "") -> dict:
    """Wait for colour transitions to settle, then return the value.

    The device-hue fill can still be interpolating 1.2s after load (its
    gradient is derived from the card's --dev-* quartet), so one sample is
    not evidence. Two identical consecutive samples are.
    """
    previous = read_part(page, selector, index, part)
    for _ in range(10):
        page.wait_for_timeout(250)
        current = read_part(page, selector, index, part)
        if current == previous:
            return current
        previous = current
    raise SystemExit(f"{part or selector} never held still for 250ms")


def record(base: str) -> dict:
    import datetime as _dt

    result: dict = {
        "_meta": {
            "recorded_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
            "base": base,
            "viewport": f"{VIEWPORT['width']}x{VIEWPORT['height']}",
            "themes": ["dark", "light"],
            "commit": None,
            "note": (
                "Computed styles of the seven identity components #34 freezes, "
                "recorded in a real Chromium. The CI test guards the inputs "
                "(component source, tokens.css, globals.css); `identity_styles.py "
                "check` re-measures a running app against this file."
            ),
            "why": {
                "switch": "#34 LOW note: prop-driven tinted Switch computed styles, both themes",
                "slider": "#34 LOW note: prop-driven tinted Slider computed styles, both themes (tint paints only while dragging)",
                "statusdot": "#15 second channel must survive; frozen only after #15 lands",
                "chip": "tone map (incl. signal's --dev-hue fill) is identity; neutral and accent measured live",
                "sectionlabel": "explicitly frozen at section-label.tsx:12-23; #16 must not touch it",
                "dial": "instrument identity: arc, ticks, indicator, readout, unit",
                "brand": "the filament wordmark and its breathe dot (top-bar.tsx)",
            },
        },
        "inputs": inputs(),
        "parts": {},
    }
    try:
        import subprocess

        head = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=False,
        ).stdout.strip() or None

        # L-4 (PR #16's review): `_meta.commit` used to be written as
        # `rev-parse HEAD` and nothing else, so a snapshot recorded with
        # the wave's files still sitting in the working tree pointed at
        # the merge base — the data was the branch's, the pointer was not.
        # The pointer is only allowed to name a commit when the recorded
        # tree IS that commit: if any identity input is dirty, the commit
        # is dropped rather than made to lie, and the dirty files are
        # named so the next person knows why.
        dirty: list[str] = []
        for rel in sorted(result["inputs"]):
            status = subprocess.run(
                ["git", "-C", str(ROOT), "status", "--porcelain", "--", rel],
                capture_output=True, text=True, check=False,
            ).stdout.strip()
            if status:
                dirty.append(rel)

        result["_meta"]["commit"] = None if dirty else head
        result["_meta"]["dirty_inputs"] = dirty
        if dirty:
            print(
                "WARNING: the identity inputs are not committed; the recorded "
                "styles do NOT come from the commit below. Commit them (or "
                "re-record from a clean tree) before trusting `_meta.commit`:\n  "
                + "\n  ".join(dirty),
                file=sys.stderr,
            )
    except OSError:
        pass

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for theme in ("dark", "light"):
            ctx = browser.new_context(
                viewport=VIEWPORT, device_scale_factor=1, has_touch=False,
            )
            ctx.add_init_script(f"localStorage.setItem('theme', '{theme}')")
            page = ctx.new_page()
            for route, parts in PARTS.items():
                page.goto(base + route, wait_until="networkidle", timeout=60_000)
                wait_ready(page, route)
                for part, selector, index, _note in parts:
                    if part in ("slider.fill", "slider.track"):
                        continue
                    key = f"{part}.{theme}"
                    result["parts"][key] = {
                        "route": route,
                        "selector": selector,
                        "index": index,
                        "values": read_stable(page, selector, index, part),
                    }
                if route == "/":
                    # Slider `tint` paints only while a drag is live. Hold the
                    # first device-plate thumb down, measure, release.
                    thumb = page.locator(".slider-thumb").first
                    box = thumb.bounding_box()
                    if box is None:
                        raise SystemExit("tinted slider thumb has no box")
                    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                    page.mouse.down()
                    page.wait_for_timeout(150)
                    dragging = page.locator('.slider-thumb[data-dragging="true"]').count()
                    if dragging == 0:
                        raise SystemExit("slider never entered its dragging state")
                    fill_sel = ".slider-thumb"
                    # the fill is the sibling div inside the Radix track
                    fill_sel = "div.absolute.left-0.h-full.rounded-full"
                    for part, sel, idx in (
                        ("slider.tinted.fill", fill_sel, 0),
                        ("slider.tinted.thumb", ".slider-thumb", 0),
                        ("slider.tinted.thumbDot", ".slider-thumb > span[aria-hidden]", 0),
                    ):
                        result["parts"][f"{part}.{theme}"] = {
                            "route": "/",
                            "selector": sel,
                            "index": idx,
                            "values": read_stable(page, sel, idx, part),
                        }
                    page.mouse.up()
                    page.wait_for_timeout(300)
                if route == "/device/Shelf%20Lamp":
                    # The neutral slider's track/fill are inside the Radix root.
                    for part, sel, idx in (
                        ("slider.neutral.track", '[class*="h-[2px]"]', 0),
                        ("slider.neutral.fill", "div.absolute.left-0.h-full.rounded-full", 0),
                    ):
                        result["parts"][f"{part}.{theme}"] = {
                            "route": route,
                            "selector": sel,
                            "index": idx,
                            "values": read_stable(page, sel, idx, part),
                        }
            ctx.close()
        browser.close()
    return result


def diff(snapshot: dict, live: dict) -> list[str]:
    problems: list[str] = []
    for key in sorted(set(snapshot) | set(live)):
        a = snapshot.get(key)
        b = live.get(key)
        if a is None or b is None:
            problems.append(f"{key}: present in one run only")
            continue
        av, bv = a["values"], b["values"]
        for prop in PROPS + ["@tag", "@class"]:
            if av.get(prop) != bv.get(prop):
                problems.append(f"{key} {prop}: {av.get(prop)!r} -> {bv.get(prop)!r}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["record", "check"])
    ap.add_argument("--base", default="http://127.0.0.1:6456")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    if args.mode == "record":
        data = record(args.base)
        args.out.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        print(f"wrote {args.out} ({len(data['parts'])} part records)")
        return 0

    if not args.out.exists():
        raise SystemExit(f"no snapshot at {args.out}; run record first")
    old = json.loads(args.out.read_text(encoding="utf-8"))
    live = record(args.base)
    problems = diff(old["parts"], live["parts"])
    if problems:
        print(f"DIFF: {len(problems)} computed-style change(s)")
        for line in problems:
            print("  " + line)
        return 1
    print(f"OK: {len(old['parts'])} part records identical in both themes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
