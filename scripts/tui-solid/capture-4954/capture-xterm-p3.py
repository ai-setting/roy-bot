#!/usr/bin/env python3
"""capture-xterm-p3.py — Xvfb :77 + xterm + xdotool + import

Task #5077 P3 Phase 2 acceptance (scrollbar + keyboard scroll bindings):

  1. boot interactive (fake long-answer LLM ⇒ scrollable transcript)
  2. screenshot: scrollbar visible on the right edge of the message area
  3. press PageUp (real xterm key) ⇒ screenshot: transcript scrolled up
     (scrollbar thumb moved up)
  4. press ctrl+g ⇒ screenshot: jumped to top (scrollbar thumb at the top)
  5. press ctrl+alt+g ⇒ screenshot: jumped back to bottom

Exit 0 = all shots captured.
"""
import json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent  # worktree root
OUT = Path("/tmp/tui-p3-p2")
DISP = ":77"
XTERM = "/tmp/termtest/x/usr/bin/xterm"
XDOT = "/tmp/tools/x/usr/bin/xdotool"
LIB = "/tmp/termtest/x/usr/lib/x86_64-linux-gnu:/tmp/tools/x/usr/lib/x86_64-linux-gnu"

WID = ""


def sh(cmd, **kw):
    env = dict(os.environ, DISPLAY=DISP, LD_LIBRARY_PATH=LIB)
    return subprocess.run(cmd, env=env, capture_output=True, text=True, **kw)


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


def wait_quiet(sec_stable=2.5, timeout=90):
    """Wait until screen output stops changing."""
    img = OUT / "_probe.png"
    last = -1
    stable_since = time.time()
    deadline = time.time() + timeout
    while time.time() < deadline:
        import_window(WID, img)
        size = img.stat().st_size
        if size == last:
            if time.time() - stable_since > sec_stable:
                return True
        else:
            last = size
            stable_since = time.time()
        time.sleep(0.6)
    return False


