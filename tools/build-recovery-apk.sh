#!/bin/sh
# Build a data-preserving recovery APK without starting Frida Gadget.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
SDK_ROOT=${ANDROID_HOME:-"$HOME/Library/Android/sdk"}
BUILD_TOOLS=${JOB_RAYBAN_BUILD_TOOLS:-"$SDK_ROOT/build-tools/36.0.0"}
JAVA_BIN=${JOB_RAYBAN_JAVA_BIN:-/opt/homebrew/opt/openjdk/bin}
BASE="$ROOT/captures/repack/base.frida.work"
OUTPUT="$ROOT/captures/repack/base.recovery.apk"
KEYSTORE="$ROOT/captures/repack/research.keystore"

export PATH="$JAVA_BIN:$BUILD_TOOLS:$PATH"
test -d "$BASE"
test -f "$KEYSTORE"
STAGE=$(mktemp -d "$ROOT/captures/repack/recovery-stage.XXXXXXXX")
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
cp -cR "$BASE" "$STAGE/work"

"${ROOT}/.venv/bin/python" - "$STAGE/work" <<'PY'
from pathlib import Path
import sys

work = Path(sys.argv[1])
source = work / "smali/com/facebook/stella/app/StellaApplication.smali"
text = source.read_text()
injected = (
    '    const-string v0, "fridagadget"\n\n'
    '    invoke-static {v0}, Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V\n\n'
)
if text.count(injected) != 1:
    raise SystemExit("expected exactly one Gadget startup load")
source.write_text(text.replace(injected, "", 1))
for name in ("libfridagadget.so", "libfridagadget.script.so", "libfridagadget.config.so", "wrap.sh"):
    (work / "lib/arm64-v8a" / name).unlink(missing_ok=True)
PY

apktool b "$STAGE/work" -o "$STAGE/rebuilt.apk" >/dev/null
zipalign -f -p 4 "$STAGE/rebuilt.apk" "$STAGE/aligned.apk"
apksigner sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias rayban-research --out "$STAGE/signed.apk" "$STAGE/aligned.apk"
apksigner verify "$STAGE/signed.apk"

"${ROOT}/.venv/bin/python" - "$STAGE/signed.apk" "$ROOT/captures/repack/base.frida.apk" <<'PY'
import subprocess
import sys
import zipfile
from pathlib import Path

recovery, research = map(Path, sys.argv[1:])
with zipfile.ZipFile(recovery) as archive:
    if any("fridagadget" in name.lower() or name.endswith("/wrap.sh")
           for name in archive.namelist()):
        raise SystemExit("recovery APK still contains Gadget or its startup wrapper")
def signer(path):
    lines = subprocess.check_output(
        ["apksigner", "verify", "--print-certs", str(path)], text=True
    ).splitlines()
    return next(line.rsplit(":", 1)[1].strip() for line in lines
                if "certificate SHA-256 digest:" in line)
if signer(recovery) != signer(research):
    raise SystemExit("recovery APK signing certificate differs")
PY

mv "$STAGE/signed.apk" "$OUTPUT"
echo "Built $OUTPUT; no device was changed"
