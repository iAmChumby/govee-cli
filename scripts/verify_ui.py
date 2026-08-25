#!/usr/bin/env python3
"""Drive the web console in a headless browser and prove it works.

Why this exists: the console's whole job is visual, and the person who would
otherwise have to check it is usually asleep or holding a phone in another room.
"It builds" says nothing about whether the lamp on screen is moving. This walks
every route at an iPhone viewport, fails on any console error, and — the part
that matters — samples the instrument canvas twice a second apart to assert the
pixels actually changed, because a motion engine that silently renders one static
frame passes every other check in the project.

Runs entirely against ``GOVEE_WEBUI_MOCK=1`` on its own ports, so it never
touches the real devices or the running production services.

    python3 scripts/verify_ui.py                 # headless, writes screenshots
    python3 scripts/verify_ui.py --keep          # leave the screenshots for review

Exit code is 0 only if every check passed.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent
APP = REPO / "webui" / "app"

# Deliberately not 6056/6057: the production services are running on those and
# this must never be mistaken for — or interfere with — the live console.
API_PORT = 6157
WEB_PORT = 6156

IPHONE = {"width": 390, "height": 844}

# Console noise that is not a defect. Keep this list short and specific; a broad
# pattern here would silently swallow the failures this script exists to catch.
IGNORED_CONSOLE = (
    "Download the React DevTools",
    "favicon.ico",
)


class Failure(Exception):
    pass


def _free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _wait_for(url: str, timeout: float = 120.0) -> None:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                if r.status < 500:
                    return
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            last = str(e)
        time.sleep(0.5)
    raise Failure(f"{url} never became ready ({last})")


def start_stack(log_dir: pathlib.Path) -> list[subprocess.Popen[bytes]]:
    """Boot a mock sidecar and a production Next build on the scratch ports."""
    for port, what in ((API_PORT, "sidecar"), (WEB_PORT, "web")):
        if not _free(port):
            raise Failure(f"port {port} ({what}) is already in use")

    env = {
        **os.environ,
        "GOVEE_WEBUI_MOCK": "1",
        "GOVEE_WEBUI_PORT": str(API_PORT),
        # Fixture latency off: this asserts on rendered output, not spinners.
        "GOVEE_WEBUI_MOCK_LATENCY": "0-0",
    }
    api_log = (log_dir / "sidecar.log").open("wb")
    api = subprocess.Popen(
        [str(REPO / ".venv" / "bin" / "python"), "-m", "webui.api.main"],
        cwd=REPO, env=env, stdout=api_log, stderr=subprocess.STDOUT,
    )
    _wait_for(f"http://127.0.0.1:{API_PORT}/api/v1/health")

    web_log = (log_dir / "web.log").open("wb")
    web = subprocess.Popen(
        ["npm", "run", "start", "--", "-p", str(WEB_PORT), "-H", "127.0.0.1"],
        cwd=APP,
        env={**env, "GOVEE_WEBUI_API": f"http://127.0.0.1:{API_PORT}"},
        stdout=web_log, stderr=subprocess.STDOUT,
    )
    _wait_for(f"http://127.0.0.1:{WEB_PORT}/")
    return [api, web]


def canvas_is_animating(page, selector: str = "canvas") -> tuple[bool, str]:
    """True when the instrument's pixels differ across a one-second gap.

    Reads the canvas back with toDataURL rather than screenshotting the page, so
    a CSS animation on some unrelated element cannot be mistaken for the motion
    engine doing its job.
    """
    js = """(sel) => {
      const c = document.querySelector(sel);
      if (!c) return null;
      try { return c.toDataURL(); } catch (e) { return 'ERR:' + e.message; }
    }"""
    first = page.evaluate(js, selector)
    if first is None:
        return False, "no canvas element found"
    if isinstance(first, str) and first.startswith("ERR:"):
        return False, first
    page.wait_for_timeout(1000)
    second = page.evaluate(js, selector)
    if first == second:
        return False, "canvas pixels identical after 1s — nothing is animating"
    return True, f"pixels changed ({len(first)} -> {len(second)} bytes of data URL)"


def run_checks(shots: pathlib.Path, keep: bool) -> list[str]:
    from playwright.sync_api import sync_playwright

    failures: list[str] = []
    console_errors: list[str] = []

    def note(page_name: str):
        def handler(msg):
            if msg.type != "error":
                return
            text = msg.text
            if any(pat in text for pat in IGNORED_CONSOLE):
                return
            console_errors.append(f"[{page_name}] {text}")
        return handler

    base = f"http://127.0.0.1:{WEB_PORT}"

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for theme in ("dark", "light"):
            ctx = browser.new_context(
                viewport=IPHONE, device_scale_factor=3,
                is_mobile=True, has_touch=True,
                color_scheme=theme,
            )
            page = ctx.new_page()

            routes = [("dashboard", "/"), ("schedules", "/schedules"), ("settings", "/settings")]
            for name, path in routes:
                page.on("console", note(f"{theme}:{name}"))
                page.goto(base + path, wait_until="networkidle", timeout=45_000)
                page.wait_for_timeout(700)
                page.screenshot(path=str(shots / f"{theme}-{name}.png"), full_page=True)

                # A page that renders an empty body is "working" to a build but
                # useless to a person.
                body = page.evaluate("() => document.body.innerText.trim().length")
                if body < 40:
                    failures.append(f"{theme}:{name} rendered almost no text ({body} chars)")

                # The page itself must never scroll sideways on a phone.
                overflow = page.evaluate(
                    "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
                )
                if overflow > 2:
                    failures.append(f"{theme}:{name} overflows horizontally by {overflow}px")

            # The device console, and the motion assertion that is the point of
            # this whole script.
            page.goto(base + "/", wait_until="networkidle", timeout=45_000)
            link = page.locator("a[href^='/device/']").first
            if link.count() == 0:
                failures.append(f"{theme}: no device link on the dashboard")
            else:
                link.click()
                page.wait_for_load_state("networkidle", timeout=45_000)
                page.wait_for_timeout(1200)
                page.screenshot(path=str(shots / f"{theme}-device.png"), full_page=True)

                if theme == "dark":  # assert motion once; it is theme-independent
                    ok, detail = canvas_is_animating(page)
                    if not ok:
                        failures.append(f"motion engine: {detail}")
                    else:
                        print(f"  motion: {detail}")

                    for tab in ("segments", "paint", "scenes", "diy"):
                        el = page.get_by_role("tab", name=tab, exact=False)
                        if el.count():
                            el.first.click()
                            page.wait_for_timeout(600)
                            page.screenshot(path=str(shots / f"tab-{tab}.png"), full_page=True)
                            break

            ctx.close()
        browser.close()

    failures.extend(console_errors)
    return failures


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="keep screenshots after a pass")
    args = ap.parse_args()

    shots = REPO / ".verify-ui"
    if shots.exists():
        shutil.rmtree(shots)
    shots.mkdir()
    log_dir = pathlib.Path(tempfile.mkdtemp(prefix="verify-ui-"))

    procs: list[subprocess.Popen[bytes]] = []
    try:
        print(f"starting mock stack (api :{API_PORT}, web :{WEB_PORT})...")
        procs = start_stack(log_dir)
        print("running checks...")
        failures = run_checks(shots, args.keep)
    except Failure as e:
        print(f"\nSETUP FAILED: {e}")
        for log in sorted(log_dir.glob("*.log")):
            tail = log.read_text(errors="replace").splitlines()[-25:]
            print(f"\n--- {log.name} ---\n" + "\n".join(tail))
        return 2
    finally:
        for proc in procs:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()

    if failures:
        print(f"\n{len(failures)} PROBLEM(S):")
        for f in failures:
            print(f"  - {f}")
        print(f"\nscreenshots: {shots}")
        return 1

    print(f"\nall checks passed. screenshots: {shots}")
    if not args.keep:
        print("(pass --keep to stop these being mentioned as throwaway)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
