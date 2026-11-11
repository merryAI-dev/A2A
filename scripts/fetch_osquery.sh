#!/usr/bin/env bash
# osquery 실행 파일을 data/osquery/ 에 받는다(맥). 엔진의 기기 조회(app/device/)가 여기서 찾는다.
#
#   ./scripts/fetch_osquery.sh
#
# 공식 릴리스(github.com/osquery/osquery)에서 받아 SHA-256과 서명(Developer ID 3522FA9PXF)을 확인한다.
# 시스템에는 아무것도 설치하지 않는다 — 지우려면 data/osquery/ 폴더를 지우면 된다.
# 버전을 올릴 때는 VERSION과 SHA256을 함께 바꾼다. 라이선스: Apache-2.0 (사본을 같이 받아 둔다).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="5.24.1"
SHA256="318c722ac8a968e8bbdce2c325542e61a8bb1448dbaa374e4fe2f4048d357b3d"   # osquery-${VERSION}_1.macos_arm64.tar.gz (유니버설 바이너리)
TEAM="3522FA9PXF"
[[ "$(uname)" == "Darwin" ]] || { echo "맥 전용입니다(윈도는 아직 받지 않습니다)"; exit 1; }
DEST="data/osquery"
EXE="$DEST/osquery.app/Contents/MacOS/osqueryd"
if [[ -x "$EXE" ]] && "$EXE" -S --version 2>/dev/null | grep -q "$VERSION"; then
  echo "✓ osquery $VERSION 이 이미 있습니다 ($EXE)"; exit 0
fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/osquery/osquery/releases/download/$VERSION/osquery-${VERSION}_1.macos_arm64.tar.gz"
echo "▸ 받는 중: $URL"
curl -fsSL -o "$TMP/osquery.tar.gz" "$URL"
echo "$SHA256  $TMP/osquery.tar.gz" | shasum -a 256 -c - >/dev/null || { echo "✕ SHA-256이 다릅니다 — 받은 파일을 쓰지 않습니다"; exit 1; }
tar -xzf "$TMP/osquery.tar.gz" -C "$TMP" opt/osquery/lib/osquery.app
BIN="$TMP/opt/osquery/lib/osquery.app/Contents/MacOS/osqueryd"
codesign --verify --strict "$BIN"
SIGN="$(codesign -dv "$BIN" 2>&1)"
[[ "$SIGN" == *"TeamIdentifier=$TEAM"* ]] || { echo "✕ 서명한 곳이 osquery 재단이 아닙니다"; exit 1; }
# 앱 묶음째로 둔다 — 실행 파일만 떼어 내면 서명이 묶음(Info.plist)과 어긋난다
rm -rf "$DEST/osquery.app"; mkdir -p "$DEST"
cp -R "$TMP/opt/osquery/lib/osquery.app" "$DEST/osquery.app"
curl -fsSL -o "$DEST/LICENSE-Apache-2.0" "https://raw.githubusercontent.com/osquery/osquery/$VERSION/LICENSE-Apache-2.0"
"$EXE" -S --version
echo "✓ $EXE"
