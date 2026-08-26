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
import signal
import pathlib
import re
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

# Next compiles `rewrites` into the routes manifest at BUILD time, so pointing
# the app at the scratch sidecar means building with GOVEE_WEBUI_API set — and
# building into a separate dist dir so this never overwrites the .next that
# govee-webui.service is serving.
DIST_DIR = ".next-verify"

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
    build_env = {
        **os.environ,
        "GOVEE_WEBUI_API": f"http://127.0.0.1:{API_PORT}",
        "GOVEE_WEBUI_DIST_DIR": DIST_DIR,
    }
    print("  building against the scratch sidecar (rewrites are baked in)...")
    build = subprocess.run(
        ["npm", "run", "build"], cwd=APP, env=build_env,
        capture_output=True, text=True, timeout=900,
    )
    if build.returncode != 0:
        raise Failure("next build failed:\n" + build.stdout[-3000:] + build.stderr[-2000:])

    api_log = (log_dir / "sidecar.log").open("wb")
    # start_new_session so each server becomes its own process group leader:
    # `npm run start` execs a child next-server, and terminating npm alone
    # orphans it holding the port, which makes the next run fail to start.
    api = subprocess.Popen(
        [str(REPO / ".venv" / "bin" / "python"), "-m", "webui.api.main"],
        cwd=REPO, env=env, stdout=api_log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    _wait_for(f"http://127.0.0.1:{API_PORT}/api/v1/health")

    web_log = (log_dir / "web.log").open("wb")
    web = subprocess.Popen(
        ["npm", "run", "start", "--", "-p", str(WEB_PORT), "-H", "127.0.0.1"],
        cwd=APP,
        env={**env, "GOVEE_WEBUI_API": f"http://127.0.0.1:{API_PORT}",
             "GOVEE_WEBUI_DIST_DIR": DIST_DIR},
        stdout=web_log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    _wait_for(f"http://127.0.0.1:{WEB_PORT}/")
    return [api, web]


def _terminate_group(proc: subprocess.Popen[bytes]) -> None:
    """Kill the whole process group, not just the launcher."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()


def canvas_is_animating(page, selector: str = "canvas") -> tuple[bool, str]:
    """True when the instrument's pixels differ across a one-second gap.

    Screenshots the canvas ELEMENT, not the page, so a CSS animation on some
    unrelated element still cannot be mistaken for the render doing its job —
    the original reason this reads the canvas rather than the viewport.

    It used to call ``toDataURL()``, which was right for Canvas2D and is wrong
    for WebGL: the drawing buffer is cleared once it has been composited, so
    ``toDataURL`` returns a blank image unless the context was created with
    ``preserveDrawingBuffer: true``. Two blanks compare equal, so this check
    would have reported "nothing is animating" about a lamp that was animating
    perfectly. The tempting fix is that context flag — but it makes every frame
    on the phone pay for a test, so the gate changed instead of the renderer.
    An element screenshot reads the composited result and costs the app nothing.
    """
    locator = page.locator(selector).first
    if locator.count() == 0:
        return False, "no canvas element found"
    try:
        first = locator.screenshot()
        page.wait_for_timeout(1000)
        second = locator.screenshot()
    except Exception as e:  # a zero-size or detached canvas cannot be shot
        return False, f"could not screenshot the canvas: {e}"
    if first == second:
        return False, "canvas pixels identical after 1s — nothing is animating"
    return True, f"pixels changed ({len(first)} -> {len(second)} bytes of PNG)"


def _apply_a_scene(page) -> str | None:
    """Apply the first DIY scene the device offers, through the app's own API."""
    return page.evaluate("""async () => {
      const path = location.pathname.split('/');
      const ref = decodeURIComponent(path[path.length - 1]);
      const list = await (await fetch(`/api/v1/devices/${encodeURIComponent(ref)}/diy`)).json();
      const first = (list.diy || list.scenes || [])[0];
      if (!first) return null;
      const r = await fetch(`/api/v1/devices/${encodeURIComponent(ref)}/diy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: first.name }),
      });
      return r.ok ? first.name : null;
    }""")


def _rooms_flow(page, base: str, shots: pathlib.Path) -> list[str]:
    """§10 T28 — capture a room scene, see the card, restore it, read the result.

    Worth exercising end to end rather than trusting the build, because the
    capture response is the one place a client/server contract mismatch would
    surface: TypeScript casts responses rather than validating them, so a field
    the route never sends is `undefined` at runtime and the compiler is silent.
    A shape bug here reads as a blank card, not a type error.
    """
    out: list[str] = []
    page.goto(base + "/rooms", wait_until="networkidle", timeout=45_000)
    page.wait_for_timeout(600)

    capture = page.get_by_role("button", name=re.compile("capture", re.I))
    if capture.count() == 0:
        return ["no capture control on /rooms"]
    capture.first.click()
    page.wait_for_timeout(500)

    field = page.locator("input[type='text'], input:not([type])").first
    if field.count() == 0:
        return ["capture dialog has no name field"]
    field.fill("Verify Scene")
    page.screenshot(path=str(shots / "rooms-capture.png"), full_page=True)

    submit = page.get_by_role("button", name=re.compile("^(capture|save)", re.I)).last
    submit.click()
    page.wait_for_timeout(1600)
    page.screenshot(path=str(shots / "rooms-captured.png"), full_page=True)

    # Every mock device has an empty ledger, so the capture is entirely
    # unknown — and the dialog is supposed to say so BEFORE the user relies
    # on it. A capture that reported nothing here would be the honesty bug.
    after = page.evaluate("() => document.body.innerText")
    if "unknown" not in after.lower():
        out.append("capture result never mentions the unknown devices it captured")

    for key in ("Escape",):
        page.keyboard.press(key)
    page.wait_for_timeout(700)
    page.goto(base + "/rooms", wait_until="networkidle", timeout=45_000)
    page.wait_for_timeout(800)
    page.screenshot(path=str(shots / "rooms-list.png"), full_page=True)

    if "Verify Scene" not in page.evaluate("() => document.body.innerText"):
        out.append("the captured scene does not appear in the rooms list")
        return out

    restore = page.get_by_role("button", name=re.compile("restore", re.I))
    if restore.count() == 0:
        out.append("no restore control on a saved room scene")
        return out
    restore.first.click()
    page.wait_for_timeout(2000)
    page.screenshot(path=str(shots / "rooms-restored.png"), full_page=True)

    # Every device in this scene was captured unknown, so every one of them
    # must be SKIPPED with a reason rather than restored to a guess.
    result = page.evaluate("() => document.body.innerText").lower()
    if "skip" not in result and "unknown" not in result:
        out.append(
            "restoring an all-unknown scene reported no skips — it either "
            "guessed at modes it never captured, or swallowed the reason"
        )
    return out


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
        # Assert the browser is talking to the mock, not production. Without
        # this the whole run can silently exercise the real sidecar and the
        # real devices' state.
        guard = p.chromium.launch()
        gpage = guard.new_context().new_page()
        gpage.goto(base + "/", wait_until="domcontentloaded", timeout=45_000)
        is_mock = gpage.evaluate(
            "async () => (await (await fetch('/api/v1/health')).json()).mock"
        )
        guard.close()
        if is_mock is not True:
            return [
                "the app is NOT talking to the mock sidecar (health.mock is "
                f"{is_mock!r}) — refusing to run against production data"
            ]

        browser = p.chromium.launch()
        for theme in ("dark", "light"):
            ctx = browser.new_context(
                viewport=IPHONE, device_scale_factor=3,
                is_mobile=True, has_touch=True,
                color_scheme=theme,
            )
            page = ctx.new_page()

            routes = [("dashboard", "/"), ("schedules", "/schedules"),
                      ("rooms", "/rooms"), ("settings", "/settings")]
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
            # Several device links exist (nav drawer, plates). Take the first
            # one a person could actually tap; a hidden nav entry is not a
            # meaningful test of the dashboard.
            link = page.locator("a[href^='/device/']:visible").first
            if link.count() == 0:
                failures.append(f"{theme}: no visible device link on the dashboard")
            else:
                link.click()
                page.wait_for_load_state("networkidle", timeout=45_000)
                page.wait_for_timeout(1200)
                page.screenshot(path=str(shots / f"{theme}-device.png"), full_page=True)

                if theme == "dark":  # assert motion once; it is theme-independent
                    # §10 T27. A clean mock has an empty ledger, so this device
                    # reads "unknown" — which is exactly the state the chooser
                    # exists for, and the state the older reset control can
                    # never appear in. Check it here, before _apply_a_scene
                    # below writes a mode and takes the device out of it.
                    chooser = page.get_by_role(
                        "button", name=re.compile("what's playing", re.I)
                    )
                    if chooser.count() == 0:
                        failures.append(
                            "no 'what's playing' chooser on a device reading unknown "
                            "(T27's whole point — the reset control cannot render here)"
                        )
                    else:
                        chooser.first.click()
                        page.wait_for_timeout(700)
                        page.screenshot(
                            path=str(shots / "unknown-chooser.png"), full_page=True
                        )
                        # The copy is load-bearing: a user who believes this
                        # commands the device will mis-set the ledger.
                        text = page.evaluate("() => document.body.innerText")
                        if "does not change" not in text and "sends nothing" not in text:
                            failures.append(
                                "the chooser does not say it leaves the light alone"
                            )
                        page.keyboard.press("Escape")
                        page.wait_for_timeout(400)

                    # Put the device into a real motion mode first. On a clean
                    # mock the ledger is empty, so every device reads "unknown"
                    # and the stage correctly renders NO motion — asserting on
                    # that state would test the wrong thing (and an earlier
                    # version of this script only appeared to pass because it
                    # was accidentally driving the production sidecar, whose
                    # lamp really was mid-scene).
                    applied = _apply_a_scene(page)
                    if applied is None:
                        failures.append("could not put the mock device into a scene")
                    else:
                        print(f"  applied: {applied}")
                        page.reload(wait_until="networkidle", timeout=45_000)
                        page.wait_for_timeout(1200)
                        page.screenshot(
                            path=str(shots / "device-motion.png"), full_page=True
                        )
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

                if theme == "dark":
                    failures.extend(_rooms_flow(page, base, shots))

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
            _terminate_group(proc)

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
