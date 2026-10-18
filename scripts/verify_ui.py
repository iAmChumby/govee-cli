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

    python3 scripts/verify_ui.py                   # default checks, phone + desktop
    python3 scripts/verify_ui.py --keep            # leave the screenshots for review
    python3 scripts/verify_ui.py --owner-states    # also: owner strip per GOVEE_WEBUI_MOCK_OWNER
    python3 scripts/verify_ui.py --no-location     # also: sun rules with no location set

Default checks always run. ``--owner-states`` and ``--no-location`` ADD passes
after them, each restarting only the scratch sidecar; they never replace a check.

What fails the run (exit 1): console errors, a missing page or locator, a text
assertion that is absent, a horizontal overflow, the motion check, and the
no-location assertions. What never fails the run: the 390x844 measurement pass.
It writes ``.verify-ui/measure-<route>.json`` and prints a summary for the main
agent to read, because a touch-target number is a finding to judge, not a gate.

Exit code is 0 only if every failing check passed.
"""

from __future__ import annotations

import argparse
import json
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
DESKTOP = {"width": 1440, "height": 900}
VIEWPORTS = {"phone": (IPHONE, True), "desktop": (DESKTOP, False)}

# A touch target smaller than this, on a coarse pointer, is what the measurement
# pass reports. Apple's HIG and WCAG 2.5.5 both use 44 CSS px.
MIN_TARGET = 44

OWNER_STATES = ("unset", "daemon", "stale", "nobody")

# Per state: (lower-cased text that must appear on /schedules, text that must not).
# Lower-cased to match innerText.lower(), so CSS text-transform cannot break them.
OWNER_EXPECT = {
    "unset": (["schedule owner: web console sidecar (mock, dry run"], []),
    "daemon": (["schedule owner: govee-cli daemon (pid"], []),
    "stale": (["no scheduler running", "stale since"], []),
    "nobody": (["no scheduler running"], ["stale since"]),
}
# Lines echoed to the log so the owner readout can be read per state.
OWNER_LINE_KEYS = ("schedule owner", "no scheduler running", "stale since")

# Env the mock reads at sidecar start. Every sidecar this script starts drops
# these first, so an operator's shell cannot leak a state into a default run.
MOCK_KNOBS = ("GOVEE_WEBUI_MOCK_OWNER", "GOVEE_WEBUI_MOCK_NO_LOCATION")

# Text the default /schedules page must render (default mock). Compared
# lower-cased against innerText, which is what a person sees.
SCHEDULE_TEXT = (
    "schedule owner",
    "sunset-1h",
    "room scene 'deleted scene' missing",
    "missed",
)

# Console noise that is not a defect. Keep this list short and specific; a broad
# pattern here would silently swallow the failures this script exists to catch.
IGNORED_CONSOLE = (
    "Download the React DevTools",
    "favicon.ico",
)

_HHMM = re.compile(r"\b\d{1,2}:\d{2}\b")


class Failure(Exception):
    pass


def _free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _wait_free(port: int, timeout: float = 15.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _free(port):
            return
        time.sleep(0.3)
    raise Failure(f"port {port} still in use {timeout:.0f}s after the sidecar was stopped")


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


# ---------------------------------------------------------------------------
# Cross-platform process plumbing.
#
# This script was written on Linux, where every server it starts is an ordinary
# executable on PATH and a process group can be signalled as a unit. None of
# those three assumptions holds on Windows, and each failed loudly rather than
# subtly, which is the good case: `npm` is `npm.cmd` and CreateProcess will not
# find a bare "npm"; the venv's interpreter lives in `Scripts/`, not `bin/`; and
# `os.killpg`/`start_new_session` do not exist there at all.
#
# The Linux path through all three helpers is byte-for-byte what it was.
# ---------------------------------------------------------------------------
IS_WINDOWS = os.name == "nt"


def _npm() -> str:
    """The npm launcher's real path.

    `subprocess` on Windows does not consult PATHEXT, so a bare "npm" raises
    FileNotFoundError even with npm installed and on PATH. `shutil.which` does
    consult it and returns `npm.cmd`; on Linux it returns the same `npm` the
    bare string would have resolved to.
    """
    return shutil.which("npm") or "npm"


def _python() -> str:
    """The interpreter to run the mock sidecar with.

    Prefers the project venv described in CLAUDE.md's Setup section, under
    whichever layout this platform uses, and falls back to the interpreter
    running this script — which is correct whenever the dependencies are
    importable from it, and gives a clear ImportError rather than a confusing
    missing-file error when they are not.
    """
    for candidate in (REPO / ".venv" / "bin" / "python", REPO / ".venv" / "Scripts" / "python.exe"):
        if candidate.exists():
            return str(candidate)
    return sys.executable


def _detached() -> dict:
    """Popen kwargs that make a child killable as a whole tree.

    `npm run start` execs a child next-server, and terminating npm alone
    orphans it still holding the port, which makes the next run fail to start.
    Unix gets its own session so the group can be signalled; Windows gets its
    own process group, which is what `taskkill /T` walks.
    """
    if IS_WINDOWS:
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _terminate_group(proc: subprocess.Popen[bytes]) -> None:
    """Kill the whole process tree, not just the launcher."""
    if IS_WINDOWS:
        # There is no killpg on Windows. `taskkill /T` walks the child tree
        # from a PID, which is what actually reaches the next-server npm
        # spawned; /F because next-server ignores the polite request.
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            capture_output=True, check=False,
        )
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        return
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


class Stack:
    """The scratch sidecar and web app, with the sidecar restartable on its own.

    The web app is a production build that rewrites /api to the scratch sidecar
    port, so the sidecar can be stopped and restarted under a new mock state
    without rebuilding or restarting the web app.
    """

    def __init__(self, log_dir: pathlib.Path, tz: str | None = None):
        self.log_dir = log_dir
        # --tz: the sidecar reads TZ before falling back to UTC, so a run on a
        # Windows workstation can compute schedules in the production zone.
        self.tz = tz
        self.api: subprocess.Popen[bytes] | None = None
        self.web: subprocess.Popen[bytes] | None = None

    def build(self) -> None:
        print("  building against the scratch sidecar (rewrites are baked in)...")
        build_env = {
            **os.environ,
            "GOVEE_WEBUI_API": f"http://127.0.0.1:{API_PORT}",
            "GOVEE_WEBUI_DIST_DIR": DIST_DIR,
        }
        # `next build` REWRITES next-env.d.ts to reference whatever dist dir it was
        # told to use, and this build deliberately uses a scratch one. That file is
        # tracked, so a verification run otherwise leaves the working tree dirty with
        # a change pointing the project's type references at `.next-verify` — wrong
        # for every other use of the repo, and easy to commit by accident because it
        # shows up alongside the very changes the run was verifying. Snapshot it and
        # put it back.
        next_env = APP / "next-env.d.ts"
        next_env_before = next_env.read_text(encoding="utf-8") if next_env.exists() else None
        try:
            build = subprocess.run(
                [_npm(), "run", "build"], cwd=APP, env=build_env,
                capture_output=True, text=True, timeout=900,
            )
        finally:
            if next_env_before is not None and next_env.read_text(encoding="utf-8") != next_env_before:
                next_env.write_text(next_env_before, encoding="utf-8")
        if build.returncode != 0:
            raise Failure("next build failed:\n" + build.stdout[-3000:] + build.stderr[-2000:])

    def start_api(self, name: str, extra_env: dict[str, str] | None = None) -> None:
        """(Re)start the mock sidecar. Stops the previous one first, if any."""
        if self.api is not None:
            _terminate_group(self.api)
            self.api = None
            _wait_free(API_PORT)
        elif not _free(API_PORT):
            raise Failure(f"port {API_PORT} (sidecar) is already in use")

        env = {
            **os.environ,
            "GOVEE_WEBUI_MOCK": "1",
            "GOVEE_WEBUI_PORT": str(API_PORT),
            # Fixture latency off: this asserts on rendered output, not spinners.
            "GOVEE_WEBUI_MOCK_LATENCY": "0-0",
        }
        for knob in MOCK_KNOBS:
            env.pop(knob, None)
        if self.tz:
            env["TZ"] = self.tz
        env.update(extra_env or {})
        api_log = (self.log_dir / f"sidecar-{name}.log").open("wb")
        # Its own process group so the whole tree can be stopped as a unit.
        self.api = subprocess.Popen(
            [_python(), "-m", "webui.api.main"],
            cwd=REPO, env=env, stdout=api_log, stderr=subprocess.STDOUT,
            **_detached(),
        )
        _wait_for(f"http://127.0.0.1:{API_PORT}/api/v1/health")

    def start_web(self) -> None:
        if not _free(WEB_PORT):
            raise Failure(f"port {WEB_PORT} (web) is already in use")
        web_log = (self.log_dir / "web.log").open("wb")
        # `npm run start` execs a child next-server, so the web app gets its own
        # process group — terminating npm alone would orphan it on the port.
        self.web = subprocess.Popen(
            [_npm(), "run", "start", "--", "-p", str(WEB_PORT), "-H", "127.0.0.1"],
            cwd=APP,
            env={**os.environ, "GOVEE_WEBUI_MOCK": "1", "GOVEE_WEBUI_API": f"http://127.0.0.1:{API_PORT}",
                 "GOVEE_WEBUI_DIST_DIR": DIST_DIR},
            stdout=web_log, stderr=subprocess.STDOUT,
            **_detached(),
        )
        _wait_for(f"http://127.0.0.1:{WEB_PORT}/")

    def stop_all(self) -> None:
        for proc in (self.api, self.web):
            if proc is not None:
                _terminate_group(proc)
        self.api = None
        self.web = None


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


# Measured in the page, not guessed from source. `pointer_coarse` records whether
# the coarse-pointer emulation actually took effect: without it the undersized
# list answers a different question than the one asked.
_MEASURE_JS = """() => {
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (el) => (
    el.getAttribute('aria-label') || el.getAttribute('title') ||
    el.getAttribute('placeholder') || el.getAttribute('name') ||
    (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ')
  ).slice(0, 60);
  const controls = [];
  for (const el of document.querySelectorAll('button, [role=switch], input, select, a[href]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    controls.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      label: label(el),
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      in_dialog: !!el.closest('[role=dialog]'),
      off_viewport: r.right > window.innerWidth + 1 || r.left < -1,
    });
  }
  const clipped = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (![cs.overflowX, cs.overflowY].some(v => v.includes('hidden'))) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      clipped.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className).slice(0, 80),
        text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      });
    }
  }
  return {
    pointer_coarse: window.matchMedia('(pointer: coarse)').matches,
    controls, clipped,
  };
}"""


class Checker:
    """Shared state for one run: the browser, the failures, and the shots dir."""

    def __init__(self, shots: pathlib.Path, stack: Stack):
        self.shots = shots
        self.stack = stack
        self.base = f"http://127.0.0.1:{WEB_PORT}"
        self.browser = None
        self.failures: list[str] = []
        self.console_errors: list[str] = []
        self.where = "setup"

    def fail(self, msg: str) -> None:
        self.failures.append(msg)

    def new_page(self, theme: str, vp_name: str):
        viewport, mobile = VIEWPORTS[vp_name]
        ctx = self.browser.new_context(
            viewport=viewport,
            # Phone keeps the 3x density the original pass used; desktop is 1x.
            device_scale_factor=3 if mobile else 1,
            is_mobile=mobile, has_touch=mobile,
            color_scheme=theme,
        )
        # next-themes runs with defaultTheme="dark", so color_scheme alone is
        # ignored and every "light" shot used to render dark. Seed its storage
        # key before any page script runs.
        ctx.add_init_script(f"window.localStorage.setItem('theme', '{theme}')")
        page = ctx.new_page()
        self.where = f"{theme}:{vp_name}"
        page.on("console", self._note)
        return ctx, page

    def _note(self, msg) -> None:
        if msg.type != "error":
            return
        if any(pat in msg.text for pat in IGNORED_CONSOLE):
            return
        self.console_errors.append(f"[{self.where}] {msg.text}")

    def goto(self, page, path: str) -> None:
        page.goto(self.base + path, wait_until="networkidle", timeout=45_000)
        page.wait_for_timeout(700)

    def shot(self, page, name: str, full_page: bool = False) -> None:
        page.screenshot(path=str(self.shots / name), full_page=full_page)

    def visible(self, locator, what: str, timeout: int = 8000) -> bool:
        """True if the locator shows up. Otherwise record a failure naming it."""
        try:
            locator.first.wait_for(state="visible", timeout=timeout)
            return True
        except Exception:
            self.fail(f"{what}: not found or not visible")
            return False

    def check_overflow(self, page, label: str) -> None:
        # The page itself must never scroll sideways.
        overflow = page.evaluate(
            "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
        )
        if overflow > 2:
            self.fail(f"{label} overflows horizontally by {overflow}px")

    # -- default checks -----------------------------------------------------

    def phone_pass(self, base: str, shots: pathlib.Path) -> None:
        """The original phone checks: every route in both themes, then the device and rooms flows."""
        for theme in ("dark", "light"):
            ctx, page = self.new_page(theme, "phone")
            for name, path in (("dashboard", "/"), ("schedules", "/schedules"),
                               ("rooms", "/rooms"), ("settings", "/settings")):
                self.where = f"{theme}:{name}"
                self.goto(page, path)
                page.screenshot(path=str(shots / f"{theme}-{name}.png"), full_page=True)

                # A page that renders an empty body is "working" to a build but
                # useless to a person.
                body = page.evaluate("() => document.body.innerText.trim().length")
                if body < 40:
                    self.fail(f"{theme}:{name} rendered almost no text ({body} chars)")

                self.check_overflow(page, f"{theme}:{name}")

                if theme == "dark" and name == "schedules":
                    self.schedule_text(page)

            # The device console, and the motion assertion that is the point of
            # this whole script.
            page.goto(base + "/", wait_until="networkidle", timeout=45_000)
            # Several device links exist (nav drawer, plates). Take the first
            # one a person could actually tap; a hidden nav entry is not a
            # meaningful test of the dashboard.
            link = page.locator("a[href^='/device/']:visible").first
            if link.count() == 0:
                self.fail(f"{theme}: no visible device link on the dashboard")
            else:
                link.click()
                page.wait_for_load_state("networkidle", timeout=45_000)
                page.wait_for_timeout(1200)
                page.screenshot(path=str(shots / f"{theme}-device.png"), full_page=True)

                if theme == "dark":  # assert motion once; it is theme-independent
                    self.device_motion(page, base, shots)

            ctx.close()

    def schedule_text(self, page) -> None:
        """The default mock's schedules page must show the states the mock seeds."""
        text = page.evaluate("() => document.body.innerText").lower()
        for needle in SCHEDULE_TEXT:
            if needle not in text:
                self.fail(f"/schedules (default mock) does not show {needle!r}")

    def device_motion(self, page, base: str, shots: pathlib.Path) -> None:
        # §10 T27. A clean mock has an empty ledger, so this device
        # reads "unknown" — which is exactly the state the chooser
        # exists for, and the state the older reset control can
        # never appear in. Check it here, before _apply_a_scene
        # below writes a mode and takes the device out of it.
        chooser = page.get_by_role("button", name=re.compile("what's playing", re.I))
        if chooser.count() == 0:
            self.fail(
                "no 'what's playing' chooser on a device reading unknown "
                "(T27's whole point — the reset control cannot render here)"
            )
        else:
            chooser.first.click()
            page.wait_for_timeout(700)
            page.screenshot(path=str(shots / "unknown-chooser.png"), full_page=True)
            # The copy is load-bearing: a user who believes this
            # commands the device will mis-set the ledger.
            text = page.evaluate("() => document.body.innerText")
            if "does not change" not in text and "sends nothing" not in text:
                self.fail("the chooser does not say it leaves the light alone")
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
            self.fail("could not put the mock device into a scene")
        else:
            print(f"  applied: {applied}")
            page.reload(wait_until="networkidle", timeout=45_000)
            page.wait_for_timeout(1200)
            page.screenshot(path=str(shots / "device-motion.png"), full_page=True)
        ok, detail = canvas_is_animating(page)
        if not ok:
            self.fail(f"motion engine: {detail}")
        else:
            print(f"  motion: {detail}")

        for tab in ("segments", "paint", "scenes", "diy"):
            el = page.get_by_role("tab", name=tab, exact=False)
            if el.count():
                el.first.click()
                page.wait_for_timeout(600)
                page.screenshot(path=str(shots / f"tab-{tab}.png"), full_page=True)
                break

        for msg in _rooms_flow(page, base, shots):
            self.fail(msg)

    def desktop_pass(self) -> None:
        """The three routes at 1440x900, both themes."""
        for theme in ("dark", "light"):
            ctx, page = self.new_page(theme, "desktop")
            for name, path in (("schedules", "/schedules"), ("rooms", "/rooms"), ("settings", "/settings")):
                self.where = f"{theme}:desktop:{name}"
                self.goto(page, path)
                self.shot(page, f"desktop-{theme}-{name}.png", full_page=True)
                self.check_overflow(page, f"desktop {theme}:{name}")
            ctx.close()

    # -- interaction shots ----------------------------------------------------

    def interaction_pass(self) -> None:
        """Dialogs and the settings location, phone and desktop, both themes."""
        for theme in ("dark", "light"):
            for vp in ("phone", "desktop"):
                ctx, page = self.new_page(theme, vp)
                tag = f"{theme}-{vp}"
                self.where = f"{tag}:interactions"
                self._schedules_add_dialog(page, tag)
                self._schedules_edit_sun(page, tag)
                self._rooms_authored_editor(page, tag)
                self._rooms_new_scene(page, tag)
                self._settings_location(page, tag)
                ctx.close()

    def _schedules_add_dialog(self, page, tag: str) -> None:
        self.goto(page, "/schedules")
        if not self.visible(page.get_by_role("button", name=re.compile(r"^new rule$")),
                            f"[{tag}] 'new rule' button on /schedules"):
            return
        page.get_by_role("button", name=re.compile(r"^new rule$")).first.click()
        if self.visible(page.get_by_role("dialog"), f"[{tag}] 'new rule' dialog"):
            page.wait_for_timeout(500)
            self.shot(page, f"{tag}-schedules-add-dialog.png")

    def _schedules_edit_sun(self, page, tag: str) -> None:
        self.goto(page, "/schedules")
        edit = page.get_by_role("button", name="Edit rule Evening")
        if not self.visible(edit, f"[{tag}] 'Edit rule Evening' button on /schedules"):
            return
        edit.first.click()
        dialog = page.get_by_role("dialog")
        if not self.visible(dialog, f"[{tag}] Evening edit dialog"):
            return
        # The resolved line is computed server-side; wait for it, do not guess.
        if self.visible(dialog.get_by_text(re.compile(r"Today:")),
                        f"[{tag}] resolved line 'Today:' in the Evening dialog", timeout=10000):
            page.wait_for_timeout(400)
            self.shot(page, f"{tag}-schedules-edit-sun.png")

    def _rooms_authored_editor(self, page, tag: str) -> None:
        self.goto(page, "/rooms")
        edit = page.get_by_role("button", name="Edit Evening")
        if not self.visible(edit, f"[{tag}] 'Edit Evening' button on the authored card"):
            return
        edit.first.click()
        if self.visible(page.get_by_role("dialog"), f"[{tag}] 'edit room scene' dialog"):
            page.wait_for_timeout(500)
            self.shot(page, f"{tag}-rooms-authored-editor.png")

    def _rooms_new_scene(self, page, tag: str) -> None:
        self.goto(page, "/rooms")
        btn = page.get_by_role("button", name=re.compile(r"^new scene$"))
        if not self.visible(btn, f"[{tag}] 'new scene' button on /rooms"):
            return
        btn.first.click()
        dialog = page.get_by_role("dialog")
        if not self.visible(dialog, f"[{tag}] 'new room scene' dialog"):
            return
        # One device included: the first include switch.
        switch = dialog.get_by_role("switch", name=re.compile(r"^Include"))
        if self.visible(switch, f"[{tag}] first 'Include <device>' switch in the new-scene dialog"):
            switch.first.click()
            page.wait_for_timeout(500)
            self.shot(page, f"{tag}-rooms-new-scene-one-device.png")

    def _settings_location(self, page, tag: str) -> None:
        self.goto(page, "/settings")
        anchor = page.get_by_text(re.compile(r"Sun-relative schedule times"))
        if self.visible(anchor, f"[{tag}] location section text on /settings"):
            anchor.first.scroll_into_view_if_needed()
            page.wait_for_timeout(500)
            # Viewport shot, not full_page: the app frame scrolls inside itself,
            # so full_page only captures the first viewport.
            self.shot(page, f"{tag}-settings-location.png")

    # -- measurement (findings, never a failure) --------------------------------

    def measure_pass(self) -> None:
        ctx = self.browser.new_context(
            viewport=IPHONE, device_scale_factor=2,
            is_mobile=True, has_touch=True, color_scheme="dark",
        )
        page = ctx.new_page()
        self.where = "measure"

        self.goto(page, "/schedules")
        self.measure(page, "schedules")

        self.goto(page, "/rooms")
        new_scene = page.get_by_role("button", name=re.compile(r"^new scene$"))
        if self.visible(new_scene, "measure: 'new scene' button on /rooms"):
            new_scene.first.click()
            if self.visible(page.get_by_role("dialog"), "measure: 'new room scene' dialog"):
                page.wait_for_timeout(500)
                self.measure(page, "rooms-editor")

        self.goto(page, "/settings")
        self.measure(page, "settings")
        ctx.close()

    def measure(self, page, slug: str) -> None:
        data = page.evaluate(_MEASURE_JS)
        controls = data["controls"]
        undersized = [c for c in controls if c["w"] < MIN_TARGET or c["h"] < MIN_TARGET]
        off = [c for c in controls if c["off_viewport"]]
        result = {
            "route": slug,
            "viewport": IPHONE,
            "device_scale_factor": 2,
            "is_mobile": True,
            "has_touch": True,
            "pointer_coarse": data["pointer_coarse"],
            "controls_measured": len(controls),
            "undersized_under_44px": undersized,
            "off_viewport": off,
            "clipped_text": data["clipped"],
            "controls": controls,
        }
        out = self.shots / f"measure-{slug}.json"
        out.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(
            f"  measure {slug}: {len(controls)} controls, {len(undersized)} under 44px, "
            f"{len(off)} off-viewport, {len(data['clipped'])} clipped, "
            f"pointer:coarse={'yes' if data['pointer_coarse'] else 'NO'} -> {out.name}"
        )
        if not data["pointer_coarse"]:
            print("    NOTE: coarse-pointer emulation did not match; the 44px list is not a coarse-pointer answer")
        for c in undersized[:12]:
            print(f"    {c['w']}x{c['h']} {c['tag']} {c['role']} '{c['label']}'")
        for c in data["clipped"][:12]:
            print(f"    clipped {c['tag']} scrollWidth {c['scrollWidth']} > {c['clientWidth']}: '{c['text']}'")

    # -- extra passes (restart only the sidecar) ---------------------------------

    def owner_state_pass(self) -> None:
        for state in OWNER_STATES:
            extra = None if state == "unset" else {"GOVEE_WEBUI_MOCK_OWNER": state}
            self.stack.start_api(f"owner-{state}", extra)
            must, must_not = OWNER_EXPECT[state]
            for vp in ("phone", "desktop"):
                ctx, page = self.new_page("dark", vp)
                self.where = f"owner-{state}:{vp}"
                self.goto(page, "/schedules")
                body = page.evaluate("() => document.body.innerText")
                low = body.lower()
                lines = [ln.strip() for ln in body.splitlines()
                         if any(k in ln.lower() for k in OWNER_LINE_KEYS)]
                print(f"  owner {state}/{vp}: " + (" | ".join(lines[:3]) if lines else "<no owner line>"))
                for needle in must:
                    if needle not in low:
                        self.fail(f"owner={state} at {vp}: /schedules does not show {needle!r}")
                for needle in must_not:
                    if needle in low:
                        self.fail(f"owner={state} at {vp}: /schedules shows {needle!r} but should not")
                self.shot(page, f"schedules-owner-{state}-{vp}.png")
                ctx.close()

    def no_location_pass(self) -> None:
        self.stack.start_api("no-location", {"GOVEE_WEBUI_MOCK_NO_LOCATION": "1"})
        for theme in ("dark", "light"):
            for vp in ("phone", "desktop"):
                ctx, page = self.new_page(theme, vp)
                tag = f"noloc-{theme}-{vp}"
                self.where = f"{tag}"
                self.goto(page, "/schedules")
                self.shot(page, f"{tag}-schedules.png")

                edit = page.get_by_role("button", name="Edit rule Evening")
                if self.visible(edit, f"[{tag}] 'Edit rule Evening' button"):
                    edit.first.click()
                    dialog = page.get_by_role("dialog")
                    if self.visible(dialog, f"[{tag}] Evening edit dialog"):
                        note = dialog.get_by_text(re.compile(r"No location set: sun\w* times cannot be computed"))
                        if self.visible(note, f"[{tag}] 'No location set' in the Evening dialog"):
                            text = note.first.text_content() or ""
                            if _HHMM.search(text):
                                self.fail(f"[{tag}] the no-location line shows a time: {text.strip()!r}")
                        if dialog.get_by_text(re.compile(r"Today:")).count():
                            self.fail(f"[{tag}] the Evening dialog shows a 'Today:' resolved line with no location")
                        page.wait_for_timeout(400)
                        self.shot(page, f"{tag}-evening-edit.png")
                ctx.close()

    # -- entry -------------------------------------------------------------------

    def run(self, extras: set[str]) -> None:
        self.phone_pass(self.base, self.shots)
        self.desktop_pass()
        self.interaction_pass()
        self.measure_pass()
        if "owner-states" in extras:
            self.owner_state_pass()
        if "no-location" in extras:
            self.no_location_pass()


