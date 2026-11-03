#!/usr/bin/env python3
import argparse
import datetime
import json
import os
import pty
import selectors
import signal
import socket
import stat
import subprocess
import sys
import termios
import threading
import time
import tty
import uuid
from pathlib import Path

# This bridge opens no network connection and holds no credential. Everything it would report goes into
# `reports/` next to its config as one private file per report; the supervisor that launched it reads
# that directory and sends the reports through its own report gate, which applies the user's exclude
# rules. The only socket here is the local control socket the supervisor writes prompts to.

SPOOL_MAX_FILES = 2000
SPOOL_MAX_BYTES = 8 * 1024 * 1024
SEQ_WIDTH = 16
PID_TOUCH_SECONDS = 30


def utc_now_iso() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


class PidFile:
    """`bridge.pid`: tells the supervisor this bridge is alive. Written at start, touched from the main loop
    (not a helper thread, so a wedged loop stops looking alive), removed on exit and on the signals a closing
    terminal sends."""

    def __init__(self, path: str, interval: float = PID_TOUCH_SECONDS) -> None:
        self.path = path
        self.interval = interval
        self._last = time.monotonic()

    def write(self) -> None:
        try:
            fd = os.open(
                self.path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600
            )
            try:
                os.write(fd, json.dumps({"pid": os.getpid()}).encode("utf-8"))
            finally:
                os.close(fd)
        except OSError:
            pass
        self._last = time.monotonic()

    def touch_if_due(self, now: float) -> bool:
        if now - self._last < self.interval:
            return False
        self._last = now
        try:
            os.utime(self.path)
        except OSError:
            pass
        return True

    def remove(self) -> None:
        try:
            os.unlink(self.path)
        except OSError:
            pass


def resolve_nonce(config: dict, warn=None) -> str:
    """The launch nonce from the config, or "" with one warning on stderr: a config written by an older
    supervisor has none, and every report this bridge spools would then be rejected as stale."""
    nonce = config.get("launchNonce")
    if isinstance(nonce, str) and nonce:
        return nonce
    message = (
        "agentpulse bridge: bridge.json has no launchNonce, so the supervisor will not accept this "
        "terminal's reports; restart the AgentPulse supervisor and launch a new session."
    )
    if warn is None:
        print(message, file=sys.stderr)
    else:
        warn(message)
    return ""


def hidden_input(fd: int) -> bool:
    """Whether what is typed is a secret being read: echo off while the terminal is in line mode (getpass,
    sudo, ssh). A full-screen program in raw mode also turns echo off, but it is not line mode, so its
    prompts are still captured. If the terminal can't be asked, input is assumed visible."""
    try:
        lflag = termios.tcgetattr(fd)[3]
    except termios.error:
        return False
    return not (lflag & termios.ECHO) and bool(lflag & termios.ICANON)


