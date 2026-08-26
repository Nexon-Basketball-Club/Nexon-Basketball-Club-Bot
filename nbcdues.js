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

/**
 * **로드 시점 로그.** 최상단이므로 스크립트가 앱에 올라가는 순간 찍힌다.
 *
 * 이게 있고 recv가 없으면 → 봇은 살아있는데 메시지가 안 온다 (알림 권한/방 멤버십).
 * 이것조차 없으면 → 앱이 이 스크립트를 아예 안 돌리고 있다 (봇 미등록/전원 OFF).
 * 둘은 고칠 곳이 완전히 다르므로 먼저 갈라야 한다.
 */
try {
  Log.i("[" + scriptName + "] loaded " + new Date().toString());
} catch (e) {
  // Log가 없는 환경이면 조용히 넘어간다
}

// ============================================================
// 설정
// ============================================================

const CONFIG_PATHS = [
  "/storage/emulated/0/msgbot/Bots/nbcdues/config.json",
  "/sdcard/msgbot/Bots/nbcdues/config.json",
  "Bots/config.json",
  "config.json"
];

/**
 * 설정은 **최상단이 아니라 명령어를 받을 때** 읽는다.
 *
 * 최상단에서 읽으면 config.json이 없을 때 스크립트 로드가 통째로 실패하고, 그러면
 * 봇이 아무 반응도 안 한다 — 무엇이 잘못됐는지 채팅에서 알 길이 없다. 지연 로드로
 * 두면 설정 문제가 "봇이 죽었다"가 아니라 **답장 한 줄**로 나온다.
 *
 * 성공/실패 둘 다 캐시한다. 매 메시지마다 파일을 뒤지지 않기 위해서다.
 */
var configCache = null;
var configError = null;

function getConfig() {
  if (configCache) return configCache;
  if (configError) return null;

  const tried = [];
  for (let i = 0; i < CONFIG_PATHS.length; i++) {
    try {
      const data = FileStream.read(CONFIG_PATHS[i]);
      if (data) {
        const parsed = JSON.parse(data);
        if (!parsed.serverUrl) {
          configError = "config.json에 serverUrl이 없습니다.";
          return null;
        }
        if (!parsed.botToken) {
          configError = "config.json에 botToken이 없습니다.";
          return null;
        }
        parsed.timeout = parsed.timeout || 5000;
        configCache = parsed;
        return configCache;
      }
      tried.push(CONFIG_PATHS[i] + " (빈 파일)");
    } catch (e) {
      tried.push(CONFIG_PATHS[i] + " (" + e.message + ")");
    }
  }

  configError = "config.json을 못 읽었습니다.\n" + tried.join("\n");
  return null;
}

// ============================================================
// HTTP
// ============================================================

/**
 * 서버 GET 호출. 성공하면 파싱된 객체, 실패하면 { error: "..." } 를 돌려준다.
 * 예외를 던지지 않는 이유는 호출부마다 try/catch를 두지 않기 위해서다.
 */
function apiGet(path, params) {
  const cfg = getConfig();
  if (!cfg) return { error: configError };

  try {
    let url = cfg.serverUrl + path;

    const parts = [];
    // for-in 헤드에는 var를 쓴다. Rhino가 여기서 const를 못 받아 신택스 에러를 낸다.
    for (var key in params) {
      if (params[key] === null || params[key] === undefined) continue;
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key])));
    }
    if (parts.length > 0) url = url + "?" + parts.join("&");

    const conn = new java.net.URL(url).openConnection();
    conn.setRequestMethod("GET");
    conn.setConnectTimeout(cfg.timeout);
    conn.setReadTimeout(cfg.timeout);
    conn.setRequestProperty("Authorization", "Bearer " + cfg.botToken);

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
    " !핑              봇·설정 상태 확인\n" +
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

/**
 * 살아있는지만 본다. **네트워크를 타지 않는다** — 이게 요점이다.
 *
 * 반응이 없을 때 원인은 두 갈래다: 메신저봇R이 메시지를 아예 못 받고 있거나
 * (봇 OFF, 알림 접근 권한, 봇 계정이 그 방에 없음), 스크립트는 도는데 설정·네트워크에서
 * 막히거나. !핑이 답하면 위쪽은 정상이라는 뜻이므로 아래쪽만 보면 된다.
 */
function handlePing() {
  const cfg = getConfig();
  if (!cfg) return "봇 살아있음 ✅\n설정 실패 ❌\n" + configError;

  const token = String(cfg.botToken);
  let masked = "(너무 짧음)";
  if (token.length > 8) {
    masked = token.substring(0, 4) + "..." + token.substring(token.length - 4);
  }

  return (
    "봇 살아있음 ✅\n" +
    "설정 읽음 ✅\n" +
    "서버 " + cfg.serverUrl + "\n" +
    "토큰 " + masked
  );
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

    case "핑":
    case "ping":
      return handlePing();

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
  // **필터보다 먼저 찍는다.** 봇이 반응이 없을 때 원인이 "메시지가 안 온다"인지
  // "와서 걸러진다"인지 이 한 줄이 가른다. 로그가 비어 있으면 메신저봇R이 메시지를
  // 못 받고 있는 것이므로 스크립트를 아무리 고쳐도 소용없다.
  //
  // 본문은 안 찍는다 — 단톡방 대화 전체가 태블릿 로그에 쌓이면 곤란하다.
  // 전체를 보려면 config.json에 "debug": true 를 넣는다.
  try {
    Log.d("[" + scriptName + "] recv room=" + room + " len=" + (msg ? msg.length : 0));
    const dbg = configCache && configCache.debug;
    if (dbg) Log.d("[" + scriptName + "] msg=" + msg + " sender=" + sender + " group=" + isGroupChat);
  } catch (e) {
    // 로그가 실패해도 본 흐름은 계속한다
  }

  if (!msg || msg.charAt(0) !== "!") return;

  const parts = msg.trim().split(/\s+/);
  const command = parts[0].substring(1);
  const params = parts.slice(1);

  try {
    Log.d("[" + scriptName + "] cmd=" + command);
    const reply = handleCommand(command, params);
    if (reply) {
      replier.reply(reply);
      Log.d("[" + scriptName + "] replied " + reply.length + " chars");
    } else {
      Log.d("[" + scriptName + "] no handler for '" + command + "'");
    }
  } catch (e) {
    Log.e("[" + scriptName + "] " + e + " @ " + (e.lineNumber || "?"));
    replier.reply("오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
  }
}
