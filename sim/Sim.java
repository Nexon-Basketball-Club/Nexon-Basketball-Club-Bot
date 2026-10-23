import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;
import org.mozilla.javascript.Undefined;

/**
 * 메신저봇R 시뮬레이터 — 진짜 Rhino로 nbcdues.js를 돌린다.
 *
 * Node로는 이 봇을 검증할 수 없다. 실제로 `const`가 루프에서 첫 값을 눌러앉히는
 * 버그를 Node는 전혀 재현하지 못했고, 프로덕션에서야 발견됐다. 엔진이 달라서 나는
 * 문제는 그 엔진으로만 잡힌다.
 *
 * 흉내내는 것 — Log / FileStream / replier / response() 호출, 그리고 봇이 먼저 말을
 * 거는 공지(decision 031)를 위한 Api.replyRoom·canReply와 setTimeout.
 * `java.net.URL`, `BufferedReader`, `StringBuilder`는 Rhino의 LiveConnect가
 * 진짜로 제공하므로 손대지 않는다. 그래서 HTTP 경로가 태블릿과 같은 코드로 돈다.
 *
 * 스위트 지시어 (`@`로 시작하는 줄):
 *   @persist  스크립트를 한 번만 로드하고 줄마다 이어 쓴다 (태블릿처럼). 공지처럼
 *             줄 사이에 상태가 이어져야 하는 스위트가 쓴다. CLI로는 --persist
 *   @tick     예약된 타이머를 지금 발화시킨다. 다음 예약 간격을 같이 찍는다
 *   @room 방  이 스위트를 보낼 방. CLI로는 --room. `pollRoom`이 아닌 방에서 서버를 안 타는
 *             응답(기본 도움말)을 고정할 때 쓴다
 *
 * 스냅샷과 비교할 때는 시계에 달린 값(마감 시각·남은 시간·분기)을 가린다 — `mask()`.
 */
public class Sim {

  // ── 메신저봇R이 주는 전역들 ────────────────────────────────

  /** Log.i/e/d/w — 태블릿 로그 대신 stderr로. 답장과 섞이면 스냅샷이 더러워진다. */
  public static class LogShim {
    public void i(Object m) { System.err.println("[i] " + m); }
    public void e(Object m) { System.err.println("[e] " + m); }
    public void d(Object m) { System.err.println("[d] " + m); }
    public void w(Object m) { System.err.println("[w] " + m); }
  }

  /** FileStream.read — 없으면 null. 봇이 그 null을 보고 다음 경로로 넘어간다. */
  public static class FileStreamShim {
    private final Path override;
    FileStreamShim(Path override) { this.override = override; }

    public String read(String path) {
      Path p = override != null ? override : Paths.get(path);
      try {
        return Files.exists(p) ? new String(Files.readAllBytes(p), StandardCharsets.UTF_8) : null;
      } catch (Exception e) {
        return null;
      }
    }

    public boolean write(String path, String data) { return false; }
  }

  /** replier.reply — 받은 자리에 하는 답장. */
  public static class ReplierShim {
    final List<String> replies = new ArrayList<>();
    public void reply(Object m) { replies.add(String.valueOf(m)); }
    public void reply(Object room, Object m) { replies.add(String.valueOf(m)); }
  }

  /**
   * Api.replyRoom / canReply — 봇이 먼저 보내는 메시지.
   *
   * **세션을 진짜처럼 흉내낸다.** 메신저봇R은 알림의 답장 버튼으로 보내므로, 봇이 뜬 뒤
   * 그 방에서 메시지를 한 번이라도 받아야 보낼 수 있다. 그래서 로드 직후엔 세션이 없고,
   * `response()`가 불린 방에만 생긴다.
   *
   * 반환형이 원시 `boolean`이 아니라 `Boolean` **객체**인 건 일부러다. Rhino는 객체로
   * 돌려받은 값을 JS 원시값으로 안 풀어줄 수 있어서 `!ok`가 항상 false가 된다 — 태블릿이
   * 어느 쪽을 주는지 모르므로 더 까다로운 쪽으로 돌린다.
   */
  public static class ApiShim {
    final Set<String> sessions = new HashSet<>();
    final List<String> sent = new ArrayList<>();

    public Boolean canReply(Object room) { return Boolean.valueOf(sessions.contains(String.valueOf(room))); }

    public Boolean replyRoom(Object room, Object msg) {
      String r = String.valueOf(room);
      if (!sessions.contains(r)) return Boolean.FALSE;
      sent.add("[→ " + r + "]\n" + msg);
      return Boolean.TRUE;
    }
  }

