# 片 0 PoC：截图复现说明（Task #4278 / 子任务 #4279）

把本目录的 PoC（`poc.tsx`）在**真实 TTY** 下的渲染效果抓成 PNG，
作为「thinking 块可点击展开」在 opentui 上可行的**可复现证据**。

## 一键复现

```bash
cd scripts/poc-opentui-solid
python3 render-screen.py                 # 输出到 ../../reports/4278-poc-screenshots/
python3 render-screen.py --out /tmp/x    # 自定义输出目录
# 退出码 0 = 鼠标点击 toggle 复现成功
```

产出 4 张 1384×790 PNG：流式中 / 折叠态 / 展开态 / 再点击收起。

## 为什么不用 tmux / asciinema / xdotool

本机**没有** `tmux` / `screen` / `asciinema` / `vhs` / `xdotool` / `scrot`，且**无 sudo**。
所以走 `pty.fork()` + `pyte`（终端仿真）+ `PIL`（画图）这条路。

## 关于「鼠标点击」——不是伪造的

PoC 启动时 opentui 会开启鼠标追踪：

```
ESC [?1000h  基本鼠标事件
ESC [?1002h  按键按下/释放时上报
ESC [?1003h  任何移动都上报
ESC [?1006h  SGR 编码
```

脚本**不模拟键盘**，而是往 pty 写入标准 xterm SGR 鼠标序列：

```
ESC [ < 0 ; <x> ; <y> M    # button-1 按下
ESC [ < 0 ; <x> ; <y> m    # button-1 抬起
```

这与真实终端里用户点击 thinking 行时，终端发给程序的**字节流完全一致**，
因此触发路径就是 PoC 自身的 `onMouseUp` 回调（未改一行 PoC 逻辑）。

点击坐标（行列）在运行时由 `find_thinking_row()` **动态探测**，不硬编码。

## 踩过的坑（供后续复用）

1. **`script -qec` 拿不到鼠标事件** → 必须自己开 pty 并主动写鼠标序列。
2. **`screen.buffer[y]` 是 defaultdict，迭代它得到的是列号(int)，不是 cell** → 必须按列索引。
3. **CJK 宽字符的续格在 pyte 里是空串 `""`** → pyte 自带的 `screen.display` 会
   因 `wcwidth(char[0])` 直接 IndexError 崩；必须自己拼行。
4. **拼出来的行是「思 考 完 成」带空格的**（宽字符占 2 格）→ 任何中文子串匹配都要先去空白。
5. **CJK 等宽字体没有 `▸ ▾ ⠋`**（会画成 notdef 方块）→ 用
   `NotoSansSymbols2-Regular.ttf` 兜底，并用「与必然缺失码点比像素」的方式探测缺字形。
6. **pyte 赋色返回不带 `#` 的 hex**（`7aa2f7`）→ PIL 会报 unknown color specifier。
7. 必须回复 DSR `ESC[6n` → `ESC[1;2R`，否则 opentui 可能判定 cell 宽度不对。
8. 需要剥掉 pyte 不认识的 APC/DCS/OSC 序列（Kitty graphics / iTerm2 图像 / XTGETTCAP），
   否则会当普通字符渲染出来。

## 实测结论

| 项 | 结果 |
|---|---|
| `@opentui/core` Zig 原生内核（linux-x64） | ✅ 可用 |
| `@opentui/solid` + Solid JSX（bunfig preload） | ✅ 可用 |
| 鼠标追踪 | ✅ `?1000h ?1002h ?1003h ?1006h` (SGR) |
| **真实鼠标点击 → 展开** | ✅ `✓ 思考完成 ▾ （再次点击收起）` + 6 条 chunk |
| **再点击 → 收起** | ✅ 回到 `▸ （点击展开）` |
| CJK 渲染 | ✅ 无豆腐块（等宽字体 1:2 对齐） |
| 颜色 | ✅ 逐格真彩下采样，与源码色值一致 |
| 分隔线 | ✅ 552px 连续无断点 |

## ⚠️ 顺带发现的 2 个 PoC 小 bug（**未修**，如实记录）

均**不影响**「鼠标点击 toggle」这一核心结论（鼠标路径本身完全正确），
但应在后续分片里一并收拾：

1. **`t` 键实际不生效（文档与实现不一致）**
   `renderer.keyHandler` 里 `t` 分支调用 `globalThis.__POC_TOGGLE__?.(...)`，
   但该全局**从未被赋值** → 按 `t` 后箭头仍是 `▸`。
   同时底部提示写着「或 按 t 切换」，属误导。
   建议：把 `toggle` 挂到 `globalThis`，或去掉提示里的 `t`。

2. **操作日志文案反了**
   `toggle()` 里 `setLog(... ${!expanded() ? "展开" : "收起"})` 用了**翻转后**的信号值，
   所以点击「展开」被记录成「→ 收起」。
   建议：先取旧值再 set，或直接用 `setExpanded(v => { log(!v); return !v })`。

> 以上用 `render-screen.py` 的第 ④ 张图 + 键盘注入 `t` 的对照实验即可复核。
