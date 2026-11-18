#!/usr/bin/env python3
"""Xvfb + xterm + xdotool + import — roy-bot interactive 多轮真终端截图
（软著 W43.5 同款链路）。产物 /tmp/tui-xterm/*.png，退出码 0=完成。
"""
import json, os, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
OUT = Path("/tmp/tui-xterm-p1"); OUT.mkdir(parents=True, exist_ok=True)
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
    # settle: 窗口必须活着，import 重试 3 次
    for _ in range(3):
        r = sh(["import", "-window", winid, str(out)])
        if r.returncode == 0 and Path(out).exists() and Path(out).stat().st_size > 3000:
            return
        time.sleep(1.0)
    raise RuntimeError(f"import produced tiny image for {winid}")
    r = sh(["import", "-window", winid, str(out)])
    if r.returncode != 0 or not Path(out).exists():
        raise RuntimeError(f"import failed: {r.stderr}")

def wait_ok(winid, want, timeout=180):
    """等 xterm 标题变 OK（PROMPT_COMMAND 打点）或超时"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        t = xdot("getwindowname", winid)
        if want in t:
            return True
        time.sleep(0.5)
    return False

def main() -> int:
    fake_port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    # fake LLM
    fake = subprocess.Popen(
        ["bun", str(ROOT / "scripts/tui-solid/fake-reasoning-llm.ts"), "--port", "0",
         "--chunkMs", "700", "--hold-ms", "6000"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=str(ROOT))
    port = 0
    deadline = time.time() + 20
    while time.time() < deadline:
        line = fake.stdout.readline().decode("utf8", "replace")
        m = __import__("re").search(r"http://127\.0\.0\.1:(\d+)", line)
        if m:
            port = int(m.group(1)); break
    assert port, "fake LLM no port"
    print(f"[1] fake LLM :{port}")

    # 隔离 HOME + config
    home = tempfile.mkdtemp(prefix="roy-xterm-")
    cfg_dir = Path(home) / ".config" / "roy-bot"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "config.jsonc").write_text(json.dumps({
        "llm": {"defaultProvider": "fake", "defaultModel": "fake-reasoning", "stream": True,
                "providers": {"fake": {"provider": "openai-compatible", "apiKey": "fake-key",
                                        "baseURL": f"http://127.0.0.1:{port}/v1",
                                        "models": ["fake-reasoning"], "defaultModel": "fake-reasoning",
                                        "capabilities": {"reasoning": True, "toolcall": True}}}}
    }, indent=2))

    # rc: PROMPT_COMMAND 打点（标题 P1→P2 表示命令完成回到提示符）
    rc = Path(home) / "rc.sh"
    rc.write_text(
        "#!/bin/bash\n"
        "export HOME=%s\nexport XDG_CONFIG_HOME=%s\nexport XDG_DATA_HOME=%s\n"
        "export TERM=xterm-256color COLORTERM=truecolor ROY_AGENT_NO_TELEMETRY=1\n"
        "export LANG=C.UTF-8 LC_ALL=C.UTF-8\n"
        "unset ALL_PROXY all_proxy\n"
        "export PS1='user$ '\n"
        "cd /tmp\n"
        "PROMPT_COMMAND='printf \"\\033]0;T%%s\\007\" \"$RCSTAGE\"'\n"
        "RCSTAGE=P1\n"
        "clear\n"
        "echo '=== roy-bot interactive TUI demo (3 turns) ==='\n"
        "sleep 0.5\n"
        "exec bash --norc\n" % (home, Path(home)/'.config', Path(home)/'.local/share'))

    # 启动 xterm 跑 rc.sh（标题初始 START）
    win_env = dict(os.environ, DISPLAY=DISP, LD_LIBRARY_PATH=LIB)
    win = subprocess.Popen(
        [XTERM, "-display", DISP, "-geometry", "150x40+10+10",
         "-fs", "11", "-title", "START",
         "-bg", "#1a1b26", "-fg", "#c0caf5",
         "-xrm", "xterm*locale: true",
         "-xrm", "xterm*VT100.faceName: Noto Sans Mono CJK SC",
         "-xrm", "xterm*VT100.faceDoubleSize: false",
         "-e", "bash", str(rc)], env=win_env)
    time.sleep(3.0)
    print("[debug] xterm pid", win.pid, "alive:", win.poll() is None)
    if win.poll() is not None:
        print("[debug] rc.sh content:")
        print(Path(rc).read_text())
        raise RuntimeError("xterm exited early rc=" + str(win.returncode))
    wid = ""
    for attempt in range(5):
        for args in (["search", "--onlyvisible", "--name", "START"],
                 ["search", "--onlyvisible", "--class", "xterm"]):
            try:
                r = xdot(*args).strip()
                if r:
                    wid = r.splitlines()[0]
                    break
            except RuntimeError:
                continue
        if wid:
            break
        time.sleep(1.5)
    if not wid:
        raise RuntimeError("xterm window not found after retries")
    # 校验窗名确为 START（避免匹配到残留窗口）
    nm = xdot("getwindowname", wid)
    if "START" not in nm:
        raise RuntimeError(f"window {wid} name={nm!r} is not our START window")
    print(f"[2] xterm window {wid}")
    try:
        xdot("windowactivate", "--sync", wid)
    except RuntimeError:
        pass  # no WM on bare Xvfb — focus follows cursor; use windowfocus instead
    try:
        xdot("windowfocus", "--sync", wid)
    except RuntimeError:
        pass
    time.sleep(0.5)
    # 标题变 T（PROMPT_COMMAND 生效）就绪
    t0 = time.time()
    while time.time() - t0 < 10:
        if "TP1" in xdot("getwindowname", wid): break
        time.sleep(0.3)

    shots = []
    def snap(name):
        out = OUT / name
        import_window(wid, out)
        shots.append(out)
        print(f"    shot -> {out}")

    def stage2_wait(name, timeout=90):
        """设 RCSTAGE=P2 然后等标题变 TP2（子命令把环境变量传给 bash?）
        简化：直接用 xdotool type + 固定 sleep 等待回复完成。"""
    # —— 简化：因 TUI 内无 shell PROMPT_COMMAND，用「输出稳定」判定：
    def wait_quiet(sec_stable=3.0, timeout=120):
        """等屏幕输出 N 秒无变化（流式回复结束）"""
        last = -1; stable_since = time.time()
        deadline = time.time() + timeout
        while time.time() < deadline:
            cur = os.path.getsize(f"/proc/{os.getpid()}/io")  # noop
            img = OUT / "_probe.png"
            import_window(wid, img)
            size = img.stat().st_size
            if size == last:
                if time.time() - stable_since > sec_stable:
                    return True
            else:
                last = size; stable_since = time.time()
            time.sleep(0.6)
        return False

    print("[3] boot interactive")
    xdot("type", "--window", wid, "--delay", "40", "bun %s interactive --workdir /tmp" % (ROOT/"packages/cli/dist/bin/roy-bot.js"))
    xdot("key", "--window", wid, "Return")
    wait_quiet(2.5, 60)          # TUI 起来（全屏稳定）
    time.sleep(2)
    snap("01-boot-fullscreen.png")

    turns = ["hi there", "what can you do", "tell me a joke"]
    for i, q in enumerate(turns, 1):
        print(f"[4.{i}] turn: {q}")
        xdot("type", "--window", wid, "--delay", "30", q)
        xdot("key", "--window", wid, "Return")
        wait_quiet(3.5, 120)     # 等回复流完（thinking hold 6s + 内容）
        time.sleep(1.5)
        snap(f"{i+1}-turn{i}-{q.split()[0].lower()}.png")

    print("[5] final")
    time.sleep(1)
    snap("05-final-3turns.png")
    # 退出（idle 态 Ctrl-C 退出 TUI，回 shell）
    xdot("key", "--window", wid, "ctrl+c")
    time.sleep(2)
    snap("06-exit-shell-restored.png")
    try: win.terminate()
    except Exception: pass
    fake.terminate()
    print("done:", len(shots), "shots")
    return 0

if __name__ == "__main__":
    sys.exit(main())