def start_stack(log_dir: pathlib.Path, tz: str | None = None) -> list[subprocess.Popen[bytes]]:
    """The pre-Stack entry point, kept because scripts/viewport_audit.py imports it.

    Builds, boots the mock sidecar and the web app, and returns both processes
    for the caller to stop with ``_terminate_group``.
    """
    stack = Stack(log_dir, tz=tz)
    stack.build()
    stack.start_api("default")
    stack.start_web()
    return [p for p in (stack.api, stack.web) if p is not None]


def run_checks(shots: pathlib.Path, stack: Stack, extras: set[str]) -> list[str]:
    from playwright.sync_api import sync_playwright

    ck = Checker(shots, stack)

    with sync_playwright() as p:
        # Assert the browser is talking to the mock, not production. Without
        # this the whole run can silently exercise the real sidecar and the
        # real devices' state.
        guard = p.chromium.launch()
        gpage = guard.new_context().new_page()
        gpage.goto(ck.base + "/", wait_until="domcontentloaded", timeout=45_000)
        is_mock = gpage.evaluate(
            "async () => (await (await fetch('/api/v1/health')).json()).mock"
        )
        guard.close()
        if is_mock is not True:
            return [
                "the app is NOT talking to the mock sidecar (health.mock is "
                f"{is_mock!r}) — refusing to run against production data"
            ]

        ck.browser = p.chromium.launch()
        try:
            ck.run(extras)
        finally:
            ck.browser.close()

    ck.failures.extend(ck.console_errors)
    return ck.failures


