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
 *
 * ## 선언은 전부 `var`다. 바꾸지 말 것.
 *
 * 메신저봇R은 `useBabel: false`라 Rhino가 이 소스를 그대로 먹는다. Rhino의 `const`는
 * ES6 블록 스코프가 아니라 **함수 스코프 + 재할당 금지**여서, 루프 안에서
 * `const p = arr[i]`를 반복하면 두 번째부터 대입이 먹지 않고 첫 값이 눌러앉는다.
 *
 * 이것 때문에 `!미납`이 미납자 두 명을 **같은 사람으로 두 줄** 냈다. 신택스 에러가
 * 아니라 조용히 틀리기 때문에 서버를 한참 뒤졌다 — 서버 응답에는 두 사람이 멀쩡히
 * 들어 있었다. 나열하는 함수가 전부(`formatDuesMany` / `formatGuestMany` /
 * `formatUnpaid`) 같은 패턴이었으므로 동명이인 조회도 같이 틀리고 있었다.
 */

var scriptName = "nbcdues";

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

var CONFIG_PATHS = [
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

/**
 * serverUrl을 다듬고 검증한다. 실패하면 configError를 채우고 null.
 *
 * 실제로 https://를 두 번 적어서 반나절을 날렸다. 그러면 java.net.URL이 호스트를
 * 문자열 "https"로 읽고 `Unable to resolve host "https"`가 난다 — 에러만 봐서는
 * 원인이 config 오타라는 걸 알 수가 없다. 그래서 여기서 미리 잡고 무엇이 잘못됐는지
 * 대놓고 말해준다.
 */
function normalizeServerUrl(raw) {
  var url = raw.replace(/^\s+|\s+$/g, "");

  // https://https://... 처럼 스킴이 겹친 경우
  var dup = /^(https?:\/\/)(https?:\/\/)/.exec(url);
  if (dup) {
    configError = "config.json의 serverUrl에 https:// 가 두 번 있습니다.";
    return null;
  }

  if (!/^https?:\/\//.test(url)) {
    configError = "config.json의 serverUrl은 https:// 로 시작해야 합니다.";
    return null;
  }

  // 자리표시자를 그대로 둔 경우
  if (url.indexOf("<") >= 0 || url.indexOf(">") >= 0) {
    configError = "config.json의 serverUrl이 예시 그대로입니다.";
    return null;
  }

  // 끝 슬래시를 떼어 //api/... 가 되는 걸 막는다
  url = url.replace(/\/+$/, "");
  return url;
}

function getConfig() {
  if (configCache) return configCache;
  if (configError) return null;

  var tried = [];
  for (var i = 0; i < CONFIG_PATHS.length; i++) {
    try {
      var data = FileStream.read(CONFIG_PATHS[i]);
      if (data) {
        var parsed = JSON.parse(data);
        if (!parsed.serverUrl) {
          configError = "config.json에 serverUrl이 없습니다.";
          return null;
        }
        if (!parsed.botToken) {
          configError = "config.json에 botToken이 없습니다.";
          return null;
        }

        var url = normalizeServerUrl(String(parsed.serverUrl));
        if (!url) return null; // normalize가 configError를 채운다
        parsed.serverUrl = url;

        // Railway는 유휴 상태에서 깨어나는 데 몇 초 걸린다. 5초는 짧아서
        // 첫 요청이 타임아웃으로 떨어졌다.
        parsed.timeout = parsed.timeout || 15000;
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
 * 서버 GET 호출. 성공하면 파싱된 객체, 실패하면 { error, kind } 를 돌려준다.
 * 예외를 던지지 않는 이유는 호출부마다 try/catch를 두지 않기 위해서다.
 *
 * `kind`로 실패 종류를 가른다 — config / auth / server / network. !핑이 이걸로
 * "서버가 죽었다"와 "토큰이 틀렸다"를 구분해서 말한다.
 *
 * **자세한 내용은 로그에만 남긴다.** 주소나 예외 원문이 단톡방에 뜨면 곤란하다.
 * 태블릿 로그에는 전부 남으므로 진단에는 지장이 없다.
 */
function apiGet(path, params) {
  return apiCall("GET", path, params, null);
}

/**
 * **봇↔서버 계약 버전** (메인 저장소 decision 033). 요청마다 `X-Bot-Api-Version`으로 싣는다.
 * `/api/bot/*`의 라우트·필드·의미를 바꾸면 서버 `src/lib/bot-auth.ts`의 같은 이름 상수와
 * **같이** 올린다. 판정은 서버가 한다 — 범위를 벗어나면 409 + `BOT_OUTDATED`/`SERVER_OUTDATED`.
 *
 * 서버가 먼저 배포되고 태블릿 pull이 늦으면, 예전에는 `!참석`이 "이 방에서 진행 중인 투표가
 * 없습니다"처럼 엉뚱하게 실패했다(032 배포 때 실제로). 이제 "봇이 옛 버전입니다"가 나온다.
 *
 * 이력: 1 = decision 032. 2 = decision 034 — `!투표시작`이 연결된 투표를 옮기지 않는다(`movedFrom` 없음).
 */
var BOT_API_VERSION = 2;

/**
 * POST/DELETE — 참석 신청과 취소가 쓴다.
 *
 * **이 봇이 처음으로 쓰는 요청이다.** decision 016은 읽기 전용으로 붙였고, 참석
 * 투표(decision 025)가 그걸 개정했다. 토큰이 새면 이제 남의 참석을 넣고 지울 수
 * 있으므로 config.json의 취급이 전보다 중요해졌다.
 */
function apiSend(method, path, body) {
  return apiCall(method, path, null, body);
}

function apiCall(method, path, params, body) {
  var cfg = getConfig();
  if (!cfg) return { error: configError, kind: "config" };

  try {
    var url = cfg.serverUrl + path;

    var parts = [];
    // 이 파일은 선언을 전부 var로 통일한다 — 파일 머리말 참고.
    for (var key in params) {
      if (params[key] === null || params[key] === undefined) continue;
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key])));
    }
    if (parts.length > 0) url = url + "?" + parts.join("&");
    Log.i("[" + scriptName + "] " + method + " " + url);

    var conn = new java.net.URL(url).openConnection();
    conn.setRequestMethod(method);
    // Railway는 http로 들어오면 https로 리다이렉트한다. Java의 HttpURLConnection은
    // 프로토콜이 바뀌는 리다이렉트를 따라가지 않으므로 serverUrl은 https여야 한다.
    conn.setInstanceFollowRedirects(true);
    conn.setConnectTimeout(cfg.timeout);
    conn.setReadTimeout(cfg.timeout);
    conn.setRequestProperty("Authorization", "Bearer " + cfg.botToken);
    conn.setRequestProperty("X-Bot-Api-Version", String(BOT_API_VERSION));

    // 본문은 **UTF-8 바이트로 직접 쓴다.** 카톡 표시명이 한글이라 기본 인코딩에
    // 맡기면 서버에 깨져서 저장되고, 그러면 취소가 자기 신청을 못 찾는다.
    if (body) {
      var payload = JSON.stringify(body);
      conn.setDoOutput(true);
      conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
      // **`conn.getOutputStream()`에 직접 쓰면 안 된다.** 그게 돌려주는 구체 클래스는
      // `sun.net.www.http.PosterOutputStream`이고, `java.base`가 그 패키지를 export하지
      // 않아 Rhino의 리플렉션이 `write`를 못 부른다:
      //   IllegalAccessException: ... because module java.base does not export sun.net.www.http
      // 그래서 **export된 public 클래스로 감싼다.** 입력 쪽이 이미 같은 이유로
      // `InputStreamReader`를 거치고 있다.
      //
      // 이건 JVM 모듈 시스템의 제약이라 **안드로이드(Dalvik)에는 없다.** sim/run.sh에
      // `--add-opens`를 한 줄 더 넣어도 풀린다. 그럼에도 코드 쪽을 고른 건 감싸는
      // 비용이 0이고, 그래야 시뮬레이터가 **태블릿과 똑같은 코드 경로**를 돌기
      // 때문이다 — 플래그로 풀면 sim에서만 되는 코드가 생길 여지가 남는다.
      var out = new java.io.DataOutputStream(conn.getOutputStream());
      out.write(new java.lang.String(payload).getBytes("UTF-8"));
      out.flush();
      out.close();
    }

    // getResponseCode()는 Java int를 준다. Rhino에서 === 비교가 보장되지 않으므로
    // JS 숫자로 못박는다 — 레퍼런스 봇이 상태코드에 >= 와 < 만 쓴 이유로 보인다.
    var status = Number(conn.getResponseCode());
    var stream = status >= 200 && status < 300 ? conn.getInputStream() : conn.getErrorStream();

    if (!stream) {
      conn.disconnect();
      return { error: "서버 응답을 읽을 수 없습니다.", kind: "server" };
    }

    var reader = new java.io.BufferedReader(new java.io.InputStreamReader(stream, "UTF-8"));
    var sb = new java.lang.StringBuilder();
    var line;
    while ((line = reader.readLine()) !== null) sb.append(line);
    reader.close();
    conn.disconnect();

    var text = sb.toString();
    // 서버 응답 원문이 필요하면 여기서 text를 Log.i로 찍는다. 상시로는 안 남긴다 —
    // 회원 이름과 금액이 태블릿 로그에 계속 쌓인다.
    var body = JSON.parse(text);

    if (status === 401) return { error: "토큰이 맞지 않습니다.", kind: "auth" };
    // 버전 불일치는 **서버 문구를 그대로** 낸다 — 헤더를 모르는 옛 봇도 그 문구를 보므로 한 벌로
    // 둔다(decision 016의 예외). 호출부는 대부분 `res.error`를 답장하므로 손댈 게 없고,
    // `kind`는 `!핑`·`!도움말`이 가르는 데 쓴다.
    if (body.code === "BOT_OUTDATED" || body.code === "SERVER_OUTDATED")
      return { error: body.error, kind: "version", code: body.code };
    // **`code`를 같이 넘긴다.** 서버가 code를 내는 이유가 이것이다 — 호출부가 실패
    // 이유를 문자열 매칭으로 알아내면 서버 문구를 고칠 때마다 봇이 조용히 틀린다.
    // `options`는 선택지를 못 골랐을 때 서버가 같이 주는 선택지 이름들이다.
    if (status >= 400)
      return { error: body.error || "서버 오류", kind: "server", code: body.code, options: body.options };

    return body;
  } catch (e) {
    // 예외 원문에는 주소가 들어있다 — Unable to resolve host "...". 단톡방엔 종류만
    // 내고 원문은 로그로 넘긴다. 태블릿 로그에 다 남으므로 진단에는 지장이 없다.
    var detail = e && e.message ? e.message : String(e);
    Log.e("[" + scriptName + "] " + detail);
    return { error: "서버에 연결하지 못했습니다.", kind: "network" };
  }
}

// ============================================================
// 포맷
// ============================================================

/** 30000 → "30,000". Rhino의 toLocaleString을 믿지 않고 직접 찍는다. */
function comma(n) {
  var s = String(n);
  var out = "";
  var count = 0;
  for (var i = s.length - 1; i >= 0; i--) {
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

/** 동명이인을 가르는 1차 단서. 사원은 법인명, 나머지는 구분 라벨. */
function whichOne(m) {
  return m.corporation ? m.corporation : m.kind;
}

/**
 * 나열용 이름표. **`whichOne`까지 같은 사람이 둘 이상이면 회원번호를 붙인다.**
 *
 * 서버가 사내 명부의 동명이인 번호를 떼고 검색하게 되면서(`김지훈`으로 쳐도
 * `김지훈13`이 같이 나온다) 한 조회에 여러 명이 걸리는 일이 잦아졌다. 대개는
 * `김지훈13 ((주)넥슨코리아)` / `김지훈 (게스트)`처럼 갈리지만, 게스트 둘이 같이
 * 걸리면 둘 다 `(게스트)`라 가릴 단서가 사라진다.
 *
 * `formatUnpaid`가 이미 쓰는 규칙을 그대로 가져왔다 — 평소엔 코드가 줄줄이 뜨는 게
 * 지저분하고, 겹칠 때는 그것만이 두 사람을 가른다.
 *
 * Rhino라 Map을 쓰지 않고 평범한 객체로 센다.
 */
function nameTags(matches) {
  var seen = {};
  var i;
  for (i = 0; i < matches.length; i++) {
    var k = matches[i].name + "|" + whichOne(matches[i]);
    seen[k] = (seen[k] || 0) + 1;
  }
  var tags = [];
  for (i = 0; i < matches.length; i++) {
    var m = matches[i];
    var key = m.name + "|" + whichOne(m);
    var inner = seen[key] > 1 ? whichOne(m) + " · " + m.displayCode : whichOne(m);
    tags.push(m.name + " (" + inner + ")");
  }
  return tags;
}

/** 한 명짜리 회비 응답 */
function formatDuesOne(m, quarter) {
  var s = m.name + " 님\n";
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
  var marks = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];
  var blocks = [];
  var tags = nameTags(matches);

  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    var mark = i < marks.length ? marks[i] : String(i + 1) + ".";
    var b = mark + " " + tags[i] + "\n";
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
  var s = m.name + " 님\n";
  s += guestFeeLine(m);
  if (m.oldestUnpaid) s += "\n(가장 오래된 건 " + m.oldestUnpaid + ")";
  return s;
}

function formatGuestMany(matches, query) {
  var blocks = [];
  var tags = nameTags(matches);
  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    var b = "· " + tags[i] + "\n  " + guestFeeLine(m);
    if (m.oldestUnpaid) b += "\n  (가장 오래된 건 " + m.oldestUnpaid + ")";
    blocks.push(b);
  }
  return "'" + query + "' " + matches.length + "명\n\n" + blocks.join("\n\n");
}

/**
 * 미납자 명단. 자르지 않고 전원 낸다 — 잘리면 자기가 미납인 걸 모르는 사람이 생긴다.
 *
 * **회원번호는 이름이 겹칠 때만 붙인다.** 평소엔 단톡방에 코드가 줄줄이 뜨는 게 지저분하고,
 * 겹칠 때는 이름만으로 두 사람을 가를 방법이 없다. 서로 다른 두 미납자가 같은 이름으로
 * 나갔던 적이 있는데, 그때 아무도 이상하다고 못 느낀 게 이 단서가 없어서였다.
 */
function formatUnpaid(data) {
  if (data.totalPeople === 0) return "게스트비 미납이 없습니다. 👏";

  // 이름별 등장 횟수. Rhino라 Map을 쓰지 않고 평범한 객체로 센다.
  var seen = {};
  for (var i = 0; i < data.people.length; i++) {
    var n = data.people[i].name;
    seen[n] = (seen[n] || 0) + 1;
  }

  var s = "게스트비 미납\n";
  s += data.totalPeople + "명 · 총 " + comma(data.totalAmount) + "원\n";

  for (var i = 0; i < data.people.length; i++) {
    var p = data.people[i];
    var label = seen[p.name] > 1 ? p.name + " (" + p.displayCode + ")" : p.name;
    s += "\n" + label + "  " + p.count + "건  " + comma(p.amount);
  }
  return s;
}

/**
 * 기본 도움말 — 서버 없이 나간다. 투표 줄은 `pollHelp`가 있을 때만 위에 붙인다.
 * `!회비`/`!게스트비`를 이름 없이 쳤을 때도 이것만 낸다(그건 사용법 실수지 투표 얘기가 아니다).
 */
function helpText() {
  return (
    "사용법\n" +
    " !회비 <이름>      회원·회비·게스트비\n" +
    " !게스트비 <이름>  게스트비만\n" +
    " !미납            전체 미납자\n" +
    " !핑              서버·토큰 상태 확인\n" +
    "\n예: !회비 원동현"
  );
}

/**
 * 도움말의 투표 줄. **투표가 있을 때만 붙인다** — 없을 때 `!참석`을 알려주면 `지금 진행 중인
 * 투표가 없습니다`만 반복해서 보게 된다. 예전에 `!참석`/`!취소`를 도움말에서 아예 빼둔 이유가
 * 그것이었고, 투표가 열려 있는지를 서버에 물으면 그 걱정 없이 띄울 수 있다.
 *
 * 마감 후 표시 기간에는 `!투표현황`만 남긴다. `/poll`이 마감 명단을 보여주는 동안이라 볼 것은
 * 있지만, 신청·취소는 어차피 거절된다.
 */
function pollHelp(poll) {
  if (!poll.open) return "투표 마감 · " + poll.title + "\n !투표현황        마감 명단\n";

  var s = "투표 진행 중 · " + poll.title + "\n";
  if (poll.options.length > 1) {
    var labels = [];
    for (var i = 0; i < poll.options.length; i++) labels.push(poll.options[i].label);
    s += " !참석 <선택지>   선착순 신청 (" + labels.join(" / ") + ")\n";
  } else {
    s += " !참석            선착순 신청\n";
  }
  s += " !취소            신청 취소\n";
  s += " !투표현황        명단\n";
  s += " !내순번          내 순번\n";
  return s;
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
  var query = params.join(" ");
  var res = apiGet("/api/bot/person", { name: query });

  if (res.error) return { message: res.error };
  if (!res.matches || res.matches.length === 0) return { message: notFound(query) };
  return { query: query, quarter: res.quarter, matches: res.matches };
}

function handleDues(params) {
  if (params.length === 0) return helpText();

  var r = lookupPerson(params);
  if (r.message) return r.message;
  if (r.matches.length === 1) return formatDuesOne(r.matches[0], r.quarter);
  return formatDuesMany(r.matches, r.query, r.quarter);
}

function handleGuest(params) {
  if (params.length === 0) return helpText();

  var r = lookupPerson(params);
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
/**
 * 참석 신청 결과 한 줄.
 *
 * **정원과 대기 순번을 그 자리에서 말한다.** 명단은 웹에서 보게 했지만, 방금 신청한
 * 사람이 알아야 할 건 "내가 들어갔나 / 몇 번째인가" 하나뿐이라 그건 여기서 끝낸다.
 * 매 신청마다 링크를 붙이면 단톡방이 지저분해진다.
 */
function attendCount(r) {
  if (r.capacity === null || r.capacity === undefined) return String(r.confirmedCount);
  return r.confirmedCount + "/" + r.capacity;
}

function formatAttend(r) {
  if (r.duplicate) {
    if (r.confirmed) return "이미 신청하셨습니다 (" + r.optionLabel + " 확정 " + r.rank + "번)";
    return "이미 신청하셨습니다 (" + r.optionLabel + " 대기 " + r.waitingRank + "번)";
  }
  if (r.confirmed) {
    return r.voterName + " 님 " + r.optionLabel + " 확정 (" + attendCount(r) + ")";
  }
  // 대기에도 선택지를 붙인다. 선택지가 여럿이면 어느 줄에 섰는지가 답의 절반이다.
  return r.voterName + " 님 " + r.optionLabel + " 대기 " + r.waitingRank + "번 (" + attendCount(r) + " 마감)";
}

/**
 * 취소 결과 + **취소한 뒤의 인원**. 자리가 났는지가 취소 답장을 보는 사람들의 다음 질문이다.
 *
 * **승계는 여기 싣지 않는다** — 서버가 메시지함에 쌓고 봇이 이 답장 바로 뒤에 올린다(decision 032).
 * 총무가 웹에서 지웠을 때와 같은 길·같은 문구다. 그래서 승계가 있었으면 인원은 승계 뒤의 것이다
 * (`확정 12/12 · 정원 마감` → 바로 뒤에 "대기 1번 ○○ 님이 확정되었습니다"). 한 메시지로 합치는 안은
 * 서버가 `!취소`의 승계를 메시지함에 안 쌓아야 해서 계약이 바뀌고(옛 봇은 승계를 못 알린다) 버려졌다.
 */
function formatCancel(r) {
  return r.voterName + " 님 취소되었습니다.\n" + r.optionLabel + " " + cancelCount(r);
}

/** 인원 줄 — 서버 공지(`poll-announce.ts` `reminderCount`)와 같은 말을 쓴다. */
function cancelCount(r) {
  if (r.capacity === null || r.capacity === undefined) return "지금 " + r.confirmedCount + "명 신청";
  var base = "확정 " + r.confirmedCount + "/" + r.capacity;
  if (r.waitingCount > 0) return base + " · 대기 " + r.waitingCount + "명";
  if (r.confirmedCount >= r.capacity) return base + " · 정원 마감";
  return base + " · " + (r.capacity - r.confirmedCount) + "자리 남음";
}

/**
 * `!참석` — 신청.
 *
 * **이름을 파라미터로 받지 않는다.** decision 016은 조회에서 이름을 항상 받게 했지만
 * (표시명이 실명이 아니라서), 선착순 신청은 반대다 — `!참석 원동현`은 `!참석`보다
 * 느리고, 선착순에서 타이핑 길이가 곧 순위다. 그리고 sender로만 넣고 sender로만
 * 지우므로 "자기 것만 취소"가 규칙이 아니라 결과로 성립한다.
 *
 * 인자는 **선택지 이름으로만** 넘긴다. 선택지가 하나면 서버가 그걸 보지 않으므로 기존
 * 명령어 습관인 `!참석 원동현`도 그냥 신청된다 — 거절하면 그 사람만 선착순에서 뒤로
 * 밀린다. 선택지가 여럿일 때만 `!참석 1부`로 고르고, 못 고르면 칠 줄을 보여준다.
 */
function handleAttend(params, sender, room) {
  var label = params.join(" ");
  var res = apiSend("POST", "/api/bot/poll", {
    voterName: String(sender), optionLabel: label || null, room: String(room) });
  if (res.error) {
    // 거절만 하면 무엇을 쳐야 하는지 모른다. 서버가 준 선택지로 그대로 칠 줄을 만든다.
    if (res.options) return res.error + "\n" + optionCommands(res.options);
    return res.error;
  }
  return formatAttend(res);
}

function optionCommands(labels) {
  var lines = [];
  for (var i = 0; i < labels.length; i++) lines.push("!참석 " + labels[i]);
  return lines.join("\n");
}

var NO_POLL = "이 방에서 진행 중인 투표가 없습니다.";

/**
 * `!투표현황` — 명단 전부. 마감 공지(서버의 `buildClosedText`)와 같은 이유로 링크 대신 이름을
 * 싣는다: 궁금한 건 "내가 들어갔나"이고, 표시명은 원래 그 방에 보이는 이름이다.
 *
 * 확정·대기 둘 다 **순번을 붙인다.** 진행 중에는 몇 번째인지가 곧 정보다 — 정원이 줄면
 * 확정 뒤에서부터 밀린다.
 */
function formatPollStatus(poll) {
  var single = poll.options.length === 1;
  var when = "마감 " + poll.closesAtText + " · " + (poll.open ? poll.timeLeftText : "마감되었습니다");
  var blocks = [poll.title + "\n" + when];

  for (var i = 0; i < poll.options.length; i++) {
    var o = poll.options[i];
    var prefix = single ? "" : "[" + o.label + "] ";
    var count = o.capacity === null ? String(o.confirmed.length) : o.confirmed.length + "/" + o.capacity;
    var b = prefix + "확정 " + count;
    if (o.confirmed.length > 0) b += "\n" + nameLines(o.confirmed, true);
    blocks.push(b);
    if (o.waiting.length > 0) {
      blocks.push(prefix + "대기 " + o.waiting.length + "\n" + nameLines(o.waiting, true));
    }
  }
  return blocks.join("\n\n");
}

/** 그 방의 투표만 보인다 — 투표는 단톡방 단위다(decision 032). */
function handlePollStatus(room) {
  var res = apiGet("/api/bot/poll", { room: String(room) });
  if (res.error) return res.error;
  if (!res.poll) return NO_POLL;
  return formatPollStatus(res.poll);
}

/**
 * `!내순번` — 내 자리만. **`!참석`으로 확인하면 안 되기 때문에 있다** — 신청 안 한 사람이
 * 치면 그대로 신청된다. 정원이 줄어 확정에서 대기로 밀렸는지 확인하는 자리이기도 하다.
 * 그 통보는 봇이 메시지함으로 올리지만(decision 032), 지나간 메시지를 찾기보다 쳐보는 게 빠르다.
 */
function handleMyRank(sender, room) {
  var res = apiGet("/api/bot/poll", { voterName: String(sender), room: String(room) });
  if (res.error) return res.error;
  if (!res.poll) return NO_POLL;

  var me = res.me;
  var text;
  if (!me) text = String(sender) + " 님은 신청 내역이 없습니다.";
  else if (me.confirmed)
    text = String(sender) + " 님 " + me.optionLabel + " 확정 " + me.rank + "번 (" + attendCount(me) + ")";
  else
    text = String(sender) + " 님 " + me.optionLabel + " 대기 " + me.waitingRank + "번 (" + attendCount(me) + " 마감)";

  if (!res.poll.open) text += "\n" + res.poll.title + " 투표는 마감되었습니다.";
  return text;
}

/**
 * `!도움말`. **투표 줄은 그때그때 서버에 물어서 붙인다** — 그래서 도움말이 네트워크를 탄다.
 *
 * 서버가 안 붙으면 투표 줄만 빼고 기본 도움말을 낸다. 도움말이 안 나오는 것보다 투표 줄이
 * 빠지는 게 낫고, 원인은 `!핑`이 짚는다.
 *
 * **개인톡에서는 묻지 않는다.** 투표는 단톡방에만 연결되므로(decision 032) 개인톡에 붙을 투표가
 * 없다. 단톡방에서는 그 방에 연결된 투표가 있을 때만 투표 줄이 붙는다.
 */
function handleHelp(room, isGroupChat) {
  if (!isGroupChat) return helpText();

  var res = apiGet("/api/bot/poll", { room: String(room) });
  // 버전이 다르면 도움말이 알려주는 명령이 전부 같은 답만 낸다. 그걸 먼저 말한다.
  if (res.kind === "version") return res.error;
  if (res.error) {
    Log.i("[" + scriptName + "] help: 투표 확인 실패, 기본 도움말만 — " + res.error);
    return helpText();
  }
  if (!res.poll) return helpText();
  return pollHelp(res.poll) + "\n" + helpText();
}

/** `!취소` — 취소. 마감 후에는 서버가 거부한다(명단 동결). */
function handleCancel(sender, room) {
  var res = apiSend("DELETE", "/api/bot/poll", { voterName: String(sender), room: String(room) });
  if (res.error) {
    if (res.code === "NOT_VOTED") return String(sender) + " 님은 신청 내역이 없습니다.";
    return res.error;
  }
  // 승계가 있으면 서버가 메시지함에 쌓았다 — 답장 뒤에 바로 꺼내 올린다.
  if (res.promoted) outboxDirty = true;
  return formatCancel(res);
}

/**
 * `!투표시작 <코드>` — 웹에서 연 투표를 **이 단톡방에 연결한다**(decision 032). 총무가 친다.
 *
 * 답장이 곧 개시 공지다 — 문구는 서버가 만든다(템플릿의 공지 문구, 명단 링크, 이미 신청이 있으면
 * "지금까지 신청" 줄). **코드는 한 번 쓰면 끝이다**(decision 034) — 총무가 치는 순간 그 방 모두가
 * 보므로, 연결된 투표의 코드는 어느 방에서 쳐도 서버가 거부한다. 옮기려면 웹에서 연결을 해제하고
 * 새 코드로 다시 친다. 거부 문구도 서버가 준다(`res.error`).
 *
 * 연결되면 서버가 이 방의 알림을 1분 간격으로 챙기기 시작하므로, 답장 뒤에 바로 한 번 묻는다.
 */
function handleBind(params, room, isGroupChat) {
  if (!isGroupChat) return "투표는 단톡방에서 연결합니다. 진행할 단톡방에서 쳐 주세요.";
  if (params.length === 0) return "사용법: !투표시작 <웹에 나온 4자리 코드>";

  var res = apiSend("POST", "/api/bot/poll/bind", { code: params[0], room: String(room) });
  if (res.error) return res.error;

  outboxDirty = true;
  return res.announcement;
}

// ============================================================
// 메시지함 — 봇이 단톡방에 먼저 올리는 모든 것 (decision 032)
// ============================================================
//
// 메신저봇R은 알림의 답장 버튼으로 보내므로, 봇이 켜진 뒤 그 방에서 알림을 한 번이라도 받았으면
// `Api.replyRoom`으로 아무 때나 보낼 수 있다. 그 전제 위에서 길을 하나로 합쳤다:
//
//     서버가 메시지함에 쌓는다 → 봇이 물어서 꺼낸다 → 그 방에 올린다 → 보냈다고 알린다
//
// 마감 1시간·30분 전 알림, 마감 공지, `!취소`의 승계, 총무의 웹 조작(삭제·게스트·정원·마감 변경)이
// 전부 이 길로 온다. **문구는 서버가 만든다** — 봇은 받은 `text`를 받은 `room`에 그대로 올린다.
// 그래서 문구를 고칠 때 태블릿을 안 만진다.
//
// **언제 물을지도 서버가 정한다.** 간격이 상대값(ms)이라 태블릿 시계가 틀려도 상관없다. 연결된
// 투표가 열려 있으면 1분, 없으면 30분. 명령에 답한 직후에도 묻는다(`!취소`의 승계가 답장 바로 뒤에).
//
// 봇이 뜬 뒤 그 방에서 메시지를 한 번도 못 받았으면(태블릿·앱 재시작 직후) 그 방엔 못 보낸다 —
// 그때는 그 방에 다음 메시지가 올 때 보낸다. 메시지가 왔다는 게 곧 세션이 생겼다는 뜻이다.

var OUTBOX_FIRST_MS = 5000;              // 로드 직후 첫 확인
var OUTBOX_RETRY_MS = 10 * 60 * 1000;    // 서버를 못 붙었을 때
// 타이머가 이만큼 밀렸으면 멈춘 걸로 본다. 안드로이드가 화면 꺼진 태블릿의 CPU를 재우면
// 타이머가 제때 안 돈다 — 그래도 카톡 알림은 기기를 깨우므로, 메시지가 오면 밀린 확인을 한다.
var OUTBOX_OVERDUE_MS = 30 * 1000;

var outboxTimer = null;
var outboxDueAt = 0;          // 다음 확인 예정 시각 (태블릿 시계)
var outboxBlocked = {};       // 방 이름 → true: 세션이 없어 못 보낸 메시지가 있다
var outboxDirty = false;      // 방금 명령이 메시지를 쌓았을 수 있다 — 답장 뒤에 바로 묻는다
var outboxStopped = false;    // 재컴파일이 시작됐다 — 옛 스크립트는 더 예약하지 않는다
var outboxAcking = {};        // 보냈는데 서버 기록이 실패한 메시지 id. 다시 보내지 않고 기록만 다시 한다
// 타이머와 메시지 처리가 같은 스레드라는 보장이 없다. 둘이 동시에 꺼내면 같은 메시지가
// 두 번 나가므로 하나만 들어가게 한다.
var outboxLock = new java.util.concurrent.atomic.AtomicBoolean(false);

/** 이름 다섯 개씩 한 줄. 카톡이 긴 줄을 이름 중간에서 끊으면 누가 누군지 안 읽힌다. */
var NAMES_PER_LINE = 5;

function nameLines(names, numbered) {
  var lines = [];
  var cur = [];
  for (var i = 0; i < names.length; i++) {
    cur.push(numbered ? (i + 1) + ". " + names[i] : names[i]);
    if (cur.length === NAMES_PER_LINE) {
      lines.push(cur.join(numbered ? "  " : ", "));
      cur = [];
    }
  }
  if (cur.length > 0) lines.push(cur.join(numbered ? "  " : ", "));
  return lines.join(numbered ? "\n" : ",\n");
}

/**
 * 메시지 하나를 그 방에 올리고 서버에 기록한다. 못 보냈으면 false.
 *
 * **순서는 보내기 → 기록이다.** 기록을 먼저 하면 세션이 없어 못 보낸 메시지가 보낸 것으로 남아
 * 영영 안 나간다. 기록이 실패하면 다음 확인 때 같은 메시지가 또 오는데, `outboxAcking`에 id가
 * 있으면 다시 보내지 않고 기록만 다시 한다.
 *
 * 반환값은 `String()`으로 본다. 메신저봇R이 Java `boolean`을 주는지 `Boolean` 객체를 주는지
 * 모르고, 객체로 감싸져 오면 `!ok`가 항상 false라 실패를 성공으로 읽는다.
 */
function sendOutboxMessage(m) {
  if (!outboxAcking[m.id]) {
    if (typeof Api.canReply === "function" && String(Api.canReply(m.room)) === "false") {
      Log.i("[" + scriptName + "] outbox 보류 — " + m.room + " 세션 없음, 그 방에 메시지가 오면 보낸다");
      return false;
    }
    if (String(Api.replyRoom(m.room, m.text)) === "false") {
      Log.i("[" + scriptName + "] outbox 보류 — " + m.room + " replyRoom 실패");
      return false;
    }
    outboxAcking[m.id] = true;
    Log.i("[" + scriptName + "] outbox sent " + m.text.length + " chars → " + m.room);
  }

  var ack = apiSend("POST", "/api/bot/outbox", { id: m.id });
  if (ack.error) {
    Log.e("[" + scriptName + "] outbox 기록 실패 — 다음 확인 때 기록만 다시 한다: " + ack.error);
    return true;
  }
  delete outboxAcking[m.id];
  return true;
}

function scheduleOutboxCheck(ms) {
  if (outboxStopped) return;
  outboxDueAt = Date.now() + ms;
  // 타이머가 없는 버전이면 메시지가 올 때만 확인한다(`maybeCheckOutbox`). 정시성은
  // 잃지만 메시지 자체는 나간다.
  if (typeof setTimeout !== "function") return;
  if (outboxTimer !== null && typeof clearTimeout === "function") clearTimeout(outboxTimer);
  outboxTimer = setTimeout(function () { checkOutbox("timer"); }, ms);
}

/** 서버에 물어서 메시지를 꺼내 올리고, 서버가 준 간격으로 다음 확인을 예약한다. */
function checkOutbox(source) {
  if (!outboxLock.compareAndSet(false, true)) return;
  var next = OUTBOX_RETRY_MS;
  try {
    outboxDirty = false;
    var res = apiGet("/api/bot/outbox", {});
    if (res.error) {
      Log.e("[" + scriptName + "] outbox 확인 실패(" + source + "): " + res.error);
      return;
    }
    if (res.nextCheckMs) next = Number(res.nextCheckMs);

    outboxBlocked = {};
    var messages = res.messages || [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      // 한 방이 막히면 그 방의 뒤 메시지도 같은 이유(세션)로 막힌다. 순서를 지키려고 그 방은
      // 거기서 멈추고, 다른 방은 계속 보낸다.
      if (outboxBlocked[m.room]) continue;
      if (!sendOutboxMessage(m)) outboxBlocked[m.room] = true;
    }
  } catch (e) {
    Log.e("[" + scriptName + "] outbox " + e + " @ " + (e.lineNumber || "?"));
  } finally {
    outboxLock.set(false);
    if (next > 0) scheduleOutboxCheck(next);
  }
}

/**
 * 메시지가 왔을 때(그 답장 뒤에). **밀린 게 있을 때만** 서버에 묻는다 — 방금 명령이 메시지를
 * 쌓았을 수 있거나, 이 방에 못 보낸 메시지가 있거나(이제 세션이 생겼다), 타이머가 제때 안 돌았거나.
 * 평소 대화마다 묻지 않는다.
 */
function maybeCheckOutbox(room) {
  if (!outboxDirty && !outboxBlocked[String(room)] && Date.now() < outboxDueAt + OUTBOX_OVERDUE_MS) return;
  checkOutbox("message");
}

function handlePing() {
  var cfg = getConfig();
  if (!cfg) return "봇 ✅\n설정 ❌\n" + configError;

  // 조회 라우트 대신 전용 health를 친다. !회비로 확인하면 토큰 문제인지 DB 문제인지
  // 이름을 못 찾은 건지 섞여서 구분이 안 된다.
  var res = apiGet("/api/bot/health", {});

  if (res.kind === "auth") return "봇 ✅\n설정 ✅\n서버 ✅\n토큰 ❌ — 서버와 값이 다릅니다";
  if (res.kind === "network") return "봇 ✅\n설정 ✅\n서버 ❌ — 연결되지 않습니다";
  // 서버가 토큰 다음에 버전을 본다(decision 033). 문구에 어느 쪽을 올릴지가 들어 있다.
  if (res.kind === "version") return "봇 ✅\n설정 ✅\n서버 ✅\n토큰 ✅\n버전 ❌ — " + res.error;
  if (res.error) return "봇 ✅\n설정 ✅\n서버 ⚠️ — " + res.error;

  // 서버는 살아있는데 DB만 죽은 경우를 가른다. 그래야 "서버 정상인데 조회가 안 된다"를
  // 설명할 수 있다.
  var dbLine = res.db ? "DB ✅" : "DB ❌ — 서버는 살아있으나 조회 불가";
  return "봇 ✅\n설정 ✅\n서버 ✅\n토큰 ✅\n" + versionLine(res.apiVersion) + "\n" + dbLine;
}

/**
 * 통과했어도 숫자가 다를 수 있다 — 서버는 최소 버전 이상이면 받아준다. 그때는 둘 다 보여준다.
 * `apiVersion`이 없으면 버전 검사가 들어가기 전의 서버다.
 */
function versionLine(serverVersion) {
  if (serverVersion === undefined || serverVersion === null) return "버전 ✅ 봇 v" + BOT_API_VERSION + " · 서버 v?";
  if (Number(serverVersion) === BOT_API_VERSION) return "버전 ✅ v" + BOT_API_VERSION;
  return "버전 ✅ 봇 v" + BOT_API_VERSION + " · 서버 v" + serverVersion;
}

function handleUnpaid() {
  var res = apiGet("/api/bot/unpaid", {});
  if (res.error) return res.error;
  return formatUnpaid(res);
}

// sender/room이 여기까지 내려오는 건 참석 투표 때문이다 — 조회 명령어는 안 쓴다.
function handleCommand(command, params, sender, room, isGroupChat) {
  switch (command) {
    case "회비":
      return handleDues(params);

    case "게스트비":
      return handleGuest(params);

    case "참석":
      return handleAttend(params, sender, room);

    case "취소":
      return handleCancel(sender, room);

    case "투표현황":
      return handlePollStatus(room);

    case "내순번":
      return handleMyRank(sender, room);

    case "투표시작":
      return handleBind(params, room, isGroupChat);

    case "미납":
      return handleUnpaid();

    case "핑":
    case "ping":
      return handlePing();

    case "도움말":
    case "도움":
      return handleHelp(room, isGroupChat);

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
    Log.i("[" + scriptName + "] recv room=" + room + " len=" + (msg ? msg.length : 0));
    var dbg = configCache && configCache.debug;
    if (dbg) Log.i("[" + scriptName + "] msg=" + msg + " sender=" + sender + " group=" + isGroupChat);
  } catch (e) {
    // 로그가 실패해도 본 흐름은 계속한다
  }

  if (msg && msg.charAt(0) === "!") handleMessage(room, msg, sender, isGroupChat, replier);

  // **명령어 답장 뒤에** 본다 — 메시지함 확인이 HTTP 한 번만큼 답장을 늦추지 않게, 그리고
  // `!취소`의 승계가 취소 답장 바로 뒤에 뜨게. `!`가 아닌 평범한 대화에도 돈다 — 세션 없이
  // 밀려 있던 메시지는 그 방에 아무 메시지나 와야 나갈 수 있기 때문이다.
  try {
    maybeCheckOutbox(room);
  } catch (e) {
    Log.e("[" + scriptName + "] outbox " + e);
  }
}

function handleMessage(room, msg, sender, isGroupChat, replier) {
  var parts = msg.trim().split(/\s+/);
  var command = parts[0].substring(1);
  var params = parts.slice(1);

  try {
    Log.i("[" + scriptName + "] cmd=" + command);
    var reply = handleCommand(command, params, sender, room, isGroupChat);
    if (reply) {
      replier.reply(reply);
      Log.i("[" + scriptName + "] replied " + reply.length + " chars");
    } else {
      Log.i("[" + scriptName + "] no handler for '" + command + "'");
    }
  } catch (e) {
    Log.e("[" + scriptName + "] " + e + " @ " + (e.lineNumber || "?"));
    replier.reply("오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
  }
}

/**
 * 메신저봇R이 스크립트를 **다시 읽기 직전에** 부른다. 옛 스크립트의 타이머를 여기서
 * 끄지 않으면 재컴파일할 때마다 타이머가 하나씩 쌓여 같은 메시지가 여러 번 나간다 —
 * 다른 봇에서 스레드 16개가 쌓여 같은 메시지가 6~7번 나간 사례가 있다.
 */
function onStartCompile() {
  outboxStopped = true;
  if (outboxTimer !== null && typeof clearTimeout === "function") clearTimeout(outboxTimer);
  outboxTimer = null;
}

// ============================================================
// 액티비티 라이프사이클
// ============================================================
//
// 봇 설정 화면용 콜백이고 메시지 처리와는 무관하다. 그래도 두는 이유는, 메신저봇R이
// 봇을 새로 만들 때 넣어주는 기본 템플릿에 이것들이 들어있기 때문이다. 동작하는
// 봇(nbcbot)에는 있고 이 파일에만 없는 차이였고, 없어서 문제가 되는지 확인할 방법이
// 없어 그냥 맞췄다. 비용이 0이다.

function onCreate(savedInstanceState, activity) {
  var view = new android.widget.TextView(activity);
  view.setText("NBC 회비 봇\n\n!참석 [선택지]\n!취소\n!투표현황\n!내순번\n!투표시작 <코드> (총무)\n!회비 <이름>\n!게스트비 <이름>\n!미납\n!핑");
  view.setTextColor(android.graphics.Color.DKGRAY);
  activity.setContentView(view);
}

function onStart(activity) {}

function onResume(activity) {}

function onPause(activity) {}

function onStop(activity) {}

// ============================================================
// 시작
// ============================================================
//
// 파일 끝에서 건다. 위의 `var` 초기화가 전부 끝난 뒤여야 한다 — 함수 선언은
// 끌어올려지지만 `outboxLock` 같은 값은 그 줄을 지나야 생긴다.
scheduleOutboxCheck(OUTBOX_FIRST_MS);