class ReportSpool:
    """Writes each report as `reports/<16-digit seq>.json`, best effort.

    A write that fails for any reason (no space, a read-only directory, a planted entry in the way, a
    full spool) is counted in `lost_total` and recorded in `reports/lost`; it never raises, so the
    terminal session and its child are never affected. `spool` is safe to call from several threads.
    """

    def __init__(self, directory: str, nonce: str) -> None:
        self.directory = directory
        self.nonce = nonce
        self.lost_total = 0
        self._lock = threading.Lock()
        self._seq = 1
        self._usable = False
        # How many report files and bytes the directory holds, counted once at start and kept as this
        # process adds to it. The supervisor deletes what it has sent, so before a count says "full" it
        # is taken again from the directory; a spool that is really full costs a scan, a healthy one none.
        self._files = 0
        self._bytes = 0
        try:
            try:
                os.mkdir(directory, 0o700)
            except FileExistsError:
                pass
            info = os.lstat(directory)
            self._usable = (
                stat.S_ISDIR(info.st_mode)
                and not stat.S_ISLNK(info.st_mode)
                and info.st_uid == os.getuid()
                and (info.st_mode & 0o077) == 0
            )
            if self._usable:
                self._seq = self._next_seq()
                self._recount()
        except OSError:
            self._usable = False

    def _entries(self) -> list:
        names = []
        with os.scandir(self.directory) as scan:
            for entry in scan:
                if not entry.name.startswith(".") and entry.name.endswith(".json"):
                    names.append(entry)
        return names

    def _next_seq(self) -> int:
        highest = 0
        for entry in self._entries():
            stem = entry.name[: -len(".json")]
            if stem.isdigit():
                highest = max(highest, int(stem))
        return highest + 1

    def _recount(self) -> None:
        files = 0
        size = 0
        for entry in self._entries():
            files += 1
            try:
                size += entry.stat(follow_symlinks=False).st_size
            except OSError:
                pass
        self._files = files
        self._bytes = size

    def _check_room(self, incoming: int) -> None:
        if self._files >= SPOOL_MAX_FILES or self._bytes + incoming > SPOOL_MAX_BYTES:
            self._recount()
        if self._files >= SPOOL_MAX_FILES or self._bytes + incoming > SPOOL_MAX_BYTES:
            raise OSError("spool is full")

    def _record_loss(self) -> None:
        self.lost_total += 1
        if not self._usable:
            # The directory isn't ours to write into (a link, another owner): nothing is written there.
            return
        try:
            temp = os.path.join(self.directory, ".tmp-lost")
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            try:
                os.write(fd, json.dumps({"v": 1, "lostTotal": self.lost_total}).encode("utf-8"))
            finally:
                os.close(fd)
            os.rename(temp, os.path.join(self.directory, "lost"))
        except Exception:
            pass

    def spool(self, kind: str, body: dict) -> None:
        with self._lock:
            seq = self._seq
            self._seq += 1
            try:
                if not self._usable:
                    raise OSError("spool unavailable")
                envelope = {
                    "v": 1,
                    "nonce": self.nonce,
                    "kind": kind,
                    "occurredAt": utc_now_iso(),
                    "body": body,
                }
                if kind == "events":
                    envelope["deliveryId"] = str(uuid.uuid4())
                data = json.dumps(envelope).encode("utf-8")
                self._check_room(len(data))
                temp = os.path.join(self.directory, f".tmp-{seq:0{SEQ_WIDTH}d}")
                final = os.path.join(self.directory, f"{seq:0{SEQ_WIDTH}d}.json")
                # O_EXCL: if anything is at the temp path (a stale file, a planted entry) the open fails
                # and nothing of ours is touched.
                fd = os.open(
                    temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
                )
                try:
                    view = memoryview(data)
                    while view:
                        written = os.write(fd, view)
                        view = view[written:]
                    os.fsync(fd)
                except BaseException:
                    os.close(fd)
                    try:
                        os.unlink(temp)
                    except OSError:
                        pass
                    raise
                os.close(fd)
                try:
                    os.rename(temp, final)
                except OSError:
                    try:
                        os.unlink(temp)
                    except OSError:
                        pass
                    raise
                self._files += 1
                self._bytes += len(data)
            except Exception:
                self._record_loss()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    with open(args.config, "r", encoding="utf-8") as handle:
        config = json.load(handle)

    socket_path = config["socket_path"]
    session_id = config["session_id"]
    control_dir = str(Path(socket_path).parent)
    pid_path = os.path.join(control_dir, "bridge.pid")

    Path(socket_path).parent.mkdir(parents=True, exist_ok=True)
    # The launch nonce only lets the supervisor tell a report written for this launch from a stale file
    # left in the directory by an earlier one. It is not a secret and not a security control.
    spool = ReportSpool(os.path.join(control_dir, "reports"), resolve_nonce(config))
    try:
        os.unlink(socket_path)
    except FileNotFoundError:
        pass

    master_fd, slave_fd = pty.openpty()
    child = subprocess.Popen(
        config["command"],
        cwd=config["cwd"],
        env={**os.environ, **config.get("env", {})},
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
    )
    os.close(slave_fd)

    pid_file = PidFile(pid_path)

    def on_signal(signum, _frame) -> None:
        pid_file.remove()
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)

    def remove_liveness_markers() -> None:
        pid_file.remove()
        try:
            os.unlink(socket_path)
        except FileNotFoundError:
            pass

    pid_file.write()
    signal.signal(signal.SIGHUP, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    running = True
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin, selectors.EVENT_READ, "stdin")
    selector.register(master_fd, selectors.EVENT_READ, "pty")

    spool.spool(
        "state",
        {
            "sessionId": session_id,
            "status": "active",
            "managedState": "interactive_terminal",
            "providerSessionId": session_id,
            "correlationSource": "launch_correlation_id",
            "metadata": {
                "launchMode": "interactive_terminal",
                "interactiveBridge": {
                    "socketPath": socket_path,
                    "bridgePid": os.getpid(),
                    "childPid": child.pid,
                },
            },
        },
    )

    def post_prompt_event(prompt: str, source: str) -> None:
        clean = prompt.strip()
        if not clean:
            return
        spool.spool(
            "events",
            {
                "events": [
                    {
                        "eventType": "InteractivePromptObserved",
                        "category": "prompt",
                        "content": clean,
                        "rawPayload": {"source": source},
                    }
                ]
            },
        )

    def socket_loop() -> None:
        nonlocal running
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(socket_path)
        os.chmod(socket_path, 0o600)
        server.listen()
        server.settimeout(1.0)
        while running:
            try:
                conn, _ = server.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            with conn:
                data = b""
                while True:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    data += chunk
                prompt = data.decode("utf-8", errors="ignore").strip()
                if prompt:
                    os.write(master_fd, prompt.encode("utf-8") + b"\r")
                    post_prompt_event(prompt, "agentpulse_workspace")
        server.close()

    socket_thread = threading.Thread(target=socket_loop, daemon=True)
    socket_thread.start()

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    old_tty = termios.tcgetattr(stdin_fd)
    tty.setraw(stdin_fd)
    typed_buffer = ""

    try:
        while True:
            pid_file.touch_if_due(time.monotonic())
            if child.poll() is not None:
                try:
                    remaining = os.read(master_fd, 4096)
                    if remaining:
                        os.write(stdout_fd, remaining)
                except OSError:
                    pass
                break

            for key, _ in selector.select(timeout=0.1):
                if key.data == "stdin":
                    data = os.read(stdin_fd, 4096)
                    if not data:
                        continue
                    os.write(master_fd, data)
                    if hidden_input(master_fd):
                        # A password or other secret is being typed: forward it, keep none of it.
                        typed_buffer = ""
                        continue
                    for char in data.decode("utf-8", errors="ignore"):
                        if char in ("\r", "\n"):
                            if typed_buffer.strip():
                                post_prompt_event(typed_buffer, "host_terminal")
                            typed_buffer = ""
                        elif char in ("\x7f", "\b"):
                            typed_buffer = typed_buffer[:-1]
                        elif char.isprintable():
                            typed_buffer += char
                else:
                    try:
                        output = os.read(master_fd, 4096)
                    except OSError:
                        # Linux raises EIO on the pty master once the child has gone, where macOS returns
                        # end of file: either way the session is over, and the final reports follow.
                        break
                    if not output:
                        break
                    os.write(stdout_fd, output)
    except BaseException:
        # No final reports will follow an unexpected failure: the markers must not outlive it.
        remove_liveness_markers()
        raise
    finally:
        running = False
        try:
            termios.tcsetattr(stdin_fd, termios.TCSADRAIN, old_tty)
        except termios.error:
            pass
        try:
            selector.close()
        except Exception:
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass

    exit_code = child.wait()
    try:
        _spool_final_reports(spool, session_id, socket_path, child, exit_code)
    finally:
        # The markers that say the bridge is alive go last: the supervisor drops a directory whose bridge
        # is gone and whose reports/ is empty, so the final reports must already be on disk.
        remove_liveness_markers()
    return exit_code


def _spool_final_reports(spool, session_id, socket_path, child, exit_code) -> None:
    spool.spool(
        "state",
        {
            "sessionId": session_id,
            "status": "completed" if exit_code == 0 else "failed",
            "managedState": "completed" if exit_code == 0 else "failed",
            "providerSessionId": session_id,
            "correlationSource": "launch_correlation_id",
            "metadata": {
                "launchMode": "interactive_terminal",
                "interactiveBridge": {
                    "socketPath": socket_path,
                    "bridgePid": os.getpid(),
                    "childPid": child.pid,
                },
                "exitCode": exit_code,
            },
        },
    )
    spool.spool(
        "events",
        {
            "events": [
                {
                    "eventType": "InteractiveSessionEnded",
                    "category": "system_event",
                    "content": "Interactive Claude terminal session ended.",
                    "rawPayload": {"exitCode": exit_code, "source": "terminal_bridge"},
                }
            ]
        },
    )


if __name__ == "__main__":
    raise SystemExit(main())