  /**
   * setTimeout / clearTimeout — **실제로 기다리지 않는다.** 예약만 받아두고 `@tick`이
   * 발화시킨다. 기다리면 10분짜리 간격을 테스트할 수 없고, 언제 터질지가 시계에 달린다.
   */
  static final String TIMER_PRELUDE =
      "var __timers = {}; var __timerSeq = 0;\n" +
      "function setTimeout(fn, ms) { __timerSeq++; __timers[__timerSeq] = { fn: fn, ms: ms }; return __timerSeq; }\n" +
      "function clearTimeout(id) { delete __timers[id]; }\n" +
      // 가장 먼저 예약된 것 하나를 발화하고, 그 뒤 남은 예약의 간격을 돌려준다(없으면 -1).
      "function __tick() {\n" +
      "  var first = null;\n" +
      "  for (var k in __timers) { if (first === null || Number(k) < first) first = Number(k); }\n" +
      "  if (first === null) return -2;\n" +
      "  var t = __timers[first]; delete __timers[first]; t.fn();\n" +
      "  var next = -1;\n" +
      "  for (var k2 in __timers) next = __timers[k2].ms;\n" +
      "  return next;\n" +
      "}\n";

  /** 로드된 스크립트 하나. `@persist`면 스위트 내내 이것 하나를 쓴다. */
  static class Bot {
    Scriptable scope;
    final ReplierShim replier = new ReplierShim();
    final ApiShim api = new ApiShim();

    List<String> drain() {
      List<String> out = new ArrayList<>(replier.replies);
      out.addAll(api.sent);
      replier.replies.clear();
      api.sent.clear();
      return out;
    }
  }

  // ── 실행 ──────────────────────────────────────────────────

  public static void main(String[] args) throws Exception {
    String script = "nbcdues.js";
    String configPath = null;
    String room = "테스트방";
    String sender = "원동현";
    boolean isGroupChat = true;
    boolean persist = false;
    int optLevel = -1;                 // 안드로이드는 인터프리터 모드다. dex라 클래스 생성이 안 된다.
    int langVersion = Context.VERSION_ES6;
    String suite = null;
    String snapshot = null;
    boolean update = false;
    List<String> messages = new ArrayList<>();

    for (int i = 0; i < args.length; i++) {
      switch (args[i]) {
        case "--script":   script = args[++i]; break;
        case "--config":   configPath = args[++i]; break;
        case "--room":     room = args[++i]; break;
        case "--sender":   sender = args[++i]; break;
        case "--dm":       isGroupChat = false; break;
        case "--persist":  persist = true; break;
        case "--opt":      optLevel = Integer.parseInt(args[++i]); break;
        case "--lang":     langVersion = Integer.parseInt(args[++i]); break;
        case "--suite":    suite = args[++i]; break;
        case "--snapshot": snapshot = args[++i]; break;
        case "--update":   update = true; break;
        default:           messages.add(args[i]);
      }
    }

    if (suite != null) {
      for (String line : Files.readAllLines(Paths.get(suite), StandardCharsets.UTF_8)) {
        String t = line.trim();
        if (t.isEmpty() || t.startsWith("#")) continue;
        if (t.equals("@persist")) { persist = true; continue; }
        if (t.startsWith("@room ")) { room = t.substring(6).trim(); continue; }
        messages.add(t);
      }
    }

    Path cfg = configPath == null ? null : Paths.get(configPath);
    Bot shared = persist ? load(script, cfg, optLevel, langVersion) : null;

    StringBuilder transcript = new StringBuilder();
    for (String msg : messages) {
      transcript.append("> ").append(msg).append("\n");
      // 스크립트는 기본적으로 줄마다 새로 로드한다 — 메신저봇R도 봇마다 독립 스코프이고,
      // 캐시(configCache)가 테스트 사이에 새는 걸 막는다. `@persist`면 태블릿처럼 이어 쓴다.
      Bot bot = shared != null ? shared : load(script, cfg, optLevel, langVersion);

      String note = null;
      if (msg.equals("@tick")) {
        double next = tick(bot, optLevel, langVersion);
        note = next == -2 ? "(예약된 타이머 없음)"
            : next < 0 ? "(다음 확인 예약 없음)"
            : "(다음 확인 " + formatDelay(next) + " 뒤)";
      } else {
        send(bot, room, msg, sender, isGroupChat, optLevel, langVersion);
      }

      List<String> out = bot.drain();
      if (out.isEmpty()) {
        transcript.append("(무응답)\n");
      } else {
        for (String r : out) transcript.append(r).append("\n");
      }
      if (note != null) transcript.append(note).append("\n");
      transcript.append("\n");
    }

    String out = transcript.toString();

    if (snapshot == null) {
      System.out.print(out);
      return;
    }
    out = mask(out);

    Path snap = Paths.get(snapshot);
    if (update || !Files.exists(snap)) {
      if (Files.exists(snap)) {
        String before = new String(Files.readAllBytes(snap), StandardCharsets.UTF_8);
        if (before.equals(out)) { System.out.println("스냅샷 변화 없음: " + snapshot); return; }
        System.out.println("=== 스냅샷이 바뀝니다: " + snapshot + " ===");
        printDiff(before, out);
      }
      Files.createDirectories(snap.getParent());
      Files.write(snap, out.getBytes(StandardCharsets.UTF_8));
      System.out.println("스냅샷 갱신: " + snapshot);
      return;
    }

    String expected = new String(Files.readAllBytes(snap), StandardCharsets.UTF_8);
    if (expected.equals(out)) {
      System.out.println("PASS  " + snapshot);
    } else {
      System.out.println("FAIL  " + snapshot);
      printDiff(expected, out);
      System.out.println("\n의도한 변경이면 --update 로 갱신하세요.");
      System.exit(1);
    }
  }

