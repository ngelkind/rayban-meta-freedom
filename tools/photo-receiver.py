"""Minimal photo destination for testing the proxy's HTTP upload.

Saves each POST body under --out and prints the proxy headers. Accepts raw
image bodies and multipart/form-data. --fail N answers 503 to the first N
requests, to exercise the proxy's retry path.

    .venv/bin/python tools/photo-receiver.py --port 8799 --out /tmp/received
    # emulator destination URL: http://10.0.2.2:8799/upload
"""

from __future__ import annotations

import argparse
import email.parser
import email.policy
import hashlib
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 40 * 1024 * 1024
CAPTURE_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")


def multipart_file(content_type: str, body: bytes) -> tuple[bytes, dict[str, str]]:
    message = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
        b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body)
    image, fields = b"", {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if part.get_filename():
            image = part.get_payload(decode=True)
        else:
            fields[name] = part.get_content().strip()
    return image, fields


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1",
                        help="127.0.0.1 serves the emulator; use a LAN address for a phone")
    parser.add_argument("--port", type=int, default=8799)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--fail", type=int, default=0, help="answer 503 to the first N requests")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    state = {"failures_left": args.fail, "lock": threading.Lock()}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY:
                print(json.dumps({"answer": 413, "reason": "invalid body length"}), flush=True)
                self.send_error(413)
                return
            body = self.rfile.read(length)
            capture = self.headers.get("X-Rayban-Capture-Id", "unknown")
            if not CAPTURE_ID.fullmatch(capture) or self.headers.get("Idempotency-Key") != capture:
                print(json.dumps({"answer": 400, "reason": "invalid capture or idempotency header",
                                  "capture_length": len(capture)}), flush=True)
                self.send_error(400)
                return
            record = {"at": time.strftime("%H:%M:%S"), "path": self.path, "capture": capture,
                      "capturedAt": self.headers.get("X-Rayban-Captured-At"),
                      "idempotencyKey": self.headers.get("Idempotency-Key"),
                      "contentType": self.headers.get("Content-Type"), "bytes": length}
            with state["lock"]:
                should_fail = state["failures_left"] > 0
                if should_fail:
                    state["failures_left"] -= 1
            if should_fail:
                record["answer"] = 503
                print(json.dumps(record), flush=True)
                self.send_error(503)
                return
            content_type = self.headers.get("Content-Type", "")
            if content_type.startswith("multipart/form-data"):
                image, record["fields"] = multipart_file(content_type, body)
            else:
                image = body
            record["imageBytes"] = len(image)
            record["imageSha256"] = hashlib.sha256(image).hexdigest()[:16]
            target = args.out / f"{capture}.bin"
            with state["lock"]:
                record["duplicate"] = target.exists()
                if not record["duplicate"]:
                    with target.open("xb") as saved:
                        saved.write(image)
            record["answer"] = 200
            print(json.dumps(record), flush=True)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

        def do_GET(self) -> None:
            prefix = "/receipts/"
            capture = self.path[len(prefix):] if self.path.startswith(prefix) else ""
            if not CAPTURE_ID.fullmatch(capture):
                self.send_error(400)
                return
            target = args.out / f"{capture}.bin"
            status = 200 if target.is_file() else 404
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"received": status == 200}).encode())

        def log_message(self, *_: object) -> None:
            pass

    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
