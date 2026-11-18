# capture-4954 — TUI 摸底取证脚本（Task #4954）

真 pty + pyte + PIL 模式（复用 #4279 沉淀）。全部脚本退出码 0 = 成功。

## 用法（同几何 112×30，便于并排对照）

```bash
cd ~/work/codework/personal/roy_world/roy-bot
unset ALL_PROXY all_proxy

# roy-bot interactive 1.7.72 standalone：boot / bracketed paste / SGR wheel
python3 scripts/tui-solid/capture-4954/capture-interactive.py
# 输出：/tmp/tui-baseline/raw-{boot,paste,wheel}.bin + 断言 ok={boot,paste,wheel}

# opencode v2.2.5 基准（本机 opencode 二进制）
python3 scripts/tui-solid/capture-4954/capture-opencode-baseline.py  # what's new 态
python3 scripts/tui-solid/capture-4954/capture-opencode-home.py      # home（esc 跳过弹层）
python3 scripts/tui-solid/capture-4954/capture-opencode-scroll.py    # pageup + 滚轮
python3 scripts/tui-solid/capture-4954/capture-opencode-paste.py     # bracketed paste → [Pasted ~3 lines]

# PNG 渲染（opencode 三张基准；roy 三张见 Task #4954 过程记录）
python3 scripts/tui-solid/capture-4954/render-opencode.py
```

## 已取证结论（2026-11-04）

| 场景 | roy-bot | opencode |
|---|---|---|
| bracketed paste 3 行 | **0 字节响应**（输入框不变） | `[Pasted ~3 lines]` 占位 |
| SGR 滚轮 ×5（历史区） | 「↑ 已回退 5 行」提示出现 | home 无历史时无响应（合理） |
| 逐键 abc | 正常入框 | 正常入框 |
| `lineA\rlineB` | `\r` 直接触发提交 | 多行入框 |

## 安全约束

- 脚本只 `kill` 自己 pty.fork 出的子进程 pid，绝不碰其它 roy-bot 进程（自保护铁律）。
- 跑前 `unset ALL_PROXY all_proxy`。
