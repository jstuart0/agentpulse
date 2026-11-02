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

    def _check_room(self) -> None:
        count = 0
        size = 0
        for entry in self._entries():
            count += 1
            try:
                size += entry.stat(follow_symlinks=False).st_size
            except OSError:
                pass
        if count >= SPOOL_MAX_FILES or size >= SPOOL_MAX_BYTES:
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
                self._check_room()
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
    spool = ReportSpool(
        os.path.join(control_dir, "reports"), str(config.get("launchNonce") or "")
    )
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

    # Tells the supervisor this bridge is alive: written now, touched from the socket thread, removed on
    # exit and on the signals a closing terminal sends.
    def write_pid_file() -> None:
        try:
            fd = os.open(
                pid_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600
            )
            try:
                os.write(fd, json.dumps({"pid": os.getpid()}).encode("utf-8"))
            finally:
                os.close(fd)
        except OSError:
            pass

    def remove_pid_file() -> None:
        try:
            os.unlink(pid_path)
        except OSError:
            pass

    def on_signal(signum, _frame) -> None:
        remove_pid_file()
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)

    write_pid_file()
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
        last_touch = time.monotonic()
        while running:
            if time.monotonic() - last_touch >= PID_TOUCH_SECONDS:
                last_touch = time.monotonic()
                try:
                    os.utime(pid_path)
                except OSError:
                    pass
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
                    output = os.read(master_fd, 4096)
                    if not output:
                        break
                    os.write(stdout_fd, output)
    finally:
        running = False
        remove_pid_file()
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
        try:
            os.unlink(socket_path)
        except FileNotFoundError:
            pass

    exit_code = child.wait()
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
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
