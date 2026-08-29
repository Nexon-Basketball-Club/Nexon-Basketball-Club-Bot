#!/usr/bin/env bash
# 봇 시뮬레이터. 진짜 Rhino로 nbcdues.js를 돌리고 답장을 낸다.
#
#   ./sim/run.sh '!미납'                        # 한 번 쳐보기
#   ./sim/run.sh '!회비 강종찬' '!게스트비 강종찬'  # 여러 개 연속
#   ./sim/run.sh --suite sim/suites/unpaid.txt --snapshot sim/snapshots/unpaid.txt
#   ./sim/run.sh --suite ... --snapshot ... --update     # 문구를 고쳤을 때 갱신
#
# 서버는 sim/config.json의 serverUrl을 그대로 탄다 — 로컬 dev 서버를 가리키게 두면
# 봇 → 서버 → DB 전 구간이 실제 코드로 돈다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"

# ── java 찾기 ─────────────────────────────────────────────
# PATH에 없으면 Adoptium 설치 위치를 뒤진다. 이 시뮬레이터 하나 때문에
# 시스템 PATH를 건드리게 하고 싶지 않다.
if command -v java >/dev/null 2>&1; then
  JAVA_BIN="$(command -v java)"; JAVAC_BIN="$(command -v javac || true)"
else
  JDK="$(ls -d "/c/Program Files/Eclipse Adoptium"/jdk-* 2>/dev/null | head -1 || true)"
  [ -n "$JDK" ] || { echo "java를 찾을 수 없습니다. JDK 17을 설치하세요." >&2; exit 1; }
  JAVA_BIN="$JDK/bin/java"; JAVAC_BIN="$JDK/bin/javac"
fi

JAR="$(ls "$HERE"/lib/rhino-*.jar 2>/dev/null | head -1 || true)"
[ -n "$JAR" ] || { echo "rhino jar가 없습니다. ./sim/fetch-rhino.sh 를 먼저 실행하세요." >&2; exit 1; }
[ -f "$HERE/config.json" ] || { echo "sim/config.json이 없습니다. sim/config.example.json을 복사하세요." >&2; exit 1; }

# 클래스패스 구분자는 Windows가 ';', 그 외가 ':'다. Git Bash에서도 java.exe는
# 네이티브 Windows 프로그램이므로 ';'를 쓴다.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) SEP=";" ;;
  *)                    SEP=":" ;;
esac

mkdir -p "$HERE/out"
if [ ! -f "$HERE/out/Sim.class" ] || [ "$HERE/Sim.java" -nt "$HERE/out/Sim.class" ]; then
  "$JAVAC_BIN" -encoding UTF-8 -cp "$JAR" -d "$HERE/out" "$HERE/Sim.java"
fi

# java.exe는 네이티브 Windows 프로그램이라 MSYS 경로(/d/Dev/...)를 못 읽는다.
# 저장소 루트로 옮겨서 전부 상대경로로 넘긴다.
cd "$ROOT"
JAR_REL="sim/lib/$(basename "$JAR")"

# --add-opens: Java 17의 모듈 시스템이 Rhino의 HttpURLConnection 리플렉션을 막는다.
# 안드로이드에는 없는 제약이므로 여는 게 오히려 태블릿에 가깝다.
exec "$JAVA_BIN" \
  --add-opens java.base/sun.net.www.protocol.http=ALL-UNNAMED \
  --add-opens java.base/java.net=ALL-UNNAMED \
  -Dfile.encoding=UTF-8 \
  -cp "${JAR_REL}${SEP}sim/out" Sim \
  --script nbcdues.js --config sim/config.json "$@"
