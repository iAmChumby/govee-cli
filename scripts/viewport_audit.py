#!/usr/bin/env python3
"""Prove mobile polish landed without moving a single desktop pixel.

The console is being reworked for phones under one hard constraint from the
person doing the work: "must not impact desktop." Nobody can hold that
constraint in their head across a multi-file CSS/layout pass by eye — and the
whole reason mobile defects like a sliced-off "2700K" chip get through is that
`verify_ui.py`'s own overflow check only looks at the *page's* scrollWidth,
which stays flat even when an element two levels down clips its own content.
This script is the gate for both halves of the constraint:

  --baseline   capture desktop (1440x900) DOM geometry before the change,
               once, as a committed-adjacent fixture.
  --check      re-capture that same geometry and diff it byte-for-byte
               against the baseline (desktop must not move), THEN run a
               mobile-viewport defect sweep (clipping, cramped touch targets,
               controls sitting off-screen, unlabelled scroll areas).

It reuses `verify_ui.py`'s stack machinery (`start_stack`, `_terminate_group`,
the mock guard) rather than reimplementing it — this file does not own that
code and must not fork its behavior. Like `verify_ui.py`, it only ever talks
to `GOVEE_WEBUI_MOCK=1` on scratch ports 6156/6157; the mock guard below is a
hard refusal, not a warning, because the devices this console controls are
real hardware in a bedroom.

WHAT THE DESKTOP GEOMETRY CAPTURE DELIBERATELY EXCLUDES, AND WHY:

  * Anything inside a <canvas> subtree (the canvas element itself and any
    fallback content under it). The motion engine draws into a <canvas> at
    up to real frame rate; its own bounding box is stable, but it exists
    entirely to animate, and animated-pixel content is out of scope for a
    static layout diff — `verify_ui.py`'s `canvas_is_animating` already
    covers that ground on its own terms.

  * Elements carrying the `will-change-transform` class. In this codebase
    that class marks exactly one thing: the inner `motion.span` of the
    instrument's `Halo` glow layer (`components/stage/stage.tsx`), which
    rides a `useSpring` value from 0.82x to 1.1x scale continuously whenever
    the device is powered on. A CSS *transform* scale changes what
    `getBoundingClientRect()` reports, so two captures taken 700ms apart —
    one now, one after a code change days later — can legitimately land at
    different points along that same idle spring and read as a "regression"
    that is really just animation phase. The sibling `Breath` opacity
    flicker is intentionally NOT excluded: opacity never changes a rect, so
    excluding it would just be throwing away real coverage. (Judgment call:
    the task named "the animated instrument" by class match, but nothing in
    this codebase's class names literally says "instrument" — this is the
    one class distinctive enough to identify the transform-animating layer
    without also swallowing static siblings that happen to share generic
    utility classes. Worth a second look if the instrument markup changes.)

  * `position: fixed` elements that also look like a toast or overlay
    container — matched by class name (`toast|overlay|dialog|modal|sheet|
    portal`), ARIA role (`status`, `alert`, `alertdialog`, `dialog`), or the
    presence of `aria-live`. As of this writing the only fixed-position
    elements in the app ARE the toast stack (`Toaster`, `aria-live="polite"`)
    and the Radix dialog overlay/content — there is no persistent fixed nav
    or header — so in practice this excludes exactly those two things.
    (Judgment call, same flavor as above: the toast stack's own class list
    never spells "toast", so the match leans on `aria-live` too. Recheck
    this if a fixed nav bar is ever added — a real fixed nav SHOULD be
    tracked by the diff, and this heuristic would currently exclude it.)

Everything else that is genuinely visible (`getClientRects().length > 0`) is
tracked, keyed by tag + full class attribute + trimmed/hashed text rather
than DOM-index path, so a fix that wraps an element in a new `<div>` does not
detonate the whole baseline as noise.

    python3 scripts/viewport_audit.py --baseline
    python3 scripts/viewport_audit.py --check
    python3 scripts/viewport_audit.py --check --no-desktop-diff

Exit code is 0 only if everything passed (see `main` for the full contract).
"""

