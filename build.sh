#!/bin/bash
# QGen Android 构建脚本（在设备上直接构建，无需 Gradle）
set -e
PREFIX=${PREFIX:-/data/data/com.termux/files/usr}
export PATH="${JDK_BIN:-$PREFIX/lib/jvm/java-17-openjdk/bin}:$PREFIX/bin:$PATH"
JARS=${JARS:-$PREFIX/share/java}
: "${ANDROID_JAR:?请设置 ANDROID_JAR（Android platform 的 android.jar，例如 $ANDROID_HOME/platforms/android-35/android.jar）}"
: "${KEYSTORE:?请设置 KEYSTORE（签名用 keystore 路径）}"
AJAR="$ANDROID_JAR"
OUT=${1:-build/qgen-android.apk}
rm -rf build && mkdir -p build/gen build/classes build/dex

echo "[1/5] 编译资源"
rm -rf build/assets && cp -r assets build/assets
mkdir -p build/assets/mcp
cp mcp/server.js build/assets/mcp/server.js
cp assets/ui/qsp.js build/assets/mcp/qsp.js
aapt2 compile --dir res -o build/res.zip

echo "[2/5] 链接 APK"
aapt2 link -o build/app-unsigned.apk -I "$AJAR" --manifest AndroidManifest.xml \
  -R build/res.zip --java build/gen -A build/assets \
  --min-sdk-version 26 --target-sdk-version 34 --auto-add-overlay

echo "[3/5] 编译 Java"
find java build/gen -name '*.java' > build/sources.txt
javac -source 8 -target 8 -bootclasspath "$AJAR" -d build/classes @build/sources.txt 2>build/javac.log || { cat build/javac.log; exit 1; }

echo "[4/5] Dex"
find build/classes -name '*.class' > build/classes.txt
java -cp "$JARS/d8.jar" com.android.tools.r8.D8 --lib "$AJAR" --min-api 26 \
  --release --output build/dex @build/classes.txt

echo "[5/5] 打包 + 签名"
python3 - <<'PY'
import zipfile, shutil
src='build/app-unsigned.apk'; dst='build/app-unsigned2.apk'
shutil.copy(src, dst)
with zipfile.ZipFile(dst,'a') as z:
    z.write('build/dex/classes.dex','classes.dex', compress_type=zipfile.ZIP_STORED)
PY
KS="$KEYSTORE"
java -jar "$JARS/apksigner.jar" sign --ks "$KS" --ks-pass "${KS_PASS:-pass:android}" --key-pass "${KS_PASS:-pass:android}" \
  --v1-signing-enabled true --v2-signing-enabled true --out "$OUT" build/app-unsigned2.apk
java -jar "$JARS/apksigner.jar" verify "$OUT" >/dev/null && echo "  签名校验通过"
ls -l "$OUT"
