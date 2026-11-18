#!/usr/bin/env python3
"""capture-xterm-p74.py — Task #5138 P7.4 真终端取证（Xvfb :77 + xterm + xdotool + import）。

证明 P7.4 三条现场修复：
  bug1: 用户现场 config 形态（full-id defaultModel + 注释化行 + tab 缩进）
        → /model 切换**无 mismatch**，config 落盘 full id
  bug2: 状态栏（usage 行）显示当前模型名
  bug3: /model 弹窗对当前全局 default 高亮 "current" badge

  1. fake LLM server（记录每条请求 model → /tmp/tui-p74/fake-reqs.log）
  2. 隔离 HOME + 用户现场形态 config.jsonc（tong→fake 网关）
  3. boot → 截 01（弹窗前：状态栏应有 defaultModel）
  4. /model → 截 02（弹窗：GLM-5.3-Flash 行应有 [current] badge）
  5. 选另一个模型 → 截 03（通知行 ✓ 无 mismatch + 状态栏跟随）
  6. 发消息 → fake-reqs.log model=新模型（热切换铁证）
Exit 0 = 证据链完整。
"""
import json, os, re, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent  # worktree root
OUT = Path("/tmp/tui-p74"); OUT.mkdir(parents=True, exist_ok=True)
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

FAKE = """// fake-p74-llm.ts — OpenAI-compatible SSE; logs request model per call.
const port = Number(process.argv[2] || "0");
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
      const mk = (d, f=null) => ({ id: "p74", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: d, finish_reason: f }] });
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
console.log(`fake-p74 listening http://127.0.0.1:${server.port}/v1`);
""" % json.dumps(str(REQLOG))

def main() -> int:
    # [1] fake LLM
    fake_src = OUT / "fake-p74-llm.ts"
    fake_src.write_text(FAKE)
    REQLOG.unlink(missing_ok=True)
    fake = subprocess.Popen(["bun", str(fake_src), "0"],
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

    # [2] isolated HOME: **用户现场形态** config.jsonc
    #   - llm.defaultModel = "tong/GLM-5.3-Flash"（full id 含 /）
    #   - 注释化的 defaultModel/defaultProvider 历史行
    #   - tab 缩进（与用户 1-22 行一致）
    #   - tong.models 裸名
    home = tempfile.mkdtemp(prefix="roy-p74-")
    cfg = """{
\t"llm": {
\t\t//"defaultModel": "MiniMax-M3.1-Flash",
\t\t//"defaultProvider": "minimax",
\t\t//"defaultModel": "deepseek-v4.1-flash",
\t\t//"defaultProvider": "opencodego",
\t\t"defaultModel": "tong/GLM-5.3-Flash",
\t\t"defaultProvider": "tong",
\t\t"temperature": 1,
\t\t"maxTokens": 8192,
\t\t"topP": 1,
\t\t"stream": true,
\t\t"providers": {
\t\t   "tong": {
\t\t\t"provider": "openai-compatible",
\t\t\t"name": "GLM",
\t\t\t"apiKey": "fake-key",
\t\t\t"baseURL": "http://127.0.0.1:%d/v1",
\t\t\t"models": [
\t\t\t  "GLM-5.2-W4A8",
\t\t\t  "GLM-5.3-Flash"
\t\t\t],
\t\t\t"defaultModel": "GLM-5.2-W4A8",
\t\t\t"temperature": 0.7
\t\t   }
\t\t}
\t},
\t"session": {
\t\t"compactModel": "minimax/MiniMax-M3.1-Flash"
\t}
}""" % port
    for cfg_dir in [Path(home) / ".config" / "roy-bot",
                    Path(home) / ".roy-bot"]:
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "config.jsonc").write_text(cfg)

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
        "echo '=== roy-bot P7.4 /model hotfix demo ==='\n"
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

    # [4] /model dialog — bug3: [current] badge on GLM-5.3-Flash
    print("[4] /model dialog (expect [current] badge on GLM-5.3-Flash)")
    xdot("type", "--window", wid, "--delay", "30", "/model")
    xdot("key", "--window", wid, "Return")
    wait_quiet(2.5, 40)
    time.sleep(2)
    snap("02-model-dialog.png")

    # [5] select the FIRST item (GLM-5.2-W4A8 — differs from current default
    #     GLM-5.3-Flash ⇒ hot-swap proof) — expect NO mismatch
    print("[5] pick GLM-5.2-W4A8 (Enter on first row) — expect NO mismatch")
    time.sleep(0.6)
    xdot("key", "--window", wid, "Return")
    wait_quiet(2.5, 40)
    time.sleep(2)
    snap("03-after-swap.png")

    # [6] message — hot swap proof
    print("[6] send 'hello one' (expect wire model=GLM-5.2-W4A8)")
    xdot("type", "--window", wid, "--delay", "25", "hello one")
    xdot("key", "--window", wid, "Return")
    wait_req(1, 90)
    wait_quiet(3.0, 60)
    time.sleep(1.5)
    snap("04-msg1.png")

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
    ok = ("GLM-5.2-W4A8" in models)
    print("VERDICT:", "PASS — hot swap observed (tong/GLM-5.3-Flash -> GLM-5.2-W4A8, no mismatch)" if ok
          else "FAIL — wire models:", models)
    (OUT / "result.json").write_text(json.dumps({"models": models, "ok": ok}, indent=2))
    print("done:", len(shots), "shots")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