from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from verify_ui import (  # noqa: E402  (path must be set up first)
    API_PORT,
    WEB_PORT,
    Failure,
    _terminate_group,
    start_stack,
)

REPO = pathlib.Path(__file__).resolve().parent.parent

# The baseline is committed, unlike the screenshots. It records the desktop
# geometry of the commit BEFORE the mobile pass, which is not something a later
# run can reproduce — once the change lands, the only way back to those numbers
# is the file. `.verify-ui/` is gitignored, so it cannot live there.
BASELINE_FILE = REPO / ".planning" / "desktop-baseline.json"
AUDIT_DIR = REPO / ".verify-ui" / "audit"

DESKTOP_VIEWPORT = {"width": 1440, "height": 900}
MOBILE_VIEWPORT = {"width": 390, "height": 844}

# Anything moving less than this is capture jitter, not a regression.
GEOMETRY_TOLERANCE_PX = 1

CLIP_HARD_OVERFLOW_PX = 2
SCROLL_WARN_OVERFLOW_PX = 8
TOUCH_MIN_PX = 44

MAX_PRINTED_DIFFS = 25

TOUCH_TARGET_SELECTOR = (
    'button, a[href], [role="button"], [role="tab"], '
    'input:not([type=hidden]), select, [tabindex]:not([tabindex="-1"])'
)

# Shared across every page.evaluate() call below so a stable element key
# means the same thing everywhere it's computed. Deliberately NOT a DOM index
# path — see the module docstring — and deliberately not `el.className`,
# which returns an SVGAnimatedString (not a plain string) on SVG elements.
JS_HELPERS = """
    function hashStr(s) {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16);
    }
    /* An element's OWN text — direct child text nodes only, never
       descendants. Using textContent here was the first version's bug: the
       status strip carries a ticking clock and a live latency readout, so
       every ancestor from <html> down inherited a string that changed
       between captures, and the desktop diff reported ~40 phantom
       regressions per run on completely unmodified code. A gate that cries
       wolf on every run is a gate someone switches off. */
    function ownText(el) {
      let out = '';
      for (const n of el.childNodes) {
        if (n.nodeType === 3) out += n.nodeValue;
      }
      return out.trim().replace(/\\s+/g, ' ');
    }
    /* Digits collapse to '#'. A clock reading 11:57:17 and the same clock
       reading 11:58:55 are the same element, and the key has to say so.
       Costs a little discriminating power — the three temperature presets
       all key as '####' — which the per-key document-order ordinal in the
       caller then separates. */
    function keyText(el) {
      const text = ownText(el).replace(/[0-9]/g, '#');
      return text.length > 40 ? ('h:' + hashStr(text)) : text;
    }
    function stableKey(el, cls) {
      return el.tagName.toLowerCase() + '|' + cls + '|' + keyText(el);
    }
    /* For humans reading the report: the real, un-normalised text. */
    function labelOf(el) {
      const t = ownText(el) || (el.textContent || '').trim().replace(/\\s+/g, ' ');
      return t.length > 60 ? t.slice(0, 60) + '…' : t;
    }
    /* Opt-out for elements whose geometry legitimately changes between two
       captures of identical code: the clock, the measured latency. Their
       rendered width tracks their content ('7 ms' vs '127 ms'), so no key
       scheme can make them diff clean — they have to be named. */
    function isVolatile(el) {
      return el.closest('[data-volatile="true"]') !== null;
    }
    /* A visually-hidden span is a 1px box clipping a full sentence. That is
       what sr-only IS, not a defect, and flagging it buries the real ones. */
    function isScreenReaderOnly(cls) {
      return /(^|\\s)sr-only(\\s|$)/.test(cls);
    }
    function isInCanvasSubtree(el) {
      return !!el.closest('canvas');
    }
    function isAnimatedInstrument(cls) {
      return cls.indexOf('will-change-transform') !== -1;
    }
    function isFixedOverlay(el, cls) {
      if (getComputedStyle(el).position !== 'fixed') return false;
      const role = (el.getAttribute('role') || '').toLowerCase();
      const hasAriaLive = el.hasAttribute('aria-live');
      return /toast|overlay|dialog|modal|sheet|portal/i.test(cls)
        || role === 'status' || role === 'alert'
        || role === 'alertdialog' || role === 'dialog'
        || hasAriaLive;
    }
"""

