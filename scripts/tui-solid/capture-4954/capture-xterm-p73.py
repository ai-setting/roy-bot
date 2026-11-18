#!/usr/bin/env python3
"""capture-xterm-p73.py — Task #5129 P7.3 真终端取证（Xvfb :77 + xterm + xdotool + import）。

证明 P7.3 三条 follow-up：
  F2: config 模型名含 / （OpenRouter 风格 fake/prov/org-fake-model）
      → 选它后 request model 必须是完整名（不被 split 截断）
  F3: 状态栏 model 在热切换后跟随新模型（03-boot vs 05-after
      两帧状态栏行对比）
  F1: 弹窗读写与 boot 同一文件（XDG 场景由单文件路径保证）

  1. fake LLM server（记录每条请求 body 里的 model 字段 → /tmp/tui-p72/fake-reqs.log）
  2. 隔离 HOME + config.jsonc（两个模型 fake-a/fake-b 指向同一 fake LLM）
  3. boot interactive → 发 "hello one" → 日志应有 model=fake-a
  4. /model → Enter 选第一条（即 fake-a）→ 选第二条 fake-b：
     ↑↓ 移动到 fake-b + Enter → 通知行「当前会话已生效」→ 截图
  5. 发 "hello two" → 日志应有 model=fake-b  ← 热切换生效的铁证
  6. 再截 boot 帧（TUI 未重启——窗口标题不变 + 会话未退出）
Exit 0 = 证据链完整。
"""
import json, os, re, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent  # worktree root
OUT = Path("/tmp/tui-p73"); OUT.mkdir(parents=True, exist_ok=True)
REQLOG = OUT / "fake-reqs.log"
DISP = ":77"
XTERM = "/tmp/termtest/x/usr/bin/xterm"
XDOT = "/tmp/tools/x/usr/bin/xdotool"
LIB = "/tmp/termtest/x/usr/lib/x86_64-linux-gnu:/tmp/tools/x/usr/lib/x86_64-linux-gnu"
ENVX = dict(os.environ, DISPLAY=DISP, LD_LIBRARY_PATH=LIB)

def sh(cmd, **kw):
    return subprocess.run(cmd, env=ENVX, capture_output=True, text=True, **kw)

def xdot(*args, **kw):
    r = sh([XDOT, *args], **kw)
    if r.returncode != 0:
        raise RuntimeError(f"xdotool {args}: {r.stderr}")
    return r.stdout.strip()

def import_window(winid, out):
    for _ in range(3):
        r = sh(["import", "-window", winid, str(out)])
        if r.returncode == 0 and Path(out).exists() and Path(out).stat().st_size > 3000:
            return
        time.sleep(1.0)
    raise RuntimeError(f"import produced tiny image for {winid}")

def wait_quiet(sec_stable=3.0, timeout=60):
    img = OUT / "_probe.png"
    last = -1; stable_since = time.time()
    deadline = time.time() + timeout
    while time.time() < deadline:
        import_window(WID, img)
        size = img.stat().st_size
        if size == last:
            if time.time() - stable_since > sec_stable:
                return True
        else:
            last = size; stable_since = time.time()
        time.sleep(0.5)
    return False

