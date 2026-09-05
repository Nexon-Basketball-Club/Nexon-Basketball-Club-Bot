#!/usr/bin/env bash
# 전체 회귀. 각 스냅샷은 메인 저장소의 같은 이름 시나리오와 짝이다.
#
#   ./sim/test.sh                 # basic/server만 (DB 시나리오 불필요)
#   ./sim/test.sh --with-db /path/to/Nexon-Basketball-Club
#
# --with-db를 주면 시나리오를 심어가며 전부 돈다. dev 서버가 떠 있어야 한다.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MAIN=""
[ "${1:-}" = "--with-db" ] && MAIN="${2:-}"

fail=0
run() {
  "$HERE/run.sh" --suite "$HERE/suites/$1.txt" --snapshot "$HERE/snapshots/$1.txt" 2>/dev/null || fail=1
}

run basic
run server

if [ -n "$MAIN" ]; then
  # poll은 상태를 바꾸는 명령어라 시나리오 재심기가 필수다 — run()마다 심어주는
  # 이 루프 안에 있어야 결과가 결정론적이다.
  for s in unpaid-name-mismatch same-name ui-volume poll-waitlist; do
    (cd "$MAIN" && npm run db:scenario "$s" >/dev/null 2>&1) || { echo "시나리오 실패: $s"; fail=1; continue; }
    # 스위트 이름과 시나리오 이름이 다른 건 poll뿐이다.
    [ "$s" = "poll-waitlist" ] && run poll || run "$s"
  done
else
  echo "(DB 시나리오는 건너뜀 — --with-db <메인 저장소 경로> 로 전부 돌린다)"
fi

exit $fail