GEOMETRY_JS = """() => {
""" + JS_HELPERS + """
    const counts = Object.create(null);
    const out = {};
    for (const el of document.querySelectorAll('*')) {
      if (el.getClientRects().length === 0) continue;
      if (isInCanvasSubtree(el)) continue;
      const cls = el.getAttribute('class') || '';
      if (isAnimatedInstrument(cls)) continue;
      if (isFixedOverlay(el, cls)) continue;
      if (isVolatile(el)) continue;

      const base = stableKey(el, cls);
      const n = (counts[base] || 0) + 1;
      counts[base] = n;
      const key = n > 1 ? (base + '#' + n) : base;

      const r = el.getBoundingClientRect();
      out[key] = {
        w: Math.round(r.width), h: Math.round(r.height),
        x: Math.round(r.x), y: Math.round(r.y),
      };
    }
    return out;
  }
"""

CLIP_JS = """() => {
""" + JS_HELPERS + f"""
    const flagged = [];
    let exempted = 0;
    for (const el of document.querySelectorAll('*')) {{
      if (el.getClientRects().length === 0) continue;
      const overflow = el.scrollWidth - el.clientWidth;
      if (overflow <= {CLIP_HARD_OVERFLOW_PX}) continue;
      const style = getComputedStyle(el);
      if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue;
      const cls = el.getAttribute('class') || '';
      if (isScreenReaderOnly(cls)) {{ exempted++; continue; }}
      if (el.getAttribute('data-clip-ok') === 'true') {{ exempted++; continue; }}

      flagged.push({{ key: stableKey(el, cls), overflow, text: labelOf(el) }});
    }}
    return {{ flagged, exempted }};
  }}
"""

SCROLL_JS = """() => {
""" + JS_HELPERS + f"""
    const flagged = [];
    for (const el of document.querySelectorAll('*')) {{
      if (el.getClientRects().length === 0) continue;
      const overflow = el.scrollWidth - el.clientWidth;
      if (overflow <= {SCROLL_WARN_OVERFLOW_PX}) continue;
      const style = getComputedStyle(el);
      if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') continue;
      if (el.getAttribute('data-scroll-affordance') === 'true') continue;

      const cls = el.getAttribute('class') || '';
      flagged.push({{ key: stableKey(el, cls), overflow }});
    }}
    return flagged;
  }}
"""

TOUCH_JS = """(sel) => {
""" + JS_HELPERS + f"""
    const small = {{}};
    const offscreen = [];
    const vw = window.innerWidth;
    for (const el of document.querySelectorAll(sel)) {{
      if (el.getClientRects().length === 0) continue;
      if (el.disabled) continue;
      if ((el.getAttribute('aria-disabled') || '').toLowerCase() === 'true') continue;

      const r = el.getBoundingClientRect();
      const cls = el.getAttribute('class') || '';
      const key = stableKey(el, cls);
      const exempt = el.getAttribute('data-touch-ok') === 'true';

      if (!exempt && (r.width < {TOUCH_MIN_PX} || r.height < {TOUCH_MIN_PX})) {{
        const g = small[key] || {{ count: 0, minW: Infinity, minH: Infinity }};
        g.count += 1;
        g.minW = Math.min(g.minW, Math.round(r.width));
        g.minH = Math.min(g.minH, Math.round(r.height));
        small[key] = g;
      }}
      if (r.right > vw + 1 || r.left < -1) {{
        offscreen.push({{
          key, left: Math.round(r.left), right: Math.round(r.right), vw,
        }});
      }}
    }}
    return {{ small, offscreen }};
  }}
"""

DIAL_JS = """() => {
    const els = Array.from(document.querySelectorAll('[aria-label]'));
    const dial = els.find(
      (el) => (el.getAttribute('aria-label') || '').toLowerCase().includes('brightness')
    );
    if (!dial) return null;
    const r = dial.getBoundingClientRect();
    return { centerY: Math.round(r.top + window.scrollY + r.height / 2) };
  }
"""


@dataclass
class AuditResults:
    hard: list[str] = field(default_factory=list)
    warn: list[str] = field(default_factory=list)
    info: list[str] = field(default_factory=list)


