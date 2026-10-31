#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
TOOLCHAIN="${TOOLCHAIN:-/home/advait/android-toolchain}"
export JAVA_HOME="${JAVA_HOME:-$(find "$TOOLCHAIN" -maxdepth 1 -type d -name 'jdk-*' | sort | head -1)}"
export PATH="$JAVA_HOME/bin:$PATH"
mkdir -p build/tests
javac --release 8 -d build/tests src/com/craftagents/companion/Policy.java tests/PolicyTest.java
java -cp build/tests com.craftagents.companion.PolicyTest
python3 tests/security-invariants.py
JSON="$TOOLCHAIN/test-libs/json-20240303.jar"
if [[ -f "$JSON" ]]; then
  echo '3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed  '"$JSON" | sha256sum -c -
  javac --release 8 -cp "$JSON" -d build/tests src/com/craftagents/companion/Policy.java src/com/craftagents/companion/Api.java src/com/craftagents/companion/GrantSummary.java tests/ApiTest.java tests/GrantSummaryTest.java
  java -cp "build/tests:$JSON" com.craftagents.companion.ApiTest
  java -cp "build/tests:$JSON" com.craftagents.companion.GrantSummaryTest
else
  echo 'SKIP HTTPS fixture tests: test-only org.json 20240303 JAR not installed.'
fi
