import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
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
 * 흉내내는 것은 넷뿐이다 — Log / FileStream / replier / response() 호출.
 * `java.net.URL`, `BufferedReader`, `StringBuilder`는 Rhino의 LiveConnect가
 * 진짜로 제공하므로 손대지 않는다. 그래서 HTTP 경로가 태블릿과 같은 코드로 돈다.
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

  /** replier.reply — 답장을 모은다. 봇은 받은 자리에만 답하므로 이게 출력의 전부다. */
  public static class ReplierShim {
    final List<String> replies = new ArrayList<>();
    public void reply(Object m) { replies.add(String.valueOf(m)); }
    public void reply(Object room, Object m) { replies.add(String.valueOf(m)); }
  }

  // ── 실행 ──────────────────────────────────────────────────

  public static void main(String[] args) throws Exception {
    String script = "nbcdues.js";
    String configPath = null;
    String room = "테스트방";
    String sender = "원동현";
    boolean isGroupChat = true;
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
        if (!t.isEmpty() && !t.startsWith("#")) messages.add(t);
      }
    }

    StringBuilder transcript = new StringBuilder();
    for (String msg : messages) {
      transcript.append("> ").append(msg).append("\n");
      List<String> replies = run(script, configPath, room, msg, sender, isGroupChat, optLevel, langVersion);
      if (replies.isEmpty()) {
        transcript.append("(무응답)\n");
      } else {
        for (String r : replies) transcript.append(r).append("\n");
      }
      transcript.append("\n");
    }

    String out = transcript.toString();

    if (snapshot == null) {
      System.out.print(out);
      return;
    }

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

  /** 메시지 하나를 봇에 넣고 답장을 받는다. 스크립트는 매번 새로 로드한다 —
   *  메신저봇R도 봇마다 독립 스코프이고, 캐시(configCache)가 테스트 사이에 새는 걸 막는다. */
  static List<String> run(String script, String configPath, String room, String msg,
                          String sender, boolean isGroupChat, int optLevel, int langVersion)
      throws Exception {
    Context cx = Context.enter();
    try {
      cx.setOptimizationLevel(optLevel);
      cx.setLanguageVersion(langVersion);
      Scriptable scope = cx.initStandardObjects();

      ReplierShim replier = new ReplierShim();
      ScriptableObject.putProperty(scope, "Log",
          Context.javaToJS(new LogShim(), scope));
      ScriptableObject.putProperty(scope, "FileStream",
          Context.javaToJS(new FileStreamShim(configPath == null ? null : Paths.get(configPath)), scope));

      String src = new String(Files.readAllBytes(Paths.get(script)), StandardCharsets.UTF_8);
      cx.evaluateString(scope, src, script, 1, null);

      Object fn = scope.get("response", scope);
      if (!(fn instanceof Function)) throw new IllegalStateException("response()가 없습니다");

      ((Function) fn).call(cx, scope, scope, new Object[] {
          room, msg, sender, isGroupChat,
          Context.javaToJS(replier, scope),
          Undefined.instance,          // imageDB
          "com.kakao.talk"             // packageName
      });
      return replier.replies;
    } finally {
      Context.exit();
    }
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
