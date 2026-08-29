#!/usr/bin/env bash
# Rhino jar를 받는다. 저장소에 바이너리를 넣지 않기 위해서이기도 하고,
# 버전을 바꿔가며 태블릿과 행동을 맞추는 게 이 시뮬레이터의 핵심이라서이기도 하다.
#
#   ./sim/fetch-rhino.sh          # 기본 1.7.13
#   ./sim/fetch-rhino.sh 1.7.14   # 다른 버전으로 비교
set -euo pipefail
VERSION="${1:-1.7.13}"
DIR="$(cd "$(dirname "$0")" && pwd)/lib"
mkdir -p "$DIR"
URL="https://repo1.maven.org/maven2/org/mozilla/rhino/${VERSION}/rhino-${VERSION}.jar"
echo "받는 중: $URL"
curl -sSL -o "$DIR/rhino-${VERSION}.jar" "$URL"
ls -la "$DIR"