def main() -> int:
    # Labels contain characters such as U+2212; a Windows cp1252 console would
    # raise UnicodeEncodeError on print() and abort the run mid-check.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(
        description="Headless browser pass over the web console against the mock sidecar.",
        epilog=(
            "--owner-states restarts ONLY the sidecar for each GOVEE_WEBUI_MOCK_OWNER value "
            f"({', '.join(OWNER_STATES)}) and shoots /schedules at phone and desktop, dark. "
            "--no-location restarts the sidecar with GOVEE_WEBUI_MOCK_NO_LOCATION=1 and shoots "
            "/schedules and the Evening edit dialog, asserting the no-location text and no HH:MM in it. "
            "Both run after the default checks, in addition to them."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--keep", action="store_true", help="keep screenshots after a pass")
    ap.add_argument(
        "--owner-states", action="store_true",
        help="add a pass: restart the sidecar per GOVEE_WEBUI_MOCK_OWNER value and shoot the owner strip",
    )
    ap.add_argument(
        "--no-location", action="store_true",
        help="add a pass: restart the sidecar with no location and check the sun-rule dialog",
    )
    ap.add_argument(
        "--tz", metavar="ZONE", default=None,
        help="set TZ=ZONE in the sidecar's environment (e.g. America/New_York), so a run on a "
             "Windows workstation computes schedules in the production zone",
    )
    args = ap.parse_args()
    extras: set[str] = set()
    if args.owner_states:
        extras.add("owner-states")
    if args.no_location:
        extras.add("no-location")

    shots = REPO / ".verify-ui"
    if shots.exists():
        shutil.rmtree(shots)
    shots.mkdir()
    log_dir = pathlib.Path(tempfile.mkdtemp(prefix="verify-ui-"))

    stack = Stack(log_dir, tz=args.tz)
    failures: list[str] = []
    try:
        print(f"starting mock stack (api :{API_PORT}, web :{WEB_PORT})...")
        stack.build()
        stack.start_api("default")
        stack.start_web()
        print("running checks...")
        failures = run_checks(shots, stack, extras)
    except Failure as e:
        print(f"\nSETUP FAILED: {e}")
        for log in sorted(log_dir.glob("*.log")):
            tail = log.read_text(errors="replace").splitlines()[-25:]
            print(f"\n--- {log.name} ---\n" + "\n".join(tail))
        return 2
    finally:
        stack.stop_all()

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
