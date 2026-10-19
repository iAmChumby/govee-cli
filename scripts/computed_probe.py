#!/usr/bin/env python3
"""Capture computed type/spacing for every visible element, and diff two captures.

#27 is a rename, never a repaint: the declared type/space scale may not move a
single computed value. Screenshots cannot prove that (they cannot see a 10 ms
difference and they cannot see letter-spacing at all), so this records the six
properties the brief names -- font-size, letter-spacing, padding, gap, margin --
plus line-height (a font-size utility that quietly adds one is also a repaint)
for every element with a box on the page.

    python scripts/computed_probe.py capture --base http://127.0.0.1:6456 --out before.json
    python scripts/computed_probe.py diff before.json after.json

Routes and viewports are fixed by the brief: /, /device/Shelf%20Lamp, /settings,
/schedules at 1440x900 and 390x844. The 390 context is a real touch context
(is_mobile + has_touch) so pointer-coarse: overrides are exercised; a 390px
desktop window is not the phone this app targets.

Element identity is a tag:nth-of-type chain from <html>. The migration changes
class attributes only, so the chain is stable across the two runs; a changed
chain is itself a finding (DOM structure moved), not something to paper over.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROUTES = ["/", "/device/Shelf%20Lamp", "/settings", "/schedules"]
VIEWPORTS = [
    {"name": "1440x900", "width": 1440, "height": 900, "touch": False},
    {"name": "390x844", "width": 390, "height": 844, "touch": True},
]

# Text that proves the data arrived, not just the shell. /schedules is checked
# for the owner strip because it is the last panel to settle.
READY_TEXT = {
    "/": "Shelf Lamp",
    "/device/Shelf%20Lamp": "Shelf Lamp",
    # "Settings" is in the top bar before the panels mount; the version row
    # only exists once the health/config queries have answered.
    "/settings": "sidecar version",
    "/schedules": "schedule owner",
}

CAPTURE_JS = r"""
() => {
  const props = [
    "font-size", "letter-spacing", "line-height",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "row-gap", "column-gap",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
  ];
  const out = [];
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== "HTML") {
      let i = 1;
      let s = node;
      while ((s = s.previousElementSibling)) {
        if (s.tagName === node.tagName) i++;
      }
      parts.unshift(node.tagName.toLowerCase() + ":" + i);
      node = node.parentElement;
    }
    return parts.join(">");
  };
  const all = document.querySelectorAll("body *");
  for (const el of all) {
    // data-volatile is the project's own marker for a readout driven by the
    // current time or a live latency sample. Its subtree's *shape* changes as
    // digits mount, which is not a style change; the root is still measured.
    const vol = el.closest('[data-volatile="true"]');
    if (vol && vol !== el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const rec = {
      tag: el.tagName.toLowerCase(),
      volatile: vol ? 1 : 0,
      text: el.childElementCount === 0 ? (el.textContent || "").trim().slice(0, 40) : "",
    };
    for (const p of props) rec[p] = cs.getPropertyValue(p);
    rec["@"] = pathOf(el);
    out.push(rec);
  }
  return { title: document.title, url: location.pathname, elements: out };
}
"""


def capture(base: str, out: Path) -> None:
    result = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for vp in VIEWPORTS:
            ctx = browser.new_context(
                viewport={"width": vp["width"], "height": vp["height"]},
                has_touch=vp["touch"],
                is_mobile=vp["touch"],
                device_scale_factor=1,
            )
            ctx.add_init_script("localStorage.setItem('theme', 'dark')")
            page = ctx.new_page()
            for route in ROUTES:
                # The dev server occasionally resets a keep-alive connection to
                # the scratch sidecar; the next request is fine. Retry the
                # navigation, but never retry a failed *assertion* below.
                last_err = None
                for attempt in range(3):
                    try:
                        page.goto(base + route, wait_until="networkidle", timeout=60_000)
                        last_err = None
                        break
                    except Exception as exc:  # noqa: BLE001 - retry transport only
                        last_err = exc
                        page.wait_for_timeout(1000)
                if last_err is not None:
                    raise last_err
                # Case-insensitive innerText, because the top bar's copy differs
                # between the phone and desktop layouts and a hidden element can
                # otherwise satisfy a locator while the page is still a skeleton.
                # A skeleton is not a capture: retry the whole navigation once,
                # then fail loudly rather than recording the wrong DOM.
                ready = False
                for ready_attempt in range(2):
                    try:
                        page.wait_for_function(
                            "(needle) => document.body.innerText.toLowerCase().includes(needle)",
                            arg=READY_TEXT[route].lower(),
                            timeout=25_000,
                        )
                        ready = True
                        break
                    except Exception:
                        if ready_attempt == 0:
                            page.reload(wait_until="networkidle", timeout=60_000)
                if not ready:
                    raise RuntimeError(
                        f"{route} @ {vp['name']}: ready text {READY_TEXT[route]!r} "
                        "never appeared; refusing to capture a skeleton"
                    )
                # Let polls, hydration and the 3D stage settle. None of the six
                # properties depends on animation, but a late panel does.
                page.evaluate("document.fonts.ready")
                # Health must have answered before capture: while it is in
                # flight the strip renders a budget chip it hides once mock
                # mode is known, which changes the footer's element set.
                try:
                    page.wait_for_function(
                        "() => (document.querySelector('footer')?.innerText || '').includes('MOCK')",
                        timeout=20_000,
                    )
                except Exception:
                    pass
                # A panel (or an odometer's digit columns) that mounts late
                # changes the element set, which would read as a DOM diff that
                # has nothing to do with the migration. Take two full captures
                # 1.5s apart and require identical keys and measured values
                # (text is excluded: the clock is allowed to tick).
                def signature(sample):
                    return [
                        (e["@"], tuple(v for k, v in sorted(e.items()) if k not in ("text",)))
                        for e in sample["elements"]
                    ]

                data = None
                prev = page.evaluate(CAPTURE_JS)
                for _ in range(6):
                    page.wait_for_timeout(1500)
                    cur = page.evaluate(CAPTURE_JS)
                    if signature(prev) == signature(cur):
                        data = cur
                        break
                    prev = cur
                if data is None:
                    raise RuntimeError(
                        f"{route} @ {vp['name']}: element set never held still for 1.5s"
                    )
                key = f"{route} @ {vp['name']}"
                result[key] = data
                print(f"  captured {key}: {len(data['elements'])} elements")
            ctx.close()
        browser.close()
    out.write_text(json.dumps(result, indent=1, sort_keys=True), encoding="utf-8")
    print(f"wrote {out} ({sum(len(v['elements']) for v in result.values())} element records)")


def diff(before_path: Path, after_path: Path) -> int:
    before = json.loads(before_path.read_text(encoding="utf-8"))
    after = json.loads(after_path.read_text(encoding="utf-8"))
    problems = 0
    for key in sorted(set(before) | set(after)):
        if key not in before or key not in after:
            print(f"MISSING PAGE {key}")
            problems += 1
            continue
        b = {e["@"]: e for e in before[key]["elements"]}
        a = {e["@"]: e for e in after[key]["elements"]}
        for path in sorted(set(b) | set(a)):
            if path not in b:
                print(f"ADDED   {key} {path}")
                problems += 1
                continue
            if path not in a:
                print(f"REMOVED {key} {path} {b[path].get('text', '')!r}")
                problems += 1
                continue
            # `text` is a label for the reader, not a measured property: the
            # clock, "last cycle 3s ago" and latency copy legitimately differ
            # between two runs. The six properties the brief names are compared.
            changed = [
                p for p in b[path]
                if p not in ("@", "text") and b[path][p] != a[path][p]
            ]
            if changed:
                problems += 1
                print(f"CHANGED {key} {path} {b[path].get('text', '')!r}")
                for p in changed:
                    print(f"    {p}: {b[path][p]!r} -> {a[path][p]!r}")
        print(f"{key}: {len(b)} before, {len(a)} after")
    if problems == 0:
        print("DIFF: zero differences")
        return 0
    print(f"DIFF: {problems} difference(s)")
    return 1


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    cap = sub.add_parser("capture")
    cap.add_argument("--base", required=True)
    cap.add_argument("--out", required=True, type=Path)
    dif = sub.add_parser("diff")
    dif.add_argument("before", type=Path)
    dif.add_argument("after", type=Path)
    args = ap.parse_args()
    if args.cmd == "capture":
        capture(args.base, args.out)
        return 0
    return diff(args.before, args.after)


if __name__ == "__main__":
    sys.exit(main())
