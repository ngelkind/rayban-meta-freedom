#!/usr/bin/env python3
"""Call the Stella control bridge over Frida."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import frida

from bridge import attach_target, handle_bridge_request, source_with_java_bridge


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("status", "photo", "startvideo", "stopvideo"))
    parser.add_argument("--package", default="com.facebook.stella")
    parser.add_argument("--device")
    parser.add_argument("--remote")
    args = parser.parse_args()

    if args.remote:
        device = frida.get_device_manager().add_remote_device(args.remote)
    elif args.device:
        device = frida.get_device(args.device, timeout=10)
    else:
        device = frida.get_usb_device(timeout=10)

    session = attach_target(device, args.package)
    source = Path(__file__).with_name("stella-control.js").read_text(encoding="utf-8")
    script = session.create_script(source_with_java_bridge(source), runtime="v8")
    script.on("message", lambda message, _data: handle_bridge_request(message, script))
    script.load()
    try:
        result = getattr(script.exports_sync, args.command)()
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        script.unload()
        session.detach()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
