#!/usr/bin/env python3
"""Run one or more Frida scripts and persist messages under captures/ safely."""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
import threading
from datetime import datetime, timezone
from pathlib import Path

import frida

from bridge import attach_target, handle_bridge_request, source_with_java_bridge


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser()
    p.add_argument("scripts", nargs="+", type=Path)
    p.add_argument("--package", default="com.facebook.stella")
    p.add_argument("--device", help="Frida device id; USB is used by default")
    p.add_argument("--remote", help="Frida Gadget/server endpoint, e.g. 127.0.0.1:27042")
    p.add_argument("--attach", action="store_true", help="attach instead of spawn")
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--duration", type=float, default=0, help="Stop cleanly after this many seconds; 0 waits for a signal")
    p.add_argument("--fail-on-payload-error", action="store_true",
                   help="Fail a probe when it sends a payload with an error field")
    p.add_argument("--load-timeout", type=float, default=30,
                   help="Cancel a script load that has not returned in this many seconds")
    return p


def _device(device_id: str | None, remote: str | None):
    if remote:
        return frida.get_device_manager().add_remote_device(remote)
    return frida.get_device(device_id, timeout=10) if device_id else frida.get_usb_device(timeout=10)


def main() -> int:
    args = _parser().parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    out = os.fdopen(fd, "w", encoding="utf-8", buffering=1)
    device = _device(args.device, args.remote)
    pid = None
    if args.attach:
        session = attach_target(device, args.package)
    else:
        pid = device.spawn([args.package])
        session = device.attach(pid)

    def record(script_name: str, message: dict, data: bytes | None) -> None:
        row = {
            "at": datetime.now(timezone.utc).isoformat(),
            "script": script_name,
            "message": message,
        }
        if data is not None:
            row["data_hex"] = bytes(data).hex()
        out.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")

    loaded = []
    stopped = threading.Event()
    errors = []
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    try:
        # One Java bridge owns all hooks. Separate bridge runtimes can contend
        # while instrumenting the same ART process and while being unloaded.
        sources = []
        for path in args.scripts:
            sources.append("(function () {\n" + path.read_text(encoding="utf-8") + "\n})();")
        source = source_with_java_bridge("\n".join(sources) + "\nsetInterval(function () { send({kind: 'heartbeat'}); }, 5000);")
        for name in ["capture-agent"]:
            record(name, {"type": "lifecycle", "stage": "creating"}, None)
            script = session.create_script(source, runtime="v8")
            def on_message(m, d, name=name, current=script):
                if not handle_bridge_request(m, current):
                    record(name, m, d)
                    if m.get("type") == "error":
                        errors.append(m)
                        stopped.set()
                        print(f"capture agent failed: {m.get('description', m)}", file=sys.stderr, flush=True)
                    elif (args.fail_on_payload_error and m.get("type") == "send" and
                          isinstance(m.get("payload"), dict) and m["payload"].get("error")):
                        errors.append(m)
                        stopped.set()
                        print("capture probe reported an error", file=sys.stderr, flush=True)

            script.on("message", on_message)
            script.set_log_handler(
                lambda level, text, name=name: record(
                    name, {"type": "log", "level": level, "text": text}, None
                )
            )
            cancellable = frida.Cancellable()
            watchdog = threading.Timer(args.load_timeout, cancellable.cancel)
            watchdog.daemon = True
            watchdog.start()
            try:
                with cancellable:
                    script.load()
            finally:
                watchdog.cancel()
            loaded.append(script)
            record(name, {"type": "lifecycle", "stage": "loaded"}, None)
        if pid is not None:
            device.resume(pid)
        print(f"capturing {len(args.scripts)} agents in one runtime to {args.output}; Ctrl-C stops", flush=True)
        started = time.monotonic()
        while not stopped.wait(0.5):
            if args.duration and time.monotonic() - started >= args.duration:
                break
    except KeyboardInterrupt:
        return 0
    finally:
        for script in reversed(loaded):
            try:
                record("capture-agent", {"type": "lifecycle", "stage": "unloading"}, None)
                script.unload()
                record("capture-agent", {"type": "lifecycle", "stage": "unloaded"}, None)
            except frida.InvalidOperationError:
                pass
        session.detach()
        out.close()
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
