#!/usr/bin/env python3
"""Real PiG 0.5.3 TUI smoke with a fake CLI. No provider credentials or paid calls."""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIG = os.environ.get("BRO_HOST_TEST_BIN")
if not PIG:
    raise SystemExit("BRO_HOST_TEST_BIN is required for the actual PiG binary")

def plain(raw: bytes) -> str:
    raw = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", raw)
    raw = re.sub(rb"\x1b\][^\x07]*(?:\x07|\x1b\\)", b"", raw)
    return raw.decode("utf-8", errors="replace")

def window(fd: int, rows: int, cols: int):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

def run():
    with tempfile.TemporaryDirectory(prefix="bro-pig053-tui-") as folder:
        home = Path(folder)
        agent = home / ".pi"
        agent.mkdir()
        bins = home / "bin"
        bins.mkdir()
        backend = bins / "agy"
        backend.write_text(r"""#!/bin/sh
case "$1" in
  models) printf 'fixture-model\tFixture Model\n'; exit 0;;
  --version) printf 'agy fixture\n'; exit 0;;
esac
printf '%s\n' '{"event":"result","result":{"status":"SUCCESS","response":"BRO_PIG053_TERMINAL_RESULT"}}'
""")
        backend.chmod(0o755)
        env = dict(os.environ)
        env.update({
            "TERM": "xterm-256color",
            "PIG_HOME": str(home / ".pig"),
            "PIG_USE_PI_DIRS": "1",
            "PIG_TS_RUNTIME": "node",
            "PI_CODING_AGENT_DIR": str(agent),
            "PIG_CODING_AGENT_DIR": str(agent),
            "PI_OFFLINE": "1",
            "PATH": str(bins) + os.pathsep + env.get("PATH", ""),
        })
        argv = [PIG, "--offline", "--no-extensions", "-e", str(ROOT / "src" / "bro.ts"),
                "--no-skills", "--no-prompt-templates", "--no-context-files",
                "--no-mcp", "--no-themes"]
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(ROOT)
            os.execvpe(PIG, argv, env)
        transcript = bytearray()
        try:
            window(fd, 30, 104)
            def take(seconds: float = 0.25):
                until = time.monotonic() + seconds
                while time.monotonic() < until:
                    ready, _, _ = select.select([fd], [], [], min(0.1, until - time.monotonic()))
                    if not ready:
                        continue
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError:
                        return
                    if not chunk:
                        return
                    transcript.extend(chunk)
                    if len(transcript) > 2_000_000:
                        del transcript[:len(transcript)-1_000_000]
            def write(data: bytes):
                os.write(fd, data)
                take(0.25)
            def expect(label: str, fragments: tuple[str, ...], timeout: float = 15.0):
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    take(0.15)
                    current = plain(bytes(transcript))
                    if all(x in current for x in fragments):
                        print("PASS:", label, flush=True)
                        return
                    try:
                        exited, _status = os.waitpid(pid, os.WNOHANG)
                    except ChildProcessError:
                        exited = pid
                    if exited:
                        raise AssertionError("PiG TUI exited during " + label + ": " + current[-2400:])
                raise AssertionError("PiG TUI missing " + label + " (" +
                    ", ".join(fragments) + "); terminal tail:\n" + plain(bytes(transcript))[-3200:])
            take(2.5)
            write(b"/bro config\r")
            expect("Bro configuration modal in actual PiG terminal", ("Global", "Features"))
            window(fd, 18, 72)
            os.kill(pid, signal.SIGWINCH)
            write(b"\x1b[B")  # move selection
            write(b"\x1b")  # leave config
            write(b"/bro text Explain this synthetic input\r")
            expect("Bro backend answer in actual PiG terminal", ("BRO_PIG053_TERMINAL_RESULT",))
            write(b"\x1b")  # close explanation
            write(b"/bro remember-me\r")
            expect("Remember Me modal in actual PiG terminal", ("Your memory or correction", "No matching personal memories."))
            write(b"\x1b")
            print("PASS: resize, keyboard input and Esc did not crash the TUI", flush=True)
        finally:
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
            os.close(fd)

if __name__ == "__main__":
    run()
