/**
 * 넥슨농구동호회 회비 봇 (메신저봇R)
 *
 * 회원이 자기 회원 여부·회비·게스트비 미납을 단톡방에서 직접 확인하기 위한 봇.
 * 운영진이 아무리 장부를 맞춰도 회원이 그걸 못 보면 소용이 없다는 게 출발점이다.
 *
 * 설계상 정해둔 것:
 * - 이름은 **항상 파라미터로 받는다**. 카톡 표시명(sender)은 쓰지 않는다 — 사람들이
 *   닉네임을 쓰기 때문에 표시명으로 찾으면 상당수가 첫 시도에서 실패한다.
 * - 그래서 조회는 누구나 누구든 할 수 있다. 표시명으로 본인 확인을 하는 건 이름만
 *   바꾸면 뚫리므로 보안이 아니라 불편만 만든다.
 * - 노출을 줄이려고 **회비는 금액을 안 낸다.** 분기 정액이라 다들 알고 있다.
 *   게스트비는 건마다 금액이 다르고 그걸 모르면 입금을 못 하므로 금액을 낸다.
 * - 서버는 JSON만 주고 문구는 여기서 만든다. 문구를 고치려면 태블릿에서 pull이 필요하다.
 *
 * Rhino 엔진(useBabel: false)이라 템플릿 리터럴을 쓰지 않는다. 문자열은 전부 + 로 잇는다.
 */

const scriptName = "nbcdues";

// ============================================================
// 설정
// ============================================================

function loadConfig() {
  const paths = [
    "/storage/emulated/0/msgbot/Bots/nbcdues/config.json",
    "/sdcard/msgbot/Bots/nbcdues/config.json",
    "Bots/config.json",
    "config.json"
  ];

  for (let i = 0; i < paths.length; i++) {
    try {
      const data = FileStream.read(paths[i]);
      if (data) return JSON.parse(data);
    } catch (e) {
      // 다음 경로 시도
    }
  }
  throw new Error("config.json을 찾을 수 없습니다. config.json.example을 복사해서 만드세요.");
}

const CONFIG = loadConfig();
const SERVER_URL = CONFIG.serverUrl;
const BOT_TOKEN = CONFIG.botToken;
const TIMEOUT = CONFIG.timeout || 5000;

// ============================================================
// HTTP
// ============================================================

/**
 * 서버 GET 호출. 성공하면 파싱된 객체, 실패하면 { error: "..." } 를 돌려준다.
 * 예외를 던지지 않는 이유는 호출부마다 try/catch를 두지 않기 위해서다.
 */
function apiGet(path, params) {
  try {
    let url = SERVER_URL + path;

    const parts = [];
    // for-in 헤드에는 var를 쓴다. Rhino가 여기서 const를 못 받아 신택스 에러를 낸다.
    for (var key in params) {
      if (params[key] === null || params[key] === undefined) continue;
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key])));
    }
    if (parts.length > 0) url = url + "?" + parts.join("&");

    const conn = new java.net.URL(url).openConnection();
    conn.setRequestMethod("GET");
    conn.setConnectTimeout(TIMEOUT);
    conn.setReadTimeout(TIMEOUT);
    conn.setRequestProperty("Authorization", "Bearer " + BOT_TOKEN);

    // getResponseCode()는 Java int를 준다. Rhino에서 === 비교가 보장되지 않으므로
    // JS 숫자로 못박는다 — 레퍼런스 봇이 상태코드에 >= 와 < 만 쓴 이유로 보인다.
    const status = Number(conn.getResponseCode());
    const stream = status >= 200 && status < 300 ? conn.getInputStream() : conn.getErrorStream();

    if (!stream) {
      conn.disconnect();
      return { error: "서버 응답을 읽을 수 없습니다. (" + status + ")" };
    }

    const reader = new java.io.BufferedReader(new java.io.InputStreamReader(stream, "UTF-8"));
    const sb = new java.lang.StringBuilder();
    let line;
    while ((line = reader.readLine()) !== null) sb.append(line);
    reader.close();
    conn.disconnect();

    const body = JSON.parse(sb.toString());

    if (status === 401) return { error: "봇 인증에 실패했습니다. 토큰을 확인해 주세요." };
    if (status >= 400) return { error: body.error || "서버 오류 (" + status + ")" };

    return body;
  } catch (e) {
    Log.e("[" + scriptName + "] " + e.message);
    return { error: "서버가 응답하지 않습니다." };
  }
}

// ============================================================
// 포맷
// ============================================================

/** 30000 → "30,000". Rhino의 toLocaleString을 믿지 않고 직접 찍는다. */
function comma(n) {
  const s = String(n);
  let out = "";
  let count = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    out = s.charAt(i) + out;
    count++;
    if (count % 3 === 0 && i > 0) out = "," + out;
  }
  return out;
}

/** "게스트비 미납 2건 · 30,000원" 또는 "게스트비 미납 없음" */
function guestFeeLine(m) {
  if (m.unpaidCount === 0) return "게스트비 미납 없음";
  return "게스트비 미납 " + m.unpaidCount + "건 · " + comma(m.unpaidAmount) + "원";
}

/** 동명이인을 가르는 유일한 단서. 사원은 법인명, 나머지는 구분 라벨. */
function whichOne(m) {
  return m.corporation ? m.corporation : m.kind;
}

/** 한 명짜리 회비 응답 */
function formatDuesOne(m, quarter) {
  let s = m.name + " 님\n";
  s += quarter + " 회원 " + (m.isMember ? "✅" : "❌") + "\n";
  if (m.dues === "면제") s += "회비 면제\n";
  else if (m.dues) s += "회비 납부완료\n";
  s += guestFeeLine(m);
  return s;
}

