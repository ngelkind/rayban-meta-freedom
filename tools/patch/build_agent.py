"""Bundle the Android Java bridge and router into a standalone Gadget script.

The output is an APK library-named asset so Android extracts it alongside Gadget.
No key or private media enters this bundle.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from frida_tools import __file__ as frida_tools_file


BASE = Path(__file__).resolve().parent


MODULES = (
    "router.js", "config.js", "media.js", "photo-source.js", "android-photo.js",
    "android-upload.js",
    "assistant.js", "android-http.js", "android-assistant-store.js",
    "assistant-turn.js", "assistant-audio-gate.js", "assistant-replacement.js",
    "android-transcript.js", "android-system-tts.js",
    "android-reply-gate.js", "android-request-probe.js", "android-mic-probe.js",
    "android-datax-input-probe.js", "android-fixed-reply.js", "android-camera-consent.js",
    "android-vision.js",
    "android-control.js", "assistant-trace.js", "extensions.js", "agent.js",
)


def build(output: Path, config: dict[str, object] | None = None) -> dict[str, object]:
    bridge = Path(frida_tools_file).parent / "bridges" / "java.js"
    options = {"observeDatax": [], "gadgetInitOnly": False, "photoWatch": False}
    if config:
        options.update(config)
    inputs = {"java-bridge": bridge.read_bytes()}
    inputs.update({name: (BASE / name).read_bytes() for name in MODULES})
    input_hashes = {name: hashlib.sha256(value).hexdigest() for name, value in inputs.items()}
    fingerprint = hashlib.sha256(json.dumps({"inputs": input_hashes, "options": options},
        sort_keys=True).encode()).hexdigest()[:16]
    options["buildId"] = fingerprint
    sources = [
        bridge.read_text(encoding="utf-8"),
        "Object.defineProperty(globalThis, 'Java', { value: bridge });",
        "globalThis.PATCH_CONFIG = " + json.dumps(options, separators=(",", ":")) + ";",
        *(inputs[name].decode("utf-8") for name in MODULES),
    ]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(sources), encoding="utf-8")
    return {"buildId": fingerprint, "scriptSha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            "inputsSha256": input_hashes, "modules": list(MODULES)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    manifest = build(args.output)
    if args.manifest:
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        args.manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