Geometry = dict[str, dict[str, int]]
GeometryByRoute = dict[str, Geometry]


def format_geom(g: dict[str, int]) -> str:
    return f"w={g['w']} h={g['h']} x={g['x']} y={g['y']}"


def discover_device_path(page: Any) -> str | None:
    """Find the device console route the same way verify_ui.py does.

    Several device links can exist (nav drawer, dashboard plates); the first
    *visible* one is the one a person could actually tap, which is the only
    meaningful thing to walk. Never hardcode a device id — the mock's device
    set can change.
    """
    page.wait_for_load_state("networkidle", timeout=45_000)
    link = page.locator("a[href^='/device/']:visible").first
    if link.count() == 0:
        return None
    return link.get_attribute("href")


def capture_desktop_geometry(
    browser: Any, base: str, routes: list[tuple[str, str]]
) -> GeometryByRoute:
    """1440x900, no touch, dark — the exact fixture the baseline is made of."""
    ctx = browser.new_context(
        viewport=DESKTOP_VIEWPORT, is_mobile=False, has_touch=False,
        color_scheme="dark",
    )
    page = ctx.new_page()
    data: GeometryByRoute = {}
    for name, path in routes:
        page.goto(base + path, wait_until="networkidle", timeout=45_000)
        page.wait_for_timeout(700)
        data[name] = page.evaluate(GEOMETRY_JS)
    ctx.close()
    return data


def diff_all_routes(baseline: GeometryByRoute, current: GeometryByRoute) -> list[dict[str, Any]]:
    """Every diff record carries a `severity` used only to pick the 25 worst.

    Missing/new keys are structural — an element vanished or appeared — and
    always outrank a geometry nudge, so they sort first via `inf`.
    """
    out: list[dict[str, Any]] = []
    for route, before in baseline.items():
        after = current.get(route, {})
        for key, bgeo in before.items():
            if key not in after:
                out.append({
                    "route": route, "kind": "missing", "key": key,
                    "before": bgeo, "after": None, "severity": float("inf"),
                })
        for key, ageo in after.items():
            if key not in before:
                out.append({
                    "route": route, "kind": "new", "key": key,
                    "before": None, "after": ageo, "severity": float("inf"),
                })
                continue
            bgeo = before[key]
            delta = max(abs(bgeo[f] - ageo[f]) for f in ("w", "h", "x", "y"))
            if delta > GEOMETRY_TOLERANCE_PX:
                out.append({
                    "route": route, "kind": "changed", "key": key,
                    "before": bgeo, "after": ageo, "severity": delta,
                })
    out.sort(key=lambda d: d["severity"], reverse=True)
    return out


def print_desktop_diffs(diffs: list[dict[str, Any]]) -> None:
    if not diffs:
        print("  desktop geometry: identical to baseline.")
        return
    shown = diffs[:MAX_PRINTED_DIFFS]
    for d in shown:
        if d["kind"] == "missing":
            print(f"  [MISSING] {d['route']} :: {d['key']}  (was {format_geom(d['before'])})")
        elif d["kind"] == "new":
            print(f"  [NEW]     {d['route']} :: {d['key']}  (now {format_geom(d['after'])})")
        else:
            print(
                f"  [CHANGED] {d['route']} :: {d['key']}  "
                f"before={format_geom(d['before'])} after={format_geom(d['after'])} "
                f"(Δmax={d['severity']}px)"
            )
    omitted = len(diffs) - len(shown)
    if omitted > 0:
        print(f"  ... and {omitted} more diff(s) not shown")
    print(f"  {len(diffs)} total desktop geometry diff(s)")


def diffs_to_failures(diffs: list[dict[str, Any]]) -> list[str]:
    out = []
    for d in diffs:
        if d["kind"] == "missing":
            out.append(f"desktop element disappeared: {d['route']} :: {d['key']}")
        elif d["kind"] == "new":
            # A genuinely new *visible* desktop element (display:none elements
            # have no client rects and were never captured) is a real
            # regression, not a legitimate mobile-only addition — see the
            # module docstring's reasoning on this exact point.
            out.append(f"new visible desktop element appeared: {d['route']} :: {d['key']}")
        else:
            out.append(
                f"desktop geometry changed: {d['route']} :: {d['key']} "
                f"(Δmax={d['severity']}px)"
            )
    return out


