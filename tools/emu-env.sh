#!/usr/bin/env bash
# Source this to get the emulator/adb/bumble toolchain on PATH.
#   source tools/emu-env.sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$HOME/.local/bin:$PATH"

# Boot the RE emulator headless:
#   emulator -avd rayban_re -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect &
#   adb wait-for-device && adb root
# AVD: rayban_re  (android-35, google_apis, arm64-v8a, userdebug -> adb root works)
