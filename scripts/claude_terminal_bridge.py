#!/usr/bin/env python3
import argparse
import json
import os
import pty
import selectors
import socket
import subprocess
import sys
import termios
import threading
import tty
import urllib.error
import urllib.request
from pathlib import Path


def post_json(url: str, headers: dict[str, str], payload: dict) -> None:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5):
            return
    except urllib.error.URLError:
        return


def build_headers(config: dict) -> dict[str, str]:
    headers: dict[str, str] = {}
    if config.get("supervisor_token"):
        headers["X-AgentPulse-Supervisor-Token"] = str(config["supervisor_token"])
    elif config.get("api_key"):
        headers["Authorization"] = f"Bearer {config['api_key']}"
    return headers


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    with open(args.config, "r", encoding="utf-8") as handle:
        config = json.load(handle)

    socket_path = config["socket_path"]
    session_id = config["session_id"]
    supervisor_id = config["supervisor_id"]
    server_url = str(config["server_url"]).rstrip("/")
    headers = build_headers(config)

    events_url = f"{server_url}/api/v1/supervisors/{supervisor_id}/managed-sessions/{session_id}/events"
    state_url = f"{server_url}/api/v1/supervisors/{supervisor_id}/managed-session-state"

    Path(socket_path).parent.mkdir(parents=True, exist_ok=True)
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

    running = True
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin, selectors.EVENT_READ, "stdin")
    selector.register(master_fd, selectors.EVENT_READ, "pty")

    post_json(
        state_url,
        headers,
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
        post_json(
            events_url,
            headers,
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
    post_json(
        state_url,
        headers,
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
    post_json(
        events_url,
        headers,
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
