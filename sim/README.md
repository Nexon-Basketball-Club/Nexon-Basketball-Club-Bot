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

## 엔진 옵션

```bash
./sim/run.sh --opt -1 --lang 200 '!미납'
```

`--opt -1`이 기본이다. 안드로이드는 dex라 Rhino가 클래스를 생성할 수 없어 항상
인터프리터 모드로 돈다. `--lang`은 `Context.VERSION_*` 상수(ES6 = 200).
**태블릿과 행동이 갈리면 여기부터 맞춘다.**

## 흉내내는 것

`Log` / `FileStream` / `replier` / `response()` 호출. 이 넷뿐이다.

`java.net.URL`·`BufferedReader`·`StringBuilder`는 Rhino의 LiveConnect가 진짜로
제공하므로 손대지 않았다. HTTP 경로가 태블릿과 **같은 코드**로 돈다.

`android.widget.TextView`를 쓰는 `onCreate` 등 라이프사이클 콜백은 부르지 않는다.
설정 화면 UI라 메시지 처리와 무관하다.

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

`sim/snapshots/basic.txt`만 저장소에 있다. 서버·DB와 무관한 출력이라 언제 돌려도 같다.

`!미납`·`!회비 <이름>`처럼 **DB 상태에 의존하는 스냅샷은 커밋하지 않는다.** 그 출력은
어떤 시나리오를 심었는지에 따라 달라지므로, 메인 저장소의 명부 스냅샷(`base.sql`)과
시나리오가 갖춰진 뒤에 짝지어 만들어야 의미가 있다. 그전까지는 `--snapshot` 없이
눈으로 보는 용도로 쓴다.