def run_mobile_audit(browser: Any, base: str, routes: list[tuple[str, str]]) -> AuditResults:
    results = AuditResults()
    for theme in ("dark", "light"):
        ctx = browser.new_context(
            viewport=MOBILE_VIEWPORT, device_scale_factor=3,
            is_mobile=True, has_touch=True, color_scheme=theme,
        )
        page = ctx.new_page()
        for name, path in routes:
            page.goto(base + path, wait_until="networkidle", timeout=45_000)
            page.wait_for_timeout(700)
            page.screenshot(path=str(AUDIT_DIR / f"{theme}-{name}.png"), full_page=True)

            clip = page.evaluate(CLIP_JS)
            for item in clip["flagged"]:
                results.hard.append(
                    f"[{theme}:{name}] hard clipping — {item['key']} "
                    f"overflow={item['overflow']}px text={item['text']!r}"
                )
            if clip["exempted"]:
                results.info.append(
                    f"[{theme}:{name}] {clip['exempted']} clipping exemption(s) "
                    "honoured (data-clip-ok)"
                )

            for item in page.evaluate(SCROLL_JS):
                results.warn.append(
                    f"[{theme}:{name}] scrollable without affordance — "
                    f"{item['key']} overflow={item['overflow']}px"
                )

            touch = page.evaluate(TOUCH_JS, TOUCH_TARGET_SELECTOR)
            for key, g in touch["small"].items():
                results.hard.append(
                    f"[{theme}:{name}] touch target below {TOUCH_MIN_PX}px — "
                    f"{key} min={g['minW']}x{g['minH']} ×{g['count']}"
                )
            for item in touch["offscreen"]:
                results.hard.append(
                    f"[{theme}:{name}] interactive control off-viewport — "
                    f"{item['key']} left={item['left']} right={item['right']} "
                    f"viewport={item['vw']}"
                )

            if name == "device":
                dial = page.evaluate(DIAL_JS)
                if dial is None:
                    results.info.append(
                        f"[{theme}:{name}] no element with an aria-label containing "
                        "'brightness' was found — vertical reach not reported"
                    )
                else:
                    fold = MOBILE_VIEWPORT["height"]
                    where = "within" if dial["centerY"] <= fold else "below"
                    results.info.append(
                        f"[{theme}:{name}] brightness dial centre at "
                        f"y={dial['centerY']}px — {where} the {fold}px first fold"
                    )
        ctx.close()
    return results


def print_mobile_report(audit: AuditResults) -> None:
    print(f"\n  hard failures (clipping / touch targets / off-viewport): {len(audit.hard)}")
    for h in audit.hard:
        print(f"    - {h}")
    print(f"\n  warnings (scrollable without affordance): {len(audit.warn)}")
    for w in audit.warn:
        print(f"    - {w}")
    print("\n  info:")
    for i in audit.info:
        print(f"    - {i}")


def run_baseline_mode(
    browser: Any, base: str, routes: list[tuple[str, str]], missing_device: str | None
) -> int:
    print("capturing desktop baseline geometry (1440x900, dark)...")
    data = capture_desktop_geometry(browser, base, routes)
    BASELINE_FILE.write_text(json.dumps(data, indent=2, sort_keys=True))
    total = sum(len(v) for v in data.values())
    print(f"wrote {BASELINE_FILE} — {len(data)} route(s), {total} tracked element(s)")
    if missing_device:
        print(f"WARNING: {missing_device}")
    return 0


