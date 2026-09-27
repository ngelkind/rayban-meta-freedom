#!/bin/sh
# Build a locally signed Stella + Frida Gadget split set for no-root research.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
SDK_ROOT=${ANDROID_HOME:-"$HOME/Library/Android/sdk"}
BUILD_TOOLS=${JOB_RAYBAN_BUILD_TOOLS:-"$SDK_ROOT/build-tools/36.0.0"}
JAVA_BIN=${JOB_RAYBAN_JAVA_BIN:-/opt/homebrew/opt/openjdk/bin}
VERSION=stella-289.0.0.25.162
SOURCE="$ROOT/apk/$VERSION"
OUTPUT="$ROOT/captures/repack"
KEYSTORE="$OUTPUT/research.keystore"
FRIDA_APK="$ROOT/.venv/bin/frida-apk"
GADGET=${JOB_RAYBAN_FRIDA_GADGET:-"$HOME/.objection/android/arm64-v8a/libfrida-gadget.so"}
APKTOOL=${JOB_RAYBAN_APKTOOL:-apktool}
WORK="$OUTPUT/base.frida.work"
APPLICATION_SMALI="$WORK/smali/com/facebook/stella/app/StellaApplication.smali"

export PATH="$JAVA_BIN:$BUILD_TOOLS:$PATH"
mkdir -p "$OUTPUT"
chmod 700 "$OUTPUT"

test -x "$FRIDA_APK"
test -f "$GADGET"
test -f "$SOURCE/base.apk"
test -f "$SOURCE/split_config.arm64_v8a.apk"
command -v "$APKTOOL" >/dev/null

"$FRIDA_APK" -g "$GADGET" -o "$OUTPUT/base.frida.unaligned.apk" "$SOURCE/base.apk"
rm -rf "$WORK"
"$APKTOOL" d -f -o "$WORK" "$OUTPUT/base.frida.unaligned.apk" >/dev/null
# Keep the helper library extractable for Android builds that support wrap.sh.
perl -0pi -e 's/android:extractNativeLibs="false"/android:extractNativeLibs="true"/' \
  "$WORK/AndroidManifest.xml"
grep -q 'android:extractNativeLibs="true"' "$WORK/AndroidManifest.xml"
# Android 16 ignores wrap.sh for this split APK. Load the injected helper
# directly in StellaApplication before the app initializes.
test -f "$APPLICATION_SMALI"
perl -0pi -e 's{(\.method public static constructor <clinit>\(\)V\n\s*\.locals \d+\n)}{$1\n    const-string v0, "fridagadget"\n\n    invoke-static {v0}, Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V\n} or die "could not patch StellaApplication"' \
  "$APPLICATION_SMALI"
"$APKTOOL" b "$WORK" -o "$OUTPUT/base.frida.rebuilt.apk" >/dev/null
zipalign -f -p 4 "$OUTPUT/base.frida.rebuilt.apk" "$OUTPUT/base.frida.apk"
cp "$SOURCE/split_config.arm64_v8a.apk" "$OUTPUT/split_config.arm64_v8a.apk"

if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android \
    -alias rayban-research -keyalg RSA -keysize 2048 -validity 10000 \
    -dname 'CN=Rayban Research,O=Local,C=IL' >/dev/null 2>&1
fi
chmod 600 "$KEYSTORE"

for apk in "$OUTPUT/base.frida.apk" "$OUTPUT/split_config.arm64_v8a.apk"; do
  apksigner sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
    --ks-key-alias rayban-research "$apk"
  apksigner verify "$apk"
done

echo "Built signed split set in $OUTPUT"
