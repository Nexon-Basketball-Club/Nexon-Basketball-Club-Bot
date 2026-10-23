# 봇 시뮬레이터

진짜 Rhino로 `nbcdues.js`를 돌린다. 태블릿에 올리기 전에 로컬에서 쳐보고, 회귀를 잡는다.

## 왜 Node가 아닌가

`const`가 루프 안에서 첫 값을 눌러앉히는 버그를 프로덕션에서야 발견했다
([mozilla/rhino#326](https://github.com/mozilla/rhino/issues/326)). Node는 ES6를 정상
처리하므로 **이 버그를 전혀 재현하지 못한다.** 엔진이 달라서 나는 문제는 그 엔진으로만
잡힌다.

메신저봇R은 `0.7.40-alpha.02` 이하에서 Rhino, `alpha.03` 이상에서 GraalJS를 쓴다.
번들된 정확한 버전은 알 수 없으므로 **행동으로 맞춘다** — 우리가 아는 버그가 여기서도
재현되면 같은 계열이라는 증거로 본다.

## 준비

```bash
./sim/fetch-rhino.sh              # rhino jar (기본 1.7.13, 커밋하지 않는다)
cp sim/config.example.json sim/config.json
```

`sim/config.json`의 `serverUrl`을 로컬 dev 서버로 둔다. 그러면 봇 → 서버 → DB 전 구간이
실제 코드로 돈다. 서버 쪽 준비는 메인 저장소의 `architecture/local-dev-environment` 참고.

```bash
# 메인 저장소에서
npm run db:up && npm run db:scenario unpaid-name-mismatch && npm run dev
```

## 쓰기

```bash
./sim/run.sh '!미납'                                    # 한 번 쳐보기
./sim/run.sh '!회비 강종찬' '!게스트비 강종찬'             # 여러 개 연속
./sim/run.sh --dm '!미납'                               # 개인톡으로
./sim/run.sh --suite sim/suites/unpaid.txt --snapshot sim/snapshots/unpaid.txt
./sim/run.sh --suite sim/suites/unpaid.txt --snapshot sim/snapshots/unpaid.txt --update
```

스냅샷은 **정확 일치**로 본다. 문구를 고치면 깨지는데, 그때 `--update`를 주면 무엇이
바뀌는지 diff를 보여주고 갱신한다. 의도한 변경인지 눈으로 확인하는 자리다.

**단, 시계에 달린 값은 가리고 비교한다** (`Sim.mask`). 마감 시각 `10/23 (금) 15:17` →
`M/D (요) HH:MM`, 남은 시간 `2시간 59분 남음` → `N 남음`, 분기 `2026 Q3 회원` → `YYYY Qn 회원`.
시나리오를 심은 시각과 오늘 날짜에 따라 바뀌는 값이라 그대로 찍으면 다음 날 깨진다 — 실제로
분기가 Q3→Q4로 넘어가자 아무것도 안 고친 `same-name`이 FAIL이 됐다. 형식은 남기므로 줄이
사라지거나 모양이 바뀌면 여전히 잡힌다. 스냅샷 없이 화면에 찍을 때는 가리지 않는다.
공지의 `마감 45분 전입니다`·`(다음 확인 10분 뒤)`는 시나리오가 고정한 값이라 가리지 않는다.

**`@room <방>`** (CLI `--room`) — 스위트를 보낼 방. 기본은 `테스트방`(= 예시 config의 `pollRoom`).
`basic`은 `@room 일반방`으로 보낸다: `!도움말`이 pollRoom에서는 투표가 있는지 서버에 묻는데,
pollRoom이 아닌 방에서는 묻지 않으므로 DB에 무슨 투표가 있든 같은 출력이 나온다.

## 엔진 옵션

```bash
./sim/run.sh --opt -1 --lang 200 '!미납'
```

`--opt -1`이 기본이다. 안드로이드는 dex라 Rhino가 클래스를 생성할 수 없어 항상
인터프리터 모드로 돈다. `--lang`은 `Context.VERSION_*` 상수(ES6 = 200).
**태블릿과 행동이 갈리면 여기부터 맞춘다.**

## 흉내내는 것

`Log` / `FileStream` / `replier` / `response()` 호출, 그리고 봇이 먼저 올리는 공지
(메인 저장소 decision 031)를 위한 `Api.replyRoom`·`Api.canReply`와 `setTimeout`/`clearTimeout`.

`java.net.URL`·`BufferedReader`·`StringBuilder`는 Rhino의 LiveConnect가 진짜로
제공하므로 손대지 않았다. HTTP 경로가 태블릿과 **같은 코드**로 돈다.

`android.widget.TextView`를 쓰는 `onCreate` 등 라이프사이클 콜백은 부르지 않는다.
설정 화면 UI라 메시지 처리와 무관하다. `onStartCompile`도 부르지 않는다.

### 공지 — 세션과 타이머

- **세션을 진짜처럼 흉내낸다.** 로드 직후엔 어느 방에도 세션이 없고, `response()`가 불린 방에만
  생긴다. 메신저봇R이 알림의 답장 버튼으로 보내기 때문이다. 세션 없는 방에 `replyRoom`하면
  `false`. 보낸 메시지는 `[→ 방이름]` 줄 아래 찍힌다
- `canReply`/`replyRoom`은 원시 `boolean`이 아니라 **`Boolean` 객체**를 돌려준다. 태블릿이 어느
  쪽을 주는지 몰라서 까다로운 쪽으로 돌린다 — 객체면 `!ok`가 항상 false다
- **`setTimeout`은 기다리지 않는다.** 예약만 받아두고 스위트의 `@tick` 줄이 발화시킨다. 그 뒤에
  남은 예약 간격을 `(다음 확인 10분 뒤)`로 찍는다 — 서버가 준 `nextCheckMs`가 맞는지 보는 자리다
- **`@persist`** (CLI `--persist`) — 스크립트를 한 번만 로드하고 줄마다 이어 쓴다. 기본은 줄마다
  새로 로드하는데, 공지는 "세션 없어 보류 → 메시지가 와서 발송"처럼 줄 사이에 상태가 이어진다

```bash
./sim/run.sh --persist '@tick' '안녕하세요' '@tick'
```

## 이 시뮬레이터가 진짜인지 어떻게 아나

메신저봇R이 번들한 Rhino 버전은 알 수 없다. 그래서 **버전 번호가 아니라 행동으로**
맞춘다 — 우리가 아는 버그가 여기서도 재현되면 같은 계열로 본다.

`const` 버전(`63e2f7f`)을 넣고 돌리면 프로덕션에서 본 증상이 그대로 나온다.

```
$ ./sim/run.sh --script <const-version.js> '!미납'
> !미납
게스트비 미납
4명 · 총 30,000원

강종찬 (M-90001)  1건  10,000
강종찬 (M-90001)  1건  10,000
강종찬 (M-90001)  1건  10,000
강종찬 (M-90001)  1건  10,000
```

미납자 넷이 전부 첫 사람으로 찍힌다. `var`로 고친 현재 버전은 넷을 각각 낸다.
**엔진을 바꿨을 때 이 재현이 깨지면 그 엔진은 태블릿과 다른 것이다.**

## 스냅샷과 DB 상태

스냅샷은 전부 커밋한다. **suite 이름이 메인 저장소의 시나리오 이름과 같다.**

| suite | 짝이 되는 시나리오 |
|---|---|
| `basic` | (없음 — 서버·DB 무관) |
| `server` | (없음 — 서버만 떠 있으면 됨) |
| `unpaid-name-mismatch` | `npm run db:scenario unpaid-name-mismatch` |
| `same-name` | `npm run db:scenario same-name` |
| `ui-volume` | `npm run db:scenario ui-volume` |
| `poll` | `npm run db:scenario poll-waitlist` (이름이 다르다) |
| `poll-just-closed` | `npm run db:scenario poll-just-closed` |
| `poll-options` | `npm run db:scenario poll-options` |
| `notice-closed` | `npm run db:scenario poll-just-closed` — 마감 공지 (`poll-just-closed`보다 먼저) |
| `notice-reminder` | `npm run db:scenario poll-closing-soon` — 마감 전 알림 |

시나리오는 명부 없이 자기 픽스처를 결정론적으로 만들기 때문에(`M-9` 대역) 누구든 같은
출력을 재현한다. 전부 한 번에 돌리려면:

```bash
./sim/test.sh                                            # basic/server만
./sim/test.sh --with-db /path/to/Nexon-Basketball-Club   # 시나리오를 심어가며 전부
```