def run_check_mode(
    browser: Any,
    base: str,
    routes: list[tuple[str, str]],
    no_desktop_diff: bool,
    missing_device: str | None,
) -> int:
    hard: list[str] = []
    warn: list[str] = []
    info: list[str] = []
    if missing_device:
        hard.append(missing_device)

    print("\n=== DESKTOP INVARIANCE ===")
    if no_desktop_diff:
        print("  skipped (--no-desktop-diff)")
    elif not BASELINE_FILE.exists():
        # Silently skipping this gate when the baseline is simply missing is
        # exactly the bug this whole script exists to prevent — so treat it
        # as a failure, loudly, unless the caller explicitly opted out above.
        msg = (
            f"no baseline file at {BASELINE_FILE} — desktop invariance was NOT "
            "checked. Run --baseline first, or pass --no-desktop-diff explicitly "
            "if that's really what you want."
        )
        print(f"  WARNING: {msg}")
        hard.append(msg)
    else:
        baseline = json.loads(BASELINE_FILE.read_text())
        current = capture_desktop_geometry(browser, base, routes)
        diffs = diff_all_routes(baseline, current)
        print_desktop_diffs(diffs)
        hard.extend(diffs_to_failures(diffs))

    print("\n=== MOBILE AUDIT (390x844, dark + light) ===")
    audit = run_mobile_audit(browser, base, routes)
    hard.extend(audit.hard)
    warn.extend(audit.warn)
    info.extend(audit.info)
    print_mobile_report(audit)

    print("\n=== SUMMARY ===")
    print(f"hard failures: {len(hard)}")
    print(f"warnings: {len(warn)}")
    print(f"info: {len(info)}")
    print(f"\nscreenshots: {AUDIT_DIR}")

    return 1 if hard else 0


def run(args: argparse.Namespace, base: str) -> int:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            # The mock guard. Not optional, never soft — real Govee devices
            # are in someone's bedroom, and this must never be able to
            # reach them. No check runs before this passes.
            guard_ctx = browser.new_context(viewport=DESKTOP_VIEWPORT)
            gpage = guard_ctx.new_page()
            gpage.goto(base + "/", wait_until="domcontentloaded", timeout=45_000)
            is_mock = gpage.evaluate(
                "async () => (await (await fetch('/api/v1/health')).json()).mock"
            )
            if is_mock is not True:
                print(
                    "REFUSING TO RUN: the app is not talking to the mock sidecar "
                    f"(health.mock is {is_mock!r}). Real devices live in a bedroom "
                    "and this script must never be able to reach them."
                )
                return 2

            device_href = discover_device_path(gpage)
            guard_ctx.close()

            routes: list[tuple[str, str]] = [
                ("home", "/"), ("rooms", "/rooms"),
                ("schedules", "/schedules"), ("settings", "/settings"),
            ]
            missing_device: str | None = None
            if device_href:
                routes.append(("device", device_href))
            else:
                missing_device = (
                    "no visible device link found on the dashboard — the "
                    "device console route was not walked"
                )

            if args.baseline:
                return run_baseline_mode(browser, base, routes, missing_device)
            return run_check_mode(browser, base, routes, args.no_desktop_diff, missing_device)
        finally:
            browser.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--baseline", action="store_true",
        help="capture the desktop (1440x900) geometry fixture",
    )
    mode.add_argument(
        "--check", action="store_true",
        help="run the mobile defect audit, plus a desktop invariance diff",
    )
    ap.add_argument(
        "--no-desktop-diff", action="store_true",
        help="skip the desktop invariance diff (only valid with --check)",
    )
    args = ap.parse_args()

    BASELINE_FILE.parent.mkdir(parents=True, exist_ok=True)
    if args.check:
        if AUDIT_DIR.exists():
            shutil.rmtree(AUDIT_DIR)
        AUDIT_DIR.mkdir(parents=True)

    log_dir = pathlib.Path(tempfile.mkdtemp(prefix="viewport-audit-"))
    procs: list[subprocess.Popen[bytes]] = []
    try:
        print(f"starting mock stack (api :{API_PORT}, web :{WEB_PORT})...")
        procs = start_stack(log_dir)
        return run(args, base=f"http://127.0.0.1:{WEB_PORT}")
    except Failure as e:
        print(f"\nSETUP FAILED: {e}")
        for log in sorted(log_dir.glob("*.log")):
            tail = log.read_text(errors="replace").splitlines()[-25:]
            print(f"\n--- {log.name} ---\n" + "\n".join(tail))
        return 2
    finally:
        for proc in procs:
            _terminate_group(proc)


if __name__ == "__main__":
    sys.exit(main())