def main() -> int:
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)

    # ── fake LLM with a long answer ⇒ scrollable transcript ────────────
    fake = subprocess.Popen(
        ["bun", str(ROOT / "scripts/tui-solid/fake-scroll-llm.ts"), "--port", "0", "--lines", "60"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=str(ROOT),
    )
    port = 0
    deadline = time.time() + 20
    while time.time() < deadline:
        line = fake.stdout.readline().decode("utf8", "replace")
        m = re.search(r"http://127\.0\.0\.1:(\d+)", line)
        if m:
            port = int(m.group(1))
            break
    assert port, "fake scroll LLM no port"
    print(f"[1] fake LLM :{port} (60 lines)")

    # ── isolated HOME + config ─────────────────────────────────────────
    home = tempfile.mkdtemp(prefix="roy-p3-")
    cfg_dir = Path(home) / ".config" / "roy-bot"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "config.jsonc").write_text(json.dumps({
        "llm": {
            "defaultProvider": "fake", "defaultModel": "fake-scroll", "stream": True,
            "providers": {"fake": {
                "provider": "openai-compatible", "apiKey": "fake-key",
                "baseURL": f"http://127.0.0.1:{port}/v1",
                "models": ["fake-scroll"], "defaultModel": "fake-scroll",
            }},
        }
    }, indent=2))

    rc = Path(home) / "rc.sh"
    rc.write_text(
        "#!/bin/bash\n"
        "export HOME=%s\nexport XDG_CONFIG_HOME=%s\nexport XDG_DATA_HOME=%s\n"
        "export TERM=xterm-256color COLORTERM=truecolor ROY_AGENT_NO_TELEMETRY=1\n"
        "export LANG=C.UTF-8 LC_ALL=C.UTF-8\n"
        "unset ALL_PROXY all_proxy\n"
        # ★ 必须等 shell 提示符就绪再敲命令（P1/P4 脚本已验证）：
        #   否则命令打进尚未就绪的终端 ⇒ 被丢弃 ⇒ TUI 根本没启动，
        #   后面所有截图都是同一张空屏。
        #   ⚠️ 三个要点（照抄 P4 脚本已验证的时序）：
        #     ① `export PS1` —— `exec bash --norc` 起的新 shell 没有提示符 ⇒
        #        PROMPT_COMMAND 根本不触发 ⇒ 标题永远不变 ⇒ 等待超时；
        #     ② `export PROMPT_COMMAND` —— 非 export 的变量不会被子 shell 继承；
        #     ③ `export RCSTAGE` —— 标题里带一个可识别的标记。
        "export PS1='user$ '\n"
        "export PROMPT_COMMAND='printf \"\\033]0;T%%s\\007\" \"$RCSTAGE\"'\n"
        "export RCSTAGE=P3\n"
        "cd /tmp\n"
        "clear\n"
        "echo '=== roy-bot P3 scroll demo ==='\n"
        "sleep 0.5\n"
        # ★ 直接 exec TUI（不再让脚本去敲命令）——
        #   实测：在 xterm 里用 xdotool 敲长命令会被行宽截断 ⇒ TUI 启动即退；
        #   而 pty.fork() 方式下 TTY stdin 又会让 opentui 早退（仅 454 字节）。
        #   ⇒ 让 **xterm 自己** 起 TUI：xterm 的 stdin/stdout 都是真 TTY。
        "exec bun /tmp/roy-p3-agent.js interactive --model fake/fake-scroll --workdir /tmp\n"
        % (home, Path(home) / ".config", Path(home) / ".local/share")
    )

    # ── short symlink for the TUI binary (the xterm rc.sh exec's it) ───
    agent_link = Path("/tmp/roy-p3-agent.js")
    try:
        agent_link.unlink()
    except FileNotFoundError:
        pass
    agent_link.symlink_to(ROOT / "packages/cli/dist/bin/roy-bot.js")

    # ── xterm ──────────────────────────────────────────────────────────
    win_env = dict(os.environ, DISPLAY=DISP, LD_LIBRARY_PATH=LIB)
    win = subprocess.Popen(
        [XTERM, "-display", DISP, "-geometry", "150x40+10+10",
         "-fs", "11", "-title", "P3SCROLL",
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
    # ⚠️ 窗口标题会随后被 shell 的 PROMPT_COMMAND 改成 "TP3" ⇒
    #   先按 P3SCROLL 搜（xterm 启动瞬间），找不到再按 TP3 搜。
    for _ in range(10):
        for needle in ("P3SCROLL", "TP3"):
            try:
                r = xdot("search", "--onlyvisible", "--name", needle).strip()
            except RuntimeError:
                r = ""
            if r:
                wid = r.splitlines()[0]
                break
        if wid:
            break
        time.sleep(1.5)
    if not wid:
        raise RuntimeError("xterm window not found")
    WID = wid
    print(f"[2] xterm window {wid}")

    # ⚠️ xterm 直接 exec 了 TUI ⇒ 没有 shell 提示符 ⇒ 不等 TP3。

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

    def refocus():
        # typing needs keyboard focus; `import` can steal the pointer focus.
        try:
            xdot("windowfocus", "--sync", wid)
        except RuntimeError:
            pass
        time.sleep(0.4)

    # ── boot interactive ───────────────────────────────────────────────
    # ★ 命令必须**短**：终端行宽有限，超长命令会被截断（实测：长路径命令
    #   被截成 "...ke/fake-scroll" ⇒ TUI 启动即退）。
    #   ⇒ 用 /tmp 下的短符号链接（agent.js）⇒ 命令 < 60 字符。
    # ★ 必须显式传 `--model fake/fake-scroll`（providerId/modelId）——
    #   否则 argv.model 为 undefined ⇒ RunScreen 的 props.model 为空。
    print("[3] TUI already running (xterm exec'd it); settle")
    time.sleep(5)
    print("[debug] title:", xdot("getwindowname", wid))
    refocus()
    snap("01-boot.png")

    # ── ask a question so the long answer lands in the transcript ──────
    print("[4] ask (long answer ⇒ scrollable transcript)")
    refocus()
    xdot("type", "--window", wid, "--delay", "20", "give me a long answer")
    time.sleep(0.5)
    xdot("key", "--window", wid, "Return")
    wait_quiet(3.0, 120)
    time.sleep(2)
    refocus()
    snap("02-scrolled-transcript.png")

    # ── PageUp (real xterm key) ⇒ scroll up ───────────────────────────
    print("[5] PageUp")
    refocus()
    xdot("key", "--window", wid, "Prior")
    time.sleep(1.5)
    snap("03-pageup.png")

    print("[6] ctrl+g (jump to top)")
    refocus()
    xdot("key", "--window", wid, "ctrl+g")
    time.sleep(1.5)
    snap("04-jump-top.png")

    print("[7] ctrl+alt+g (jump to bottom)")
    refocus()
    xdot("key", "--window", wid, "ctrl+alt+g")
    time.sleep(1.5)
    snap("05-jump-bottom.png")

    try:
        win.terminate()
    except Exception:
        pass
    fake.terminate()
    print("done:", len(shots), "shots in", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
