#!/bin/sh
# prepublishOnly 守卫（packages/roy-bot-standalone）
#
# 为什么用 sh 而不是 bun/ts（Task #4506 交叉验证）：
# CI 的 publish-standalone job 只下载 artifacts（没有 checkout、也没装 bun），
# 它是在 artifacts/roy-bot-standalone/ 里直接 npm publish 的。
# 如果守卫依赖 bun 或 ../../scripts，CI 里会挂。这里只用 POSIX sh + sed + strings。
#
# 为什么不是 no-op、也不是再构建一次：
# - 原来跑 build:cli:prod --single：分包时再构建一次，浪费 ~40s，还会把刚校验过的二进制换掉；
# - 完全 no-op：裸 npm publish 会把 bin/ 里跨版本累积的旧二进制一起发出去（本改动的初衷就是修它）。
# 所以改成「只校验、不构建」：不满足条件就失败，并且明确指引使用 publish:full。
#
# 绕过：STANDALONE_SKIP_PREPUBLISH_CHECK=1

set -eu

if [ "${STANDALONE_SKIP_PREPUBLISH_CHECK:-0}" = "1" ]; then
  echo "⏭️  [prepublishOnly] STANDALONE_SKIP_PREPUBLISH_CHECK=1，跳过校验"
  exit 0
fi

# 定位包根目录（本脚本所在目录的父级）—— 兼容 CI 的 artifacts 布局与本地仓库布局
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PKG_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$PKG_ROOT"

BIN_DIR="$PKG_ROOT/bin"

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  *) OS=$(uname -s | tr '[:upper:]' '[:lower:]') ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) ARCH=$(uname -m) ;;
esac

CURRENT="roy-bot-${OS}-${ARCH}"
[ "$OS" = "windows" ] && CURRENT="$CURRENT.exe"

# 不依赖 node/bun：只用 sed 从 package.json 里取 version（CI 的 publish job 可能没有 node）
PKG_VERSION=$(sed -n 's/^ *"version" *: *"\([^"]*\)".*/\1/p' package.json | head -1)
if [ -z "$PKG_VERSION" ]; then
  echo "❌ [prepublishOnly] 无法从 package.json 读出 version"
  exit 1
fi
echo "📋 [prepublishOnly] 包版本: $PKG_VERSION，当前平台: ${OS}-${ARCH}"

FAIL=0
fail() {
  echo ""
  echo "❌ [prepublishOnly] $1"
  FAIL=1
}

# ---- 1. 当前平台二进制必须存在 ----
if [ ! -f "$BIN_DIR/$CURRENT" ]; then
  fail "bin/$CURRENT 不存在 —— 发布出去的包在本机无法运行。
  先执行: bun run build:cli:prod --single"
else
  # ---- 2. 二进制内嵌版本必须与 package.json 一致（说明重新构建过）----
  if command -v strings >/dev/null 2>&1; then
    EMBEDDED=$(strings "$BIN_DIR/$CURRENT" | grep -A1 '@ai-setting/roy-bot-cli' | grep 'version:' | head -1 | sed -n 's/.*version: *"\([0-9.]*\)".*/\1/p' || true)
    if [ -z "$EMBEDDED" ]; then
      fail "无法从 bin/$CURRENT 读出内嵌版本号（二进制可能损坏或未重新构建）。
  先执行: bun run build:cli:prod --single"
    elif [ "$EMBEDDED" != "$PKG_VERSION" ]; then
      fail "二进制版本 ($EMBEDDED) 与 package.json ($PKG_VERSION) 不一致 —— 二进制没重新构建。
  先执行: bun run build:cli:prod --single"
    else
      echo "✅ [prepublishOnly] 二进制版本校验通过: $EMBEDDED"
    fi
  else
    echo "⚠️  [prepublishOnly] 没有 strings 命令，跳过二进制版本校验"
  fi
fi

# ---- 3. 其它平台的旧二进制：警告（不失败）----
OTHERS=$(ls "$BIN_DIR" 2>/dev/null | grep '^roy-bot-' | grep -v "^$CURRENT\$" || true)
if [ -n "$OTHERS" ]; then
  COUNT=$(echo "$OTHERS" | wc -l | tr -d ' ')
  echo "⚠️  [prepublishOnly] bin/ 下还有 $COUNT 个其它平台的二进制（裸 npm publish 会把它们一起打包）:"
  echo "$OTHERS" | sed 's/^/      - /'
  echo "   推荐改用: bun run publish:full （会自动裁剪 manifest，只发本次构建的平台）"
fi

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "需要绕过本校验时: STANDALONE_SKIP_PREPUBLISH_CHECK=1 npm publish"
  exit 1
fi

echo "✅ [prepublishOnly] 校验通过"
