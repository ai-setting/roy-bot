#!/bin/bash
# Task #2368 — actual-TTY interactive capture script
# Usage: run after `bun run build:cli:dev:single`.
# Captures Ink (default) and readline (ROY_AGENT_NO_INK=1) modes through
# an expect PTY, so Ink receives a real raw-mode-capable stdin.

set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p reports/2368-screenshots

EXPECT_SCRIPT="$(mktemp /tmp/task2368-capture.XXXXXX.expect)"
trap 'rm -f "$EXPECT_SCRIPT"' EXIT
cat > "$EXPECT_SCRIPT" <<'EXPECT'
#!/usr/bin/expect -f
set timeout 20
set mode [lindex $argv 0]
set outfile [lindex $argv 1]
# Keep terminal output in the log file; caller redirects the duplicate console stream.
log_user 1
log_file -noappend $outfile
if {$mode == "ink"} {
  spawn -noecho env TERM=xterm-256color bun packages/cli/dist/bin/roy-bot.js interactive
} else {
  spawn -noecho env TERM=xterm-256color ROY_AGENT_NO_INK=1 bun packages/cli/dist/bin/roy-bot.js interactive
}
expect {
  -re "Roy Interactive v" {}
  timeout { puts "FAIL: welcome card timeout"; exit 1 }
  eof { puts "FAIL: process exited before welcome card"; exit 1 }
}
sleep 2
# Idle Ctrl+C exercises graceful shutdown after the real TTY frame is captured.
send -- "\003"
expect {
  eof {}
  timeout { catch {close}; exit 0 }
}
log_file
exit 0
EXPECT
chmod +x "$EXPECT_SCRIPT"

capture_mode() {
  local mode="$1"
  local stem="$2"
  echo "=== Capture: $mode mode ==="
  "$EXPECT_SCRIPT" "$mode" "reports/2368-screenshots/${stem}-raw.txt" >/dev/null
}

capture_mode ink 01-ink-mode
capture_mode readline 02-readline-mode

python3 <<'PY'
from pathlib import Path
import re

root = Path("reports/2368-screenshots")
for stem in ("01-ink-mode", "02-readline-mode"):
    raw = (root / f"{stem}-raw.txt").read_text(errors="replace")
    text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", raw)
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b[@-_]", "", text)
    text = text.replace("\r", "")
    (root / f"{stem}-clean.txt").write_text(text)
PY

if grep -lE "TypeError|Raw mode is not supported" reports/2368-screenshots/*-clean.txt; then
  echo "[FAIL] runtime error found in capture"
  exit 1
fi

echo "[OK] Ink + readline actual-TTY captures contain no TypeError or raw-mode error"
ls -lh reports/2368-screenshots/*-{raw,clean}.txt