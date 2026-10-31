#!/usr/bin/env bash
# No Gradle or downloaded app dependencies. Official Android build-tools + JDK only.
set -euo pipefail
cd "$(dirname "$0")"
TOOLCHAIN="${TOOLCHAIN:-/home/advait/android-toolchain}"
export JAVA_HOME="${JAVA_HOME:-$(find "$TOOLCHAIN" -maxdepth 1 -type d -name 'jdk-*' | sort | head -1)}"
export PATH="$JAVA_HOME/bin:$PATH"
SDK="${ANDROID_HOME:-$TOOLCHAIN/sdk}"
BT="$SDK/build-tools/35.0.0"
ANDROID="$SDK/platforms/android-35/android.jar"
OUT="$PWD/build"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/generated"
"$BT/aapt2" compile --dir res -o "$OUT/resources.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$ANDROID" --manifest AndroidManifest.xml --java "$OUT/generated" "$OUT/resources.zip"
find src "$OUT/generated" -name '*.java' | sort > "$OUT/sources.txt"
javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$ANDROID:$BT/core-lambda-stubs.jar" -d "$OUT/classes" @"$OUT/sources.txt"
jar cf "$OUT/classes.jar" -C "$OUT/classes" .
"$BT/d8" --min-api 26 --lib "$ANDROID" --output "$OUT/dex" "$OUT/classes.jar"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
python3 - "$OUT" <<'PYZIP'
import pathlib, sys, zipfile
out = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(out / "unsigned.apk", "a", compression=zipfile.ZIP_DEFLATED) as apk:
    for dex in sorted((out / "dex").glob("classes*.dex")):
        apk.write(dex, dex.name)
PYZIP
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
# Standard DEBUG signing key, kept outside git. Not a production identity.
KEY="$TOOLCHAIN/companion-debug.keystore"
if [[ ! -f "$KEY" ]]; then
  keytool -genkeypair -keystore "$KEY" -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Android Debug,O=Android,C=US'
  chmod 600 "$KEY"
fi
"$BT/apksigner" sign --ks "$KEY" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out "$OUT/craft-companion-debug.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify --verbose "$OUT/craft-companion-debug.apk"
sha256sum "$OUT/craft-companion-debug.apk" | tee "$OUT/SHA256SUMS"
echo "Debug APK: $OUT/craft-companion-debug.apk"
