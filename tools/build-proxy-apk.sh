#!/bin/sh
# Build in a disposable clone, preserving the known-good decoded baseline.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
SDK_ROOT=${ANDROID_HOME:-"$HOME/Library/Android/sdk"}
BUILD_TOOLS=${JOB_RAYBAN_BUILD_TOOLS:-"$SDK_ROOT/build-tools/36.0.0"}
JAVA_BIN=${JOB_RAYBAN_JAVA_BIN:-/opt/homebrew/opt/openjdk/bin}
BASE="$ROOT/captures/repack/base.frida.work"
OUTPUT="$ROOT/captures/repack/base.proxy.apk"
MANIFEST="$ROOT/captures/repack/base.proxy.manifest.json"
KEYSTORE="$ROOT/captures/repack/research.keystore"

export PATH="$JAVA_BIN:$BUILD_TOOLS:$PATH"
test -d "$BASE"
test -f "$BASE/lib/arm64-v8a/libfridagadget.so"
test -f "$KEYSTORE"
test -x "$ROOT/.venv/bin/python"

STAGE=$(mktemp -d "$ROOT/captures/repack/proxy-stage.XXXXXXXX")
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
cp -cR "$BASE" "$STAGE/work"
LIB="$STAGE/work/lib/arm64-v8a"
# The research worktree has two Gadget startup paths. Keep the explicit
# Application.loadLibrary path; LD_PRELOAD through wrap.sh can start a second
# Gadget instance before Android attaches the app process.
rm -f "$LIB/wrap.sh"

# Bundle only the framework-TTS helper class. The separate test Activity,
# receiver and service are deliberately excluded, so no white UI can launch.
sh "$ROOT/tools/tts-test-app/build.sh" >/dev/null
apktool d -f -o "$STAGE/tts" "$ROOT/captures/tts-test.apk" >/dev/null
TTS_DEST="$STAGE/work/smali_classes11/dev/raybanfreedom/ttstest"
mkdir -p "$TTS_DEST"
cp "$STAGE/tts/smali/dev/raybanfreedom/ttstest/HeadlessSpeaker"*.smali "$TTS_DEST/"

"$ROOT/.venv/bin/python" "$ROOT/tools/patch/build_agent.py" \
  "$LIB/libfridagadget.script.so" --manifest "$STAGE/manifest.json"
cat > "$LIB/libfridagadget.config.so" <<'EOF'
{"interaction":{"type":"script","path":"libfridagadget.script.so","on_change":"ignore"}}
EOF

apktool b "$STAGE/work" -o "$STAGE/rebuilt.apk" >/dev/null
zipalign -f -p 4 "$STAGE/rebuilt.apk" "$STAGE/aligned.apk"
apksigner sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias rayban-research --out "$STAGE/signed.apk" "$STAGE/aligned.apk"
apksigner verify "$STAGE/signed.apk"

"$ROOT/.venv/bin/python" - "$STAGE/signed.apk" "$STAGE/manifest.json" "$BASE/lib/arm64-v8a/libfridagadget.so" "$ROOT" <<'PY'
import hashlib, json, subprocess, sys, zipfile
from pathlib import Path
apk, manifest_path, gadget, root = map(Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text())
with zipfile.ZipFile(apk) as archive:
    script = archive.read('lib/arm64-v8a/libfridagadget.script.so')
    embedded_gadget = archive.read('lib/arm64-v8a/libfridagadget.so')
    if 'lib/arm64-v8a/wrap.sh' in archive.namelist():
        raise SystemExit('Gadget startup wrapper unexpectedly packaged')
if hashlib.sha256(script).hexdigest() != manifest['scriptSha256']:
    raise SystemExit('packaged script differs from source build')
if hashlib.sha256(embedded_gadget).hexdigest() != hashlib.sha256(gadget.read_bytes()).hexdigest():
    raise SystemExit('packaged Gadget differs from baseline')
for marker in (b'class PhotoSource', b'RaybanAndroidPhoto', b'class AssistantRouter', b'buildId',
               b'RaybanConfig', b'RaybanAndroidUpload', b'RaybanProxyControlReceiver',
               b'RaybanAndroidSystemTts'):
    if marker not in script:
        raise SystemExit('missing bundled module: ' + repr(marker))
manifest['apkSha256'] = hashlib.sha256(apk.read_bytes()).hexdigest()
manifest['gadgetSha256'] = hashlib.sha256(embedded_gadget).hexdigest()
for label, relative in {
    'originalBase': 'apk/stella-289.0.0.25.162/base.apk',
    'originalSplit': 'apk/stella-289.0.0.25.162/split_config.arm64_v8a.apk',
    'researchBase': 'captures/repack/base.frida.apk',
    'researchSplit': 'captures/repack/split_config.arm64_v8a.apk',
}.items():
    source = root / relative
    if source.exists():
        manifest[label + 'Sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
def signer(path):
    output = subprocess.check_output(['apksigner', 'verify', '--print-certs', str(path)], text=True)
    for line in output.splitlines():
        if 'certificate SHA-256 digest:' in line:
            return line.rsplit(':', 1)[1].strip().lower()
    raise SystemExit('signing certificate missing')
manifest['signerSha256'] = signer(apk)
if manifest['signerSha256'] != signer(root / 'captures/repack/base.frida.apk'):
    raise SystemExit('signing certificate differs from research APK')
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
PY

mv "$STAGE/signed.apk" "$OUTPUT"
mv "$STAGE/manifest.json" "$MANIFEST"
echo "Built $OUTPUT; no device was changed"
