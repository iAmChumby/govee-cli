"""One exclusive advisory file lock, on whichever platform this is running on.

`ledger.py`, `request_meter.py` and `room_scenes.py` each guard a
read-modify-write of a JSON file in ``~/.config/govee-cli/`` with an exclusive
lock on a sibling ``.lock`` file. Three independent processes write those files
— the CLI, the sidecar, and the scheduler daemon (WEBUI_V3_SPEC §10.3) — so the
lock is what keeps a concurrent write from clobbering rather than merging.

All three used ``fcntl.flock`` directly, with byte-identical two-line
call sites. That is fine on Linux, where the console actually runs, and it makes
the package **unimportable on Windows**: ``fcntl`` is POSIX-only, so
``import fcntl`` at module scope raises ``ModuleNotFoundError`` before any of
the three modules finish loading. Since ``webui/api/errors.py`` imports
``govee_cli.http`` which imports ``request_meter``, that single missing stdlib
module took down the whole sidecar — including its **mock** mode, which is what
``scripts/verify_ui.py`` boots. The visual verification pass that CLAUDE.md
calls the only real check on the 3D stage therefore could not run at all on a
Windows workstation, on a codebase whose production target is Linux.

This module is the one place that difference lives now. The POSIX path is
exactly what the three call sites did before, unchanged.

**The Windows path is equivalent, not identical**, and the difference is worth
stating rather than papering over:

- ``fcntl.flock`` takes a whole-file advisory lock and blocks indefinitely.
- ``msvcrt.locking`` takes a mandatory byte-range lock, so this locks the single
  byte at offset 0 of the lock file — nothing ever reads or writes that file's
  contents, it exists only to be locked, so a one-byte range is as good as the
  whole file.
- ``msvcrt.locking(LK_LOCK, ...)`` blocks by retrying once a second for ten
  seconds and then raises ``OSError``, where ``flock`` would wait forever. The
  writes these locks guard are microseconds long, so ten seconds is not a real
  bound in practice; and every caller already wraps its critical section in the
  never-raise contract those modules document (catch, log at WARNING, swallow),
  so exceeding it degrades to a skipped write rather than a crash. A skipped
  meter write costs a stale tally. A skipped ledger write costs the console
  its record of what was last commanded, which is worse — but it is the
  behaviour those modules already have for every other IO failure, and this
  path only runs on a platform the console is not deployed on.

**Threads are excluded in-process, before the OS lock is ever reached.**
``flock`` and ``msvcrt.locking`` both exist to keep *separate processes* from
clobbering each other, which is the real hazard here. Threads inside one
process were contending for the same OS lock too, and Windows handles that
badly: 20 threads racing for one byte range through distinct handles made the
CRT return ``EDEADLOCK`` ("Resource deadlock avoided") for half of them rather
than queueing, and every one of those writes was then swallowed by the
never-raise contract — the ledger silently lost entries under concurrency, which
is precisely the failure that module exists to prevent. A process-local
``threading.RLock`` in front means only ever one thread per process reaches the
OS primitive. That is also strictly cheaper on Linux, where threads now queue on
a userspace mutex instead of a blocking syscall.

"""

from __future__ import annotations

import os
import threading
from typing import Any

# Held as `Any` rather than as directly-imported modules on purpose. Exactly one
# of these two exists on any given platform, so a direct `import fcntl` makes the
# module unanalysable on Windows and a direct `import msvcrt` does the same on
# Linux — and mypy runs on whichever machine a developer happens to be using.
# Binding them to `Any` lets the platform check below be the single place that
# decides, and keeps the file type-clean on both, without scattering
# `# type: ignore[attr-defined]` over lines that are perfectly correct on the
# platform they actually run on.
_fcntl: Any = None
_msvcrt: Any = None

try:  # POSIX — the platform the console actually runs on.
    import fcntl as _fcntl_module

    _fcntl = _fcntl_module
except ModuleNotFoundError:  # pragma: no cover - exercised only on Windows
    pass

try:  # Windows
    import msvcrt as _msvcrt_module

    _msvcrt = _msvcrt_module
except ModuleNotFoundError:  # pragma: no cover - exercised only on POSIX
    pass

_HAVE_FCNTL = _fcntl is not None
_HAVE_MSVCRT = _msvcrt is not None


_process_lock = threading.RLock()


def lock_exclusive(fd: int) -> None:
    """Take an exclusive lock on ``fd``, blocking until it is available.

    ``fd`` is an open file descriptor for the ``.lock`` sibling file, exactly
    as the three callers already open it with ``os.open(..., O_CREAT | O_RDWR)``.

    Two layers, in order: the process-local mutex first (so sibling threads
    queue in userspace and only one of them ever reaches the OS), then the
    cross-process file lock. If the OS lock fails, the process mutex is
    released before the error propagates — otherwise a single failure would
    wedge every other thread in this process forever, converting one lost write
    into a permanent hang.
    """
    _process_lock.acquire()
    try:
        if _HAVE_FCNTL:
            _fcntl.flock(fd, _fcntl.LOCK_EX)  # blocking — writes are microseconds
        elif _HAVE_MSVCRT:
            os.lseek(fd, 0, os.SEEK_SET)
            _msvcrt.locking(fd, _msvcrt.LK_LOCK, 1)
        else:
            raise RuntimeError("no file-locking primitive available on this platform")
    except BaseException:
        _process_lock.release()
        raise


def unlock(fd: int) -> None:
    """Release the lock taken by :func:`lock_exclusive`.

    Never raises: the callers all run this from a ``finally`` block on their way
    out of a critical section, and a failure to unlock an fd that is about to be
    closed anyway (closing releases the lock on both platforms) must not mask
    whatever the critical section was actually doing.
    """
    try:
        if _HAVE_FCNTL:
            _fcntl.flock(fd, _fcntl.LOCK_UN)
        elif _HAVE_MSVCRT:
            os.lseek(fd, 0, os.SEEK_SET)
            _msvcrt.locking(fd, _msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    finally:
        # Released last and unconditionally, mirroring the acquire order in
        # `lock_exclusive`. A failed OS unlock must not strand the process
        # mutex — the fd is closed by the caller immediately after this, and
        # closing releases the OS lock on both platforms anyway.
        try:
            _process_lock.release()
        except RuntimeError:
            # Not held by this thread: `unlock` was called without a matching
            # successful `lock_exclusive`. Nothing to release, and raising here
            # would mask whatever sent us down that path.
            pass
