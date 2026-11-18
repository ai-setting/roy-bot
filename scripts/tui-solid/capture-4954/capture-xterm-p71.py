#!/usr/bin/env python3
"""capture-xterm-p71.py — Task #5116 P7.1 真终端取证（Xvfb :77 + xterm + xdotool + import）。

复现用户实锤：/connect 后 Dialog 黑底黑字不可见。
  1. boot interactive（隔离 HOME + 真 config/auth（只读，不写入））
  2. 输入 /connect + Enter → 截图（复现不可见）
  3. 输入 /model + Enter → 截图
  4. Esc 关闭 → 截图恢复
Exit 0 = all shots captured.

⚠️ HOME 隔离：auth.json / config.jsonc 从真实 ~/.roy-bot **拷贝只读副本**
到临时 HOME（避免弹窗写盘误伤真实配置——本轮不动写路径，但防御性隔离）。
"""
import json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent  # worktree root
OUT = Path("/tmp/tui-p71"); OUT.mkdir(parents=True, exist_ok=True)
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

def main() -> int:
    # isolated HOME with read-only copies of real config (defensive)
    home = tempfile.mkdtemp(prefix="roy-p71-")
    src = Path.home() / ".roy-bot"
    dst = Path(home) / ".roy-bot"
    dst.mkdir(parents=True, exist_ok=True)
    for f in ["auth.json", "config.jsonc"]:
        if (src / f).exists():
            shutil.copy2(src / f, dst / f)

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
        "echo '=== roy-bot P7.1 dialog demo ==='\n"
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
    print(f"[1] xterm window {wid}")
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

    print("[2] boot interactive")
    xdot("type", "--window", wid, "--delay", "25",
         "bun %s interactive --workdir /tmp" % (ROOT/"packages/cli/dist/bin/roy-bot.js"))
    time.sleep(1)
    xdot("key", "--window", wid, "Return")
    wait_quiet(2.5, 90)
    time.sleep(3)
    snap("term-01-boot.png")

    print("[3] /connect")
    xdot("type", "--window", wid, "--delay", "40", "/connect")
    time.sleep(0.5)
    snap("term-02-connect-typed.png")
    xdot("key", "--window", wid, "Return")
    wait_quiet(2.5, 40)
    time.sleep(2)
    snap("term-03-connect-dialog.png")

    print("[4] /model")
    xdot("key", "--window", wid, "Escape")
    time.sleep(1)
    xdot("type", "--window", wid, "--delay", "40", "/model")
    xdot("key", "--window", wid, "Return")
    wait_quiet(2.5, 40)
    time.sleep(2)
    snap("term-04-model-dialog.png")

    print("[4b] dump tree (ctrl+t)")
    rm = Path("/tmp/roy-dump-tree.json")
    rm.unlink(missing_ok=True)
    xdot("key", "--window", wid, "ctrl+t")
    time.sleep(2)
    print("    dump exists:", rm.exists(), rm.stat().st_size if rm.exists() else 0)

    print("[5] close")
    xdot("key", "--window", wid, "Escape")
    time.sleep(1)
    snap("term-05-closed.png")

    try: win.terminate()
    except Exception: pass
    print("done:", len(shots), "shots")
    return 0

if __name__ == "__main__":
    sys.exit(main())