  static Context enter(int optLevel, int langVersion) {
    Context cx = Context.enter();
    cx.setOptimizationLevel(optLevel);
    cx.setLanguageVersion(langVersion);
    return cx;
  }

  /** 스크립트를 로드한다. 최상단 코드(공지 타이머 예약 포함)가 여기서 돈다. */
  static Bot load(String script, Path configPath, int optLevel, int langVersion) throws Exception {
    Context cx = enter(optLevel, langVersion);
    try {
      Bot bot = new Bot();
      bot.scope = cx.initStandardObjects();
      ScriptableObject.putProperty(bot.scope, "Log", Context.javaToJS(new LogShim(), bot.scope));
      ScriptableObject.putProperty(bot.scope, "FileStream",
          Context.javaToJS(new FileStreamShim(configPath), bot.scope));
      ScriptableObject.putProperty(bot.scope, "Api", Context.javaToJS(bot.api, bot.scope));
      cx.evaluateString(bot.scope, TIMER_PRELUDE, "<sim-timers>", 1, null);

      String src = new String(Files.readAllBytes(Paths.get(script)), StandardCharsets.UTF_8);
      cx.evaluateString(bot.scope, src, script, 1, null);
      return bot;
    } finally {
      Context.exit();
    }
  }

  /** 메시지 하나를 봇에 넣는다. **그 방에 세션이 생긴다** — 알림을 받았다는 뜻이므로. */
  static void send(Bot bot, String room, String msg, String sender, boolean isGroupChat,
                   int optLevel, int langVersion) {
    Context cx = enter(optLevel, langVersion);
    try {
      bot.api.sessions.add(room);
      Object fn = bot.scope.get("response", bot.scope);
      if (!(fn instanceof Function)) throw new IllegalStateException("response()가 없습니다");

      ((Function) fn).call(cx, bot.scope, bot.scope, new Object[] {
          room, msg, sender, isGroupChat,
          Context.javaToJS(bot.replier, bot.scope),
          Undefined.instance,          // imageDB
          "com.kakao.talk"             // packageName
      });
    } finally {
      Context.exit();
    }
  }

  /** 예약된 타이머를 발화한다. 반환: 다음 예약 간격(ms), 없으면 -1, 발화할 게 없었으면 -2. */
  static double tick(Bot bot, int optLevel, int langVersion) {
    Context cx = enter(optLevel, langVersion);
    try {
      Function fn = (Function) bot.scope.get("__tick", bot.scope);
      return Context.toNumber(fn.call(cx, bot.scope, bot.scope, new Object[0]));
    } finally {
      Context.exit();
    }
  }

  /** 600000 → "10분". 분으로 안 떨어지면 초로 — 스냅샷이 밀리초 오차로 흔들리지 않게 반올림한다. */
  static String formatDelay(double ms) {
    long sec = Math.round(ms / 1000);
    if (sec % 60 == 0) return (sec / 60) + "분";
    return sec + "초";
  }

  /**
   * 스냅샷에 남길 때 **시계에 달린 값만** 가린다. 마감 시각·남은 시간은 시나리오를 심은 시각에,
   * 분기는 오늘 날짜에 따라 바뀌어서 그대로 찍으면 다음 날(다음 분기) 깨진다. 실제로 분기가
   * Q3→Q4로 넘어가며 same-name이 아무것도 안 고쳤는데 FAIL이 됐다.
   *
   * **형식은 남기고 값만 지운다.** 줄이 사라지거나 모양이 바뀌면 여전히 잡힌다. 화면에 찍을 때
   * (스냅샷 없이)는 가리지 않는다.
   *
   * 공지 스위트가 확인하는 "마감 45분 전입니다"(서버가 준 남은 분)와 "(다음 확인 10분 뒤)"는
   * 걸리지 않는다 — 시나리오가 고정한 값이라 가리면 확인할 게 없어진다. "3자리 남음"도 안 걸린다.
   */
  static String mask(String s) {
    return s
        .replaceAll("\\d{1,2}/\\d{1,2} \\([월화수목금토일]\\) \\d{2}:\\d{2}", "M/D (요) HH:MM")
        .replaceAll("(\\d+일 \\d+시간|\\d+시간 \\d+분|\\d+분) 남음", "N 남음")
        .replaceAll("\\d{4} Q[1-4] 회원", "YYYY Qn 회원");
  }

  /** 줄 단위로 첫 차이 지점을 보여준다. 스냅샷이 길어도 어디가 바뀌었는지 바로 보이게. */
  static void printDiff(String expected, String actual) {
    String[] e = expected.split("\n", -1);
    String[] a = actual.split("\n", -1);
    int n = Math.max(e.length, a.length);
    for (int i = 0; i < n; i++) {
      String le = i < e.length ? e[i] : null;
      String la = i < a.length ? a[i] : null;
      if (le == null) System.out.println("  + " + la);
      else if (la == null) System.out.println("  - " + le);
      else if (!le.equals(la)) { System.out.println("  - " + le); System.out.println("  + " + la); }
    }
  }
}
