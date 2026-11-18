#!/usr/bin/env python3
"""capture-xterm-p4.py — Xvfb :77 + xterm + xdotool + import
Task #4994 P4 message-visual acceptance:
  1. boot interactive (fake LLM streaming markdown-rich answers)
  2. ask a question → screenshot: assistant reply with heading
     (no ##), bold, grid table, code frame + user block (left rail
     + panel bg) + meta line (Build · model · duration · tok/s)
Exit 0 = all shots captured.
"""
import json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Task #4994: capture runs against the P4 worktree build.
ROOT = Path("~/work/codework/personal/roy_world/roy-bot/.worktrees/feat-tui-visual")
OUT = Path("/tmp/tui-p4"); shutil.rmtree(OUT, ignore_errors=True); OUT.mkdir(parents=True)
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

def wait_quiet(sec_stable=3.0, timeout=90):
    """Wait until screen output stops changing (stream finished)."""
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
        time.sleep(0.6)
    return False

def main() -> int:
    # fake LLM (markdown-rich answer)
    fake = subprocess.Popen(
        ["bun", str(ROOT / "scripts/tui-solid/fake-md-llm.ts"), "--port", "0",
         "--chunkMs", "400", "--hold-ms", "1200"],
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

    # isolated HOME + config
    home = tempfile.mkdtemp(prefix="roy-p4-")
    cfg_dir = Path(home) / ".config" / "roy-bot"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "config.jsonc").write_text(json.dumps({
        "llm": {"defaultProvider": "fake", "defaultModel": "fake-md", "stream": True,
                "providers": {"fake": {"provider": "openai-compatible", "apiKey": "fake-key",
                                        "baseURL": f"http://127.0.0.1:{port}/v1",
                                        "models": ["fake-md"], "defaultModel": "fake-md"}}}
    }, indent=2))

    rc = Path(home) / "rc.sh"
    #
    # Task #4994 (P4 收尾) — 采用 P1 脚本**已验证可用**的时序：
    #   ① `cd /tmp`（不要 cd 到仓库根）+ **绝对路径**启动 binary
    #      （相对路径 + `cd ROOT` 时，命令会超出行宽被终端截断 ⇒ TUI 起不来）；
    #   ② `PROMPT_COMMAND` 打点标题 `TP1` ⇒ 脚本据此确认 **shell 提示符已就绪**
    #      才去敲命令（旧脚本直接敲 ⇒ 命令打进未就绪的终端，被丢弃）；
    #   ③ 每次交互前 `windowfocus`（`import` 抓指针会抢焦点）。
    rc.write_text(
        "#!/bin/bash\n"
        "export HOME=%s\nexport XDG_CONFIG_HOME=%s\nexport XDG_DATA_HOME=%s\n"
        "export TERM=xterm-256color COLORTERM=truecolor ROY_AGENT_NO_TELEMETRY=1\n"
        "export LANG=C.UTF-8 LC_ALL=C.UTF-8\n"
        "unset ALL_PROXY all_proxy\n"
        "export PS1='user$ '\n"
        "cd /tmp\n"
        # ⚠️ 必须 `export PROMPT_COMMAND`：末行 `exec bash --norc` 起的是**新** bash，
        #    只在父 shell 里赋值（非 export）的话子 shell 拿不到 ⇒ 标题永远停在
        #    START ⇒ 脚本的「shell 就绪」判据永远超时 ⇒ 后续所有命令都被丢弃。
        #    （P1 脚本同样漏了 export，故 P1 也只是靠「输出稳定」兜底。）
        "export PROMPT_COMMAND='printf \"\\033]0;T%%s\\007\" \"$RCSTAGE\"'\n"
        "export RCSTAGE=P1\n"
        "clear\n"
        "echo '=== roy-bot P4 message visuals demo ==='\n"
        "sleep 0.5\n"
        "exec bash --norc\n" % (home, Path(home)/'.config', Path(home)/'.local/share'))

    win_env = dict(os.environ, DISPLAY=DISP, LD_LIBRARY_PATH=LIB)
    win = subprocess.Popen(
        [XTERM, "-display", DISP, "-geometry", "150x42+10+10",
         "-fs", "11", "-title", "START",
         "-bg", "#1a1b26", "-fg", "#c0caf5",
         "-xrm", "xterm*locale: true",
         "-xrm", "xterm*VT100.faceName: Noto Sans Mono CJK SC",
         "-xrm", "xterm*VT100.faceDoubleSize: false",
         "-e", "bash", str(rc)], env=win_env)
    time.sleep(3.0)
    if win.poll() is not None:
        raise RuntimeError("xterm exited early rc=" + str(win.returncode))

    global WID
    wid = ""
    # ⚠️ 用 **pid** 定位窗口，不要用 `search --name START`：
    #    上一轮崩溃残留的 xterm 窗口也还挂在 X server 上（进程死了但窗口
    #    记录仍在，`--name START` 会先命中那个陈旧窗口 ⇒ 抓到错误的窗口）。
    #    本脚本自己 spawn 了 xterm，`--pid` 精确对应它。
    for attempt in range(6):
        r = xdot("search", "--onlyvisible", "--pid", str(win.pid)).strip()
        if r:
            wid = r.splitlines()[0]
            break
        time.sleep(1.0)
    if not wid:
        # 兜底：按 class 找最新的一个
        r = xdot("search", "--onlyvisible", "--class", "xterm").strip()
        if r:
            wid = r.splitlines()[-1]
    if not wid:
        raise RuntimeError("xterm window not found")
    # ⚠️ 标题**不一定**还是 START：`export PROMPT_COMMAND` 修好后，shell 一就绪
    #    标题就会被打成 `T`（xdotool 可能匹配到窗口时已经变了）。X server 还会
    #    **复用**刚释放的 window id，所以旧窗口号可能与新窗口号相同。
    #    因此只校验「标题属于本脚本的合法阶段」，不校验具体是哪个。
    nm = xdot("getwindowname", wid)
    if not any(tag in nm for tag in ("START", "T")):
        raise RuntimeError(f"window {wid} name={nm!r} is not ours")
    WID = wid
    print(f"[2] xterm window {wid} title={nm!r}")
    try:
        xdot("windowfocus", "--sync", wid)
    except RuntimeError:
        pass
    time.sleep(0.5)

    # Task #4994 (P4 收尾): 等 shell 提示符就绪（PROMPT_COMMAND 把标题打成
    # `TP1`）。旧脚本不等就敲命令 ⇒ 命令打进尚未就绪的终端 ⇒ 被丢弃 ⇒
    # TUI 根本没启动，后面所有截图都是同一张空屏（P1 脚本已验证此模式可靠）。
    t0 = time.time()
    while time.time() - t0 < 15:
        if "TP1" in xdot("getwindowname", wid):
            break
        time.sleep(0.3)
    else:
        raise RuntimeError("shell prompt never became ready (title != TP1)")
    print(f"[2.1] shell ready: {xdot('getwindowname', wid)}")

    shots = []
    def snap(name):
        out = OUT / name
        import_window(wid, out)
        shots.append(out)
        print(f"    shot -> {out}")

    def refocus():
        # typing needs keyboard focus on the xterm window;
        # refocus before every interaction (measured: focus can
        # drift after `import` grabs the pointer).
        try:
            xdot("windowfocus", "--sync", wid)
        except RuntimeError:
            pass
        time.sleep(0.4)

    # boot interactive
    #
    # Task #4994 (P4 收尾) 两处必改：
    #   ① **绝对路径**启动 binary —— 相对路径在 `cd /tmp` 下根本不存在；
    #      旧脚本用 `cd ROOT` + 相对路径，145 字符的命令会超出行宽被截断。
    #   ② 显式传 `--model fake/fake-md` —— 否则 `argv.model` 为 undefined ⇒
    #      RunScreen 的 `props.model` 为空 ⇒ formatMetaLine 拼不出 model 段
    #      （元信息行只剩 `Build · 6.9s`）。model 格式为 `providerId/modelId`。
    print("[3] boot interactive")
    xdot("type", "--window", wid, "--delay", "25",
         "bun %s interactive --model fake/fake-md --workdir /tmp 2>/tmp/p4-tui-err.log"
         % (ROOT / "packages/cli/dist/bin/roy-bot.js"))
    time.sleep(1)
    xdot("key", "--window", wid, "Return")
    wait_quiet(2.5, 90)
    time.sleep(4)
    print("[debug] title:", xdot("getwindowname", wid))
    refocus()
    snap("01-boot.png")

    # first turn: markdown-rich answer (heading/bold/table/code)
    print("[4] ask Q1 (markdown-rich reply)")
    refocus()
    xdot("type", "--window", wid, "--delay", "25", "what is 2+2?")
    time.sleep(1.0)
    snap("02a-typed.png")
    xdot("key", "--window", wid, "Return")
    wait_quiet(3.0, 90)
    time.sleep(2)
    # nudge a repaint: send a shift-pageup/pagedown pair (scrollbox
    # consumes it; forces opentui to flush a frame)
    xdot("key", "--window", wid, "Next")
    time.sleep(0.5)
    xdot("key", "--window", wid, "Prior")
    time.sleep(1.0)
    snap("02-markdown-reply.png")
    # full-root capture as evidence (independent of window grab)
    subprocess.run(["import", "-window", "root", str(OUT / "_root.png")], env=ENVX, capture_output=True)

    # second turn: user block + meta line already visible; ask one more
    print("[5] ask Q2 (user block + meta line)")
    refocus()
    xdot("type", "--window", wid, "--delay", "25", "show me the table again")
    time.sleep(1.0)
    xdot("key", "--window", wid, "Return")
    wait_quiet(3.0, 60)
    time.sleep(1.5)
    snap("03-user-block-meta.png")

    try: win.terminate()
    except Exception: pass
    fake.terminate()
    print("done:", len(shots), "shots")
    return 0

if __name__ == "__main__":
    sys.exit(main())