/**
 * 동명이인 나열. 조회가 어차피 공개라 되묻지 않고 전부 보여준다.
 * 블록 사이는 빈 줄로 띄운다 — 카톡에서 줄만 이어지면 누구 것인지 안 읽힌다.
 */
function formatDuesMany(matches, query, quarter) {
  const marks = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];
  const blocks = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const mark = i < marks.length ? marks[i] : String(i + 1) + ".";
    let b = mark + " " + m.name + " (" + whichOne(m) + ")\n";
    b += "   " + quarter + " 회원 " + (m.isMember ? "✅" : "❌");
    if (m.dues === "면제") b += " / 회비 면제";
    else if (m.dues) b += " / 회비 납부완료";
    b += "\n   " + guestFeeLine(m);
    blocks.push(b);
  }

  return "'" + query + "' " + matches.length + "명\n\n" + blocks.join("\n\n");
}

/** 게스트비만 보는 응답 — 가장 오래된 미납일을 같이 낸다. */
function formatGuestOne(m) {
  let s = m.name + " 님\n";
  s += guestFeeLine(m);
  if (m.oldestUnpaid) s += "\n(가장 오래된 건 " + m.oldestUnpaid + ")";
  return s;
}

function formatGuestMany(matches, query) {
  const blocks = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    let b = "· " + m.name + " (" + whichOne(m) + ")\n  " + guestFeeLine(m);
    if (m.oldestUnpaid) b += "\n  (가장 오래된 건 " + m.oldestUnpaid + ")";
    blocks.push(b);
  }
  return "'" + query + "' " + matches.length + "명\n\n" + blocks.join("\n\n");
}

/** 미납자 명단. 자르지 않고 전원 낸다 — 잘리면 자기가 미납인 걸 모르는 사람이 생긴다. */
function formatUnpaid(data) {
  if (data.totalPeople === 0) return "게스트비 미납이 없습니다. 👏";

  let s = "게스트비 미납\n";
  s += data.totalPeople + "명 · 총 " + comma(data.totalAmount) + "원\n";

  for (let i = 0; i < data.people.length; i++) {
    const p = data.people[i];
    s += "\n" + p.name + "  " + p.count + "건  " + comma(p.amount);
  }
  return s;
}

function helpText() {
  return (
    "사용법\n" +
    " !회비 <이름>      회원·회비·게스트비\n" +
    " !게스트비 <이름>  게스트비만\n" +
    " !미납            전체 미납자\n" +
    "\n예: !회비 원동현"
  );
}

function notFound(query) {
  return "'" + query + "' 회원을 찾을 수 없습니다.\n이름을 정확히 입력해 주세요.";
}

// ============================================================
// 명령어
// ============================================================

/**
 * 이름 조회 공통부. 두 명령어가 같은 엔드포인트를 쓰므로 여기까지만 묶고,
 * 포맷은 각 핸들러가 직접 고른다.
 *
 * 고차 함수(formatter를 인자로 넘기기)로 더 줄일 수 있지만 그러지 않았다 —
 * 여러 줄 호출이 생기고 거기 붙는 후행 쉼표가 Rhino에서 신택스 에러를 낸다.
 * 이 파일은 고칠 때마다 태블릿을 만져야 하므로 평평한 쪽이 싸다.
 */
function lookupPerson(params) {
  // 이름에 공백이 있을 수 있으므로 나머지 인자를 전부 붙인다
  const query = params.join(" ");
  const res = apiGet("/api/bot/person", { name: query });

  if (res.error) return { message: res.error };
  if (!res.matches || res.matches.length === 0) return { message: notFound(query) };
  return { query: query, quarter: res.quarter, matches: res.matches };
}

function handleDues(params) {
  if (params.length === 0) return helpText();

  const r = lookupPerson(params);
  if (r.message) return r.message;
  if (r.matches.length === 1) return formatDuesOne(r.matches[0], r.quarter);
  return formatDuesMany(r.matches, r.query, r.quarter);
}

function handleGuest(params) {
  if (params.length === 0) return helpText();

  const r = lookupPerson(params);
  if (r.message) return r.message;
  if (r.matches.length === 1) return formatGuestOne(r.matches[0]);
  return formatGuestMany(r.matches, r.query);
}

function handleUnpaid() {
  const res = apiGet("/api/bot/unpaid", {});
  if (res.error) return res.error;
  return formatUnpaid(res);
}

function handleCommand(command, params) {
  switch (command) {
    case "회비":
      return handleDues(params);

    case "게스트비":
      return handleGuest(params);

    case "미납":
      return handleUnpaid();

    case "도움말":
    case "도움":
      return helpText();

    default:
      // 모르는 명령어엔 침묵한다. 다른 봇이나 사람의 ! 로 시작하는 말에
      // 끼어들지 않기 위해서다.
      return null;
  }
}

// ============================================================
// 진입점
// ============================================================

function response(room, msg, sender, isGroupChat, replier, imageDB, packageName) {
  if (!msg || msg.charAt(0) !== "!") return;

  const parts = msg.trim().split(/\s+/);
  const command = parts[0].substring(1);
  const params = parts.slice(1);

  try {
    const reply = handleCommand(command, params);
    if (reply) replier.reply(reply);
  } catch (e) {
    Log.e("[" + scriptName + "] " + e.message);
    replier.reply("오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
  }
}
