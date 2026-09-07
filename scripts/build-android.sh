#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK directory}"
: "${LINUBOT_ANDROID_KEYSTORE:?Set LINUBOT_ANDROID_KEYSTORE to your private release keystore}"
: "${LINUBOT_ANDROID_STORE_PASSWORD:?Set LINUBOT_ANDROID_STORE_PASSWORD for the release keystore}"
linubot_tools="$ANDROID_HOME/build-tools/36.0.0"
android/gradlew -p android :app:testDebugUnitTest :app:assembleRelease :app:lintRelease
linubot_version=$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')
mkdir -p release
linubot_apk="release/linubot-$linubot_version-android.apk"
"$linubot_tools/zipalign" -f -p 4 android/app/build/outputs/apk/release/app-release-unsigned.apk "$linubot_apk"
"$linubot_tools/apksigner" sign --ks "$LINUBOT_ANDROID_KEYSTORE" --ks-key-alias linubot --ks-pass env:LINUBOT_ANDROID_STORE_PASSWORD --key-pass env:LINUBOT_ANDROID_STORE_PASSWORD "$linubot_apk"
"$linubot_tools/apksigner" verify --verbose --print-certs "$linubot_apk"