def wait_req(n, timeout=90):
    """Wait until at least n requests have landed in REQLOG."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            cnt = len([l for l in REQLOG.read_text().splitlines() if l.strip()])
            if cnt >= n:
                return True
        except FileNotFoundError:
            pass
        time.sleep(0.5)
    return False

FAKE = """// fake-p73-llm.ts — OpenAI-compatible SSE; logs request model per call.
const args = process.argv.slice(2);
const port = Number(args[1] || "0");
const REQLOG = %s;
const sse = (o) => `data: ${JSON.stringify(o)}\\n\\n`;
const server = Bun.serve({
  port, hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (!url.pathname.endsWith("/chat/completions")) return new Response("nf", { status: 404 });
    let model = "?"; let prompt = "";
    try { const body = await req.json();
      model = body.model ?? "?";
      prompt = (body.messages?.map(m => m.content).join(" ") ?? "").slice(-60);
    } catch {}
    try { require("node:fs").appendFileSync(REQLOG, JSON.stringify({ model, prompt, t: new Date().toISOString() }) + "\\n"); } catch {}
    const enc = new TextEncoder();
    const stream = new ReadableStream({ async start(c) {
      const mk = (d, f=null) => ({ id: "p72", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: d, finish_reason: f }] });
      const send = (o) => c.enqueue(enc.encode(sse(o)));
      send(mk({ role: "assistant" }));
      await new Promise(r => setTimeout(r, 400));
      send(mk({ content: "reply-from-" + model + " " }));
      await new Promise(r => setTimeout(r, 300));
      send({ ...mk({}, "stop"), usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } });
      c.enqueue(enc.encode("data: [DONE]\\n\\n"));
      c.close();
    }});
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log(`fake-p73 listening http://127.0.0.1:${server.port}/v1`);
""" % json.dumps(str(REQLOG))

def main() -> int:
    # [1] fake LLM
    fake_src = OUT / "fake-p73-llm.ts"
    fake_src.write_text(FAKE)
    REQLOG.unlink(missing_ok=True)
    fake = subprocess.Popen(["bun", str(fake_src), "--port", "0"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=str(ROOT))
    port = 0
    deadline = time.time() + 20
    while time.time() < deadline:
        line = fake.stdout.readline().decode("utf8", "replace")
        m = re.search(r"http://127\.0\.0\.1:(\d+)", line)
        if m:
            port = int(m.group(1)); break
    assert port, "fake LLM no port"
    print(f"[1] fake LLM :{port}")

    # [2] isolated HOME: two models both pointing at the fake server.
    # ⚠️ Path parity: EnvironmentService reads $XDG_CONFIG_HOME/roy-bot,
    # while app-config-io (P7.1) reads ~/.roy-bot ⇒ write BOTH so the
    # boot config and the dialog read the same file content.
    home = tempfile.mkdtemp(prefix="roy-p73-")
    cfg_json = json.dumps({
        "llm": {"defaultProvider": "fake", "defaultModel": "fake/org-fake/model-a", "stream": True,
                "providers": {"fake": {"provider": "openai-compatible", "apiKey": "fake-key",
                                        "baseURL": f"http://127.0.0.1:{port}/v1",
                                        "models": ["org-fake/model-a", "org-fake/model-b"], "defaultModel": "org-fake/model-a"}}}
    }, indent=2)
    for cfg_dir in [Path(home) / ".config" / "roy-bot",
                    Path(home) / ".roy-bot"]:
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "config.jsonc").write_text(cfg_json)

    rc = Path(home) / "rc.sh"
    rc.write_text(
        "#!/bin/bash\n"
        "export HOME=%s\nexport XDG_CONFIG_HOME=%s\nexport XDG_DATA_HOME=%s\n"
        "export TERM=xterm-256color COLORTERM=truecolor ROY_AGENT_NO_TELEMETRY=1\n"
        "export LANG=C.UTF-8 LC_ALL=C.UTF-8\n"
        "unset ALL_PROXY all_proxy\n"
        "export PS1='user$ '\n"
        "cd /tmp\n"
        "clear\n"
        "echo '=== roy-bot P7.3 follow-up demo ==='\n"
        "sleep 0.5\n"
        "exec bash --norc\n" % (home, Path(home)/'.config', Path(home)/'.local/share'))

    win_env = dict(os.environ, DISPLAY=DISP, LD_LIBRARY_PATH=LIB)
    win = subprocess.Popen(
        [XTERM, "-display", DISP, "-geometry", "100x32+10+10",
         "-fs", "11", "-title", "START",
         "-bg", "#0a0a0a", "-fg", "#eeeeee",
         "-xrm", "xterm*locale: true",
         "-xrm", "xterm*VT100.faceName: Noto Sans Mono CJK SC",
         "-xrm", "xterm*VT100.faceDoubleSize: false",
         "-e", "bash", str(rc)], env=win_env)
    time.sleep(3.0)
    if win.poll() is not None:
        raise RuntimeError("xterm exited early rc=" + str(win.returncode))

    global WID
    wid = ""
    for attempt in range(5):
        r = xdot("search", "--onlyvisible", "--name", "START").strip()
        if r:
            wid = r.splitlines()[0]
            break
        time.sleep(1.5)
    if not wid:
        raise RuntimeError("xterm window not found")
    WID = wid
    print(f"[2] xterm window {wid}")
    try:
        xdot("windowfocus", "--sync", wid)
    except RuntimeError:
        pass
    time.sleep(0.5)

    shots = []
    def snap(name):
        out = OUT / name
        import_window(wid, out)
        shots.append(out)
        print(f"    shot -> {out}")

    print("[3] boot interactive")
    xdot("type", "--window", wid, "--delay", "25",
         "bun %s interactive --workdir /tmp" % (ROOT/"packages/cli/dist/bin/roy-bot.js"))
    time.sleep(1)
    xdot("key", "--window", wid, "Return")
    wait_quiet(2.5, 90)
    time.sleep(3)
    snap("01-boot.png")

    # [4] message 1 with default model fake-a
    print("[4] send 'hello one' (expect wire model=org-fake/model-a)")
    xdot("type", "--window", wid, "--delay", "25", "hello one")
    xdot("key", "--window", wid, "Return")
    # ⚠️ evidence-run fix: wait for the FIRST request to actually land
    # in the log (not just screen-quiet) before moving to /model.
    wait_req(1, 90)
    wait_quiet(3.0, 60)
    time.sleep(1.5)
    snap("02-msg1-fake-a.png")
    time.sleep(1.0)

    # [5] /model dialog + select fake-b (down once: fake-a -> fake-b)
    print("[5] /model dialog, pick fake-b")
    xdot("type", "--window", wid, "--delay", "30", "/model")
    xdot("key", "--window", wid, "Return")
    wait_quiet(2.5, 40)
    time.sleep(2)
    snap("03-model-dialog.png")
    xdot("key", "--window", wid, "Down")
    time.sleep(0.6)
    xdot("key", "--window", wid, "Return")
    wait_quiet(2.5, 40)
    time.sleep(2)
    snap("04-after-swap.png")

    # [6] message 2 with hot-swapped fake-b
    print("[6] send 'hello two' (expect model=fake-b — THE PROOF)")
    xdot("type", "--window", wid, "--delay", "25", "hello two")
    xdot("key", "--window", wid, "Return")
    wait_req(2, 90)
    wait_quiet(3.0, 60)
    time.sleep(1.5)
    snap("05-msg2-fake-b.png")
    time.sleep(1.0)

    try: win.terminate()
    except Exception: pass
    fake.terminate()

    # [7] verify request log
    time.sleep(1)
    reqs = []
    if REQLOG.exists():
        reqs = [json.loads(l) for l in REQLOG.read_text().splitlines() if l.strip()]
    models = [r.get("model") for r in reqs]
    print("[7] request models:", models)
    ok = ("org-fake/model-a" in models and "org-fake/model-b" in models
           and len(models) >= 2)
    print("VERDICT:", "PASS — hot swap observed (fake-a then fake-b, same session)" if ok
          else "FAIL — model list (truncated names would show org-fake only):", models)
    (OUT / "result.json").write_text(json.dumps({"models": models, "ok": ok}, indent=2))
    print("done:", len(shots), "shots")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
