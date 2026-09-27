#!/bin/sh
# Build a separate fixed-phrase Android TTS probe; does not modify Stella.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
SDK=${ANDROID_HOME:-"$HOME/Library/Android/sdk"}
BUILD="$SDK/build-tools/36.0.0"
ANDROID_JAR="$SDK/platforms/android-36/android.jar"
JAVA_BIN=${JOB_RAYBAN_JAVA_BIN:-/opt/homebrew/opt/openjdk/bin}
export PATH="$JAVA_BIN:$BUILD:$PATH"
STAGE=$(mktemp -d "$ROOT/captures/tts-stage.XXXXXXXX")
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
mkdir -p "$STAGE/classes" "$STAGE/dex"
"$JAVA_BIN/javac" -source 8 -target 8 -classpath "$ANDROID_JAR" \
  -d "$STAGE/classes" "$ROOT/tools/tts-test-app/src/dev/raybanfreedom/ttstest/"*.java
"$JAVA_BIN/jar" --create --file "$STAGE/classes.jar" -C "$STAGE/classes" .
"$BUILD/d8" --lib "$ANDROID_JAR" --min-api 26 --output "$STAGE/dex" \
  "$STAGE/classes.jar"
"$BUILD/aapt2" link --manifest "$ROOT/tools/tts-test-app/AndroidManifest.xml" \
  -I "$ANDROID_JAR" -o "$STAGE/unsigned.apk"
(cd "$STAGE/dex" && zip -q "$STAGE/unsigned.apk" classes.dex)
"$BUILD/zipalign" -f 4 "$STAGE/unsigned.apk" "$STAGE/aligned.apk"
"$BUILD/apksigner" sign --ks "$ROOT/captures/repack/research.keystore" \
  --ks-pass pass:android --key-pass pass:android --ks-key-alias rayban-research \
  --out "$ROOT/captures/tts-test.apk" "$STAGE/aligned.apk"
"$BUILD/apksigner" verify "$ROOT/captures/tts-test.apk"
echo "Built captures/tts-test.apk; no device was changed"
