#!/usr/bin/env python3
"""capture-xterm-p2.py — Xvfb :77 + xterm + xdotool + import
Task #4954 P2 paste-channel acceptance:
  1. boot interactive (fake LLM)
  2. inject multi-line bracketed paste via xdotool + xterm translations
     (xterm itself is the paste SENDER — most faithful simulation)
  3. screenshot: folded [Pasted ~N lines] in the input box
  4. submit → screenshot: full text delivered
  5. short paste → screenshot: direct insertion
Exit 0 = all shots captured.
"""
import json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent  # worktree root
OUT = Path("/tmp/tui-p2"); shutil.rmtree(OUT, ignore_errors=True); OUT.mkdir(parents=True)
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
    # fake LLM
    fake = subprocess.Popen(
        ["bun", str(ROOT / "scripts/tui-solid/fake-reasoning-llm.ts"), "--port", "0",
         "--chunkMs", "500", "--hold-ms", "3000"],
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
    home = tempfile.mkdtemp(prefix="roy-p2-")
    cfg_dir = Path(home) / ".config" / "roy-bot"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "config.jsonc").write_text(json.dumps({
        "llm": {"defaultProvider": "fake", "defaultModel": "fake-reasoning", "stream": True,
                "providers": {"fake": {"provider": "openai-compatible", "apiKey": "fake-key",
                                        "baseURL": f"http://127.0.0.1:{port}/v1",
                                        "models": ["fake-reasoning"], "defaultModel": "fake-reasoning"}}}
    }, indent=2))

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
        "echo '=== roy-bot P2 paste demo ==='\n"
        "sleep 0.5\n"
        "exec bash --norc\n" % (home, Path(home)/'.config', Path(home)/'.local/share'))

    # xterm: bind a translation that sends a REAL bracketed paste for F12
    # (multi-line) — xterm is the paste sender, exactly like a real terminal.
    # Xt quoted string with octal escapes: ESC=\033, LF=\012
    paste_arg = r'"\033[200~alpha line\012beta line\012gamma line\033[201~"'
    win_env = dict(os.environ, DISPLAY=DISP, LD_LIBRARY_PATH=LIB)
    win = subprocess.Popen(
        [XTERM, "-display", DISP, "-geometry", "150x40+10+10",
         "-fs", "11", "-title", "START",
         "-bg", "#1a1b26", "-fg", "#c0caf5",
         "-xrm", "xterm*locale: true",
         "-xrm", "xterm*VT100.faceName: Noto Sans Mono CJK SC",
         "-xrm", "xterm*VT100.faceDoubleSize: false",
         "-xrm",
         "XTerm*VT100.translations: #override\\n\\<Key\\>F12: string(%s)" % paste_arg,
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
    if "START" not in xdot("getwindowname", wid):
        raise RuntimeError(f"window {wid} name is not ours")
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

    # boot interactive
    print("[3] boot interactive")
    xdot("type", "--window", wid, "--delay", "25",
         "bun %s interactive --workdir /tmp" % (ROOT/"packages/cli/dist/bin/roy-bot.js"))
    time.sleep(1)
    xdot("key", "--window", wid, "Return")
    wait_quiet(2.5, 90)
    time.sleep(3)
    print("[debug] window title:", xdot("getwindowname", wid))
    snap("01-boot.png")

    # P2: multi-line bracketed paste via xterm F12 translation
    print("[4] multiline bracketed paste (F12 → insert-formatted)")
    xdot("key", "--window", wid, "F12")
    time.sleep(1.5)
    snap("02-paste-folded.png")

    # submit: Enter → full text delivered
    print("[5] submit")
    xdot("key", "--window", wid, "Return")
    wait_quiet(3.0, 60)
    time.sleep(1.5)
    snap("03-paste-submitted.png")

    # short paste typed directly (xterm type = plain keys, ≤1 line → no fold)
    print("[6] short paste via raw typing")
    xdot("type", "--window", wid, "--delay", "30", "short paste line")
    time.sleep(1.0)
    snap("04-short-typed.png")
    xdot("key", "--window", wid, "Return")
    wait_quiet(3.0, 60)
    time.sleep(1.0)
    snap("05-final.png")

    try: win.terminate()
    except Exception: pass
    fake.terminate()
    print("done:", len(shots), "shots")
    return 0

if __name__ == "__main__":
    sys.exit(main())
