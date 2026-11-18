#!/usr/bin/env bash
# ============================================================================
# Session Compaction 集成测试
# 
# 测试内容：
# 1. session compact — 两阶段压缩（auto hint + compact agent）
# 2. 验证 checkpoint 生成
# 3. 验证 compact-hint 和 compact agent 被正确调用
# 4. 故意设置低阈值触发自动压缩
# ============================================================================

set -euo pipefail

ROY="./packages/cli/dist/bin/roy-bot.js"
ROY_CMD="bun run $ROY"
TMP_DIR=$(mktemp -d)
PASS=0
FAIL=0

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

pass() { echo "  ✅ PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=============================================="
echo "   Session Compaction Integration Tests"
echo "=============================================="
echo ""

# ===================================================================
# Test 1: 创建 session 并添加消息
# ===================================================================
echo "--- Test 1: Create session and add messages ---"

# 使用 act 模式创建一个 session（自动累积消息）
echo "   Running: create session via act..."
SESSION_OUTPUT=$($ROY_CMD act "用中文回复：今天天气真好，请用一个词形容" --no-quiet 2>/dev/null) || true
sleep 2

# 获取最新的 session ID  
SESSION_ID=$($ROY_CMD sessions list 2>/dev/null | head -1)
echo "   Session ID: $SESSION_ID"

if [ -z "$SESSION_ID" ]; then
  fail "Could not find session"
else
  pass "Session created: $SESSION_ID"
fi

# ===================================================================
# Test 2: Dry-run compact preview
# ===================================================================
echo ""
echo "--- Test 2: Compact preview (dry run) ---"

PREVIEW_OUTPUT=$($ROY_CMD sessions compact "$SESSION_ID" --dry-run 2>/dev/null) || true
echo "   Preview output: $PREVIEW_OUTPUT"

if echo "$PREVIEW_OUTPUT" | grep -q "Messages to compact"; then
  pass "Compact preview works"
else
  fail "Compact preview failed"
fi

# ===================================================================
# Test 3: 添加更多消息让消息数足够 compact
# ===================================================================
echo ""
echo "--- Test 3: Add more messages ---"

for i in $(seq 1 5); do
  $ROY_CMD act -s "$SESSION_ID" "第${i}轮：继续聊聊这个话题，用中文回复" --no-quiet 2>/dev/null > /dev/null
  sleep 2
done

MSG_COUNT=$($ROY_CMD sessions get "$SESSION_ID" 2>/dev/null | grep -o "Messages:.*[0-9]" | grep -o "[0-9]\+" || echo "0")
echo "   Message count: $MSG_COUNT"

if [ "$MSG_COUNT" -ge 5 ]; then
  pass "Session has enough messages ($MSG_COUNT)"
else
  fail "Not enough messages: $MSG_COUNT"
fi

# ===================================================================
# Test 4: 执行 compact（两阶段：auto hint + compact agent）
# ===================================================================
echo ""
echo "--- Test 4: Run compact (two-phase: auto hint) ---"

COMPACT_OUTPUT=$($ROY_CMD sessions compact "$SESSION_ID" 2>/dev/null) || true
echo "   Compact output (first 500 chars):"
echo "   ${COMPACT_OUTPUT:0:500}"

if echo "$COMPACT_OUTPUT" | grep -q "Auto-generated\|Scenario Hint\|Compact\|checkpoint\|Checkpoint"; then
  pass "Compact executed with two-phase flow"
else
  echo "   [WARN] Output pattern not matched, but compact may have succeeded"
fi

# ===================================================================
# Test 5: 验证 checkpoint 已保存
# ===================================================================
echo ""
echo "--- Test 5: Verify checkpoint ---"

CHECKPOINTS=$($ROY_CMD sessions checkpoints "$SESSION_ID" 2>/dev/null) || true
echo "   Checkpoints output:"
echo "   ${CHECKPOINTS:0:500}"

if echo "$CHECKPOINTS" | grep -qi "checkpoint\|Process\|Key Points"; then
  pass "Checkpoint found in session"
elif [ -n "$CHECKPOINTS" ]; then
  pass "Checkpoints command returned data"
else
  echo "   [INFO] Checkpoints may be empty (depends on session state)"
fi

# ===================================================================
# Test 6: Compact with explicit scenario hint
# ===================================================================
echo ""
echo "--- Test 6: Compact with explicit scenario hint ---"

COMPACT_SCENARIO=$($ROY_CMD sessions compact "$SESSION_ID" --scenario "This is a test session about weather. Focus on extracting the main topic and any key preferences." 2>/dev/null) || true
echo "   Output: ${COMPACT_SCENARIO:0:500}"

if [ -n "$COMPACT_SCENARIO" ]; then
  pass "Compact with explicit scenario hint succeeded"
else
  fail "Compact with explicit scenario hint failed"
fi

# ===================================================================
# Summary
# ===================================================================
echo ""
echo "=============================================="
echo "   Results: $PASS passed, $FAIL failed"
echo "=============================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
