# Ink → @opentui/solid 迁移：API 映射表 + 风险清单 + 分片计划

> **分支**：`feat/tui-opentui-migration` ｜ **worktree**：`.worktrees/feat-tui-opentui`
> **基线**：`main` @ `5f8de3cb`（v1.7.50）
> **动机**：让 `roy-bot interactive` 的 thinking 块**真正可点击**（展开/折叠）。
>   Ink 无鼠标能力；opencode 的"可点击"来自 `@opentui/core`（原生 Zig 内核，onMouseUp/Down/Over/Out + MouseButton + 事件冒泡）。
>
> **文档状态**：v2（2026-10-16，片0 实证后重写）—— 取代 v1 的 `@opentui/react` 路线。

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| **路线** | ✅ **Ink → `@opentui/solid`**（❌ 不用 `@opentui/react`，见 §0.1） |
| **可行性** | ✅ 可行。片0 PoC + 片1 地基均已在真 TTY 实证 |
| **Ink API 面** | 只用了 **8 个 API**（§1），非常收敛 |
| **最大技术风险 R1** | ✅ **已解决** —— `<Static>` 的等价物是 **`screenMode: "split-footer"` + `renderer.writeToScrollback()`**（§2-R1） |
| **最大机械成本** | **34 个测试文件**依赖 `ink-testing-library`（片5） |
| **附带红利** | opentui 自带 `markdown` / `scrollbox` / `code` / `diff` / `select` / `tab-select` —— 本次**不叠加**这些重构（单一变量） |
| **不可逆性** | 换渲染器是**全量替换**，不存在"只替 thinking 块"的中间态 → 必须一次到位 |

### 0.1 为什么不用 `@opentui/react`（❌ Rejected）

最初的方案是 `@opentui/react`（保留 React/JSX，不换响应式模型）。**实测被推翻**：

```
@opentui/react@0.6.6  peerDependencies: { react: ">=19.2.0", ... }
roy-bot             React 18（ink ^5.2.1 依赖 React 18）

实测报错：TypeError: undefined is not an object
          (evaluating 'ReactSharedInternals.S')   at react-reconciler@0.33.0
```

升 React 19 会让 **`run` 链路的 ink** 承担未知风险 → 直接违反「只动 interactive」硬约束。
**改用 `@opentui/solid`**：其 peer 只有 `solid-js`，**零 React 依赖** → 两条链路彻底隔离。
（opencode 自身也选 Solid，等于走它验证过的组合。）

> 证据：`scripts/poc-opentui-thinking.tsx`（`@jsxImportSource @opentui/react` 版）按预期跑不起来，作为反证保留。

---

## 1. Ink API 映射表（Solid 真值）

> 真值来源：片0/片1 实测 + `node_modules/@opentui/solid/**/*.d.ts`。
> ⚠️ PoC 里用的是 `renderer.keyHandler = fn`（core 层直接赋值），**不是** hook；
> 迁移中统一改用 `@opentui/solid` 导出的 `useKeyboard`。

### 1.1 组件

| Ink | opentui/solid | 使用文件数 | 风险 | 备注（已实测） |
|---|---|---|---|---|
| `<Box>` | `<box>` | 9 | 🟡 中 | 底层都是 yoga(flexbox)，但**属性必须放 `style={{}}`**：`flexDirection` / `flexGrow` / `marginBottom` / `marginLeft` / `paddingX` / `gap` 同名可用；边框是 `borderStyle: "rounded"`（仅 single/double/rounded/heavy）+ `borderColor` |
| `<Text>` | `<text>` | 10 | 🟡 中 | ⚠️ **不能用 React 的 `color`/`dimColor`/`bold` props**。opentui 用 `fg` / `bg` / `attributes`（`TextAttributes.BOLD/DIM/INVERSE…`）。文本放 `content` prop 或 children |
| `<Text><Text/></Text>` | `<text><span/></text>` | — | 🟢 低 | 行内着色/加粗要嵌套 `<span style={{fg,attributes}}>`（见 `tui-solid/Spinner.tsx`） |
| `key={...}` | （不需要） | — | 🟢 低 | `<For each={arr}>` 按数组位置复用，无需 key |
| `{arr.map(...)}` | `<For each={...}>` | — | 🟢 低 | 条件渲染用 `<Show when={} fallback={}>` |
| —（自实现） | `<markdown>` | — | 🟢 红利 | roy-bot 现手写 `Markdown.tsx`；opentui 有原生 MarkdownRenderable，**片2 再评估** |
| — | `<scrollbox>` | — | 🟢 红利 | 若需要屏幕内滚动历史时可用（但 R1 首选 split-footer，见 §2-R1） |
| — | `<input>` / `<textarea>` | — | 🟢 红利 | 可替换 `ink-text-input`（当前 1 处） |
| — | `onMouseUp` / `onMouseDown` / `onMouseOver`… | — | 🟢 **核心红利** | 直接放在任意 `<box>` 上；这是本次迁移的**唯一理由** |

### 1.2 Hooks / 运行时

| Ink | opentui/solid | 使用文件数 | 风险 | 备注（已实测） |
|---|---|---|---|---|
| `useInput((input, key) => …)` | `useKeyboard((key: KeyEvent) => …)` | 3 | 🟡 中 | ⚠️ **形态不同**，不是机械替换。`KeyEvent` 字段：`name`（`"return"`/`"backspace"`/`"left"`/`"right"`/`"up"`/`"down"`/`"c"`…）、`ctrl`/`meta`/`shift`、`sequence`（原始文本，用于可打印字符输入）、`eventType`（press/repeat/release） |
| `useApp().exit()` | 自建 `onExit` 回调 → `renderer.destroy()` | 2 | 🟡 中 | opentui/solid **无 `useApp()`**；退出语义要自己实现（见 §3 片1） |
| `useStdout().rows` | `process.stdout.rows` / `renderer.terminalHeight` | 1 | 🟢 低 | 尺寸类信息走 process/renderer，不再需要 hook |
| `useStdout()` 直写 stdout | `renderer.writeToScrollback()` | 1 | 🟡 中 | 换框架后这段**重写**，且与 R1 强相关 |
| `render(<App/>, {exitOnCtrlC})` | `render(() => <App/>, renderer)` | 3 | 🟢 低 | ⚠️ Solid 版 `render` 接收的是**渲染器实例**（`createCliRenderer()` 的返回），不是 Ink 的 options 对象；且第一个参数是**组件函数**（`() => <App/>`） |
| `useState` / `useRef` / `useCallback` | `createSignal` / 闭包变量 / 普通函数 | 全部 | 🟡 中 | Solid 组件体**只执行一次**；响应式靠信号。无 re-render 身份问题 → `useCallback` 变成普通函数 |
| `useEffect` | `onMount` + `onCleanup` | 全部 | 🟡 中 | 定时器/订阅的清理走 `onCleanup` |
| — | `useRenderer` / `useTerminalDimensions` / `onResize` / `useSelection` / `usePaste` | — | 🟢 红利 | 尤其 `useTerminalDimensions`/`onResize` 对响应式布局有用 |

### 1.3 无等价物（必须重新设计）

| Ink | 使用文件 | 风险 | 结论 |
|---|---|---|---|
| **`<Static>`** | `tui/App.tsx`、`RunTui.tsx`、`ChatTui.tsx`、`tui/scrollback.ts` | 🔴 高 | **已解决**：`screenMode: "split-footer"` + `renderer.writeToScrollback()`（§2-R1） |

### 1.4 第三方依赖

| 现在 | 迁移后 | 风险 | 说明 |
|---|---|---|---|
| `ink-text-input@6` | 原生 `<input>`（或自实现，见 `tui-solid/TextInput.tsx`） | 🟡 中 | 1 处使用 |
| **`ink-testing-library@4`** | `@opentui/solid` 的 `testRender` | 🔴 **高（工作量）** | **34 个测试文件**依赖它（`grep -rl ink-testing-library packages/cli/src --include='*.test.ts*' \| wc -l` → 34）。opentui 提供 `testRender(() => <App/>, {width,height})` + `captureCharFrame()`，API 不同 → 逐个改写 |

### 1.5 JSX 转译隔离（**片1 最大的坑**，已落地）

两条链路在**同一仓库、同一 `packages/cli` 包**里共存，JSX 的 `jsxImportSource` 必须
按**文件路径**分开：interactive → `@opentui/solid`；run/Ink → `react`。

**实测结论（bun 1.3.14）——两条路径不对称：**

| 路径 | 是否按 per-file 嵌套 tsconfig 选 `jsxImportSource` |
|---|---|
| `bun build`（`Bun.build` / `build-cli-dev.ts`） | ✅ **认** —— 按文件所在目录就近取 `tsconfig.json` |
| `bun run <src.tsx>`（dev 运行时） | ❌ **不认** —— 一律用**根** tsconfig（`jsx:"react"`） |

**落地方案（三道防线）：**

1. **打包路径（interactive 实际运行路径）** —— `packages/cli/src/tui-solid/tsconfig.json` 设
   `{"jsx":"react-jsx","jsxImportSource":"@opentui/solid"}`。`bun build` 会就近取它 →
   `tui-solid/**` 出 Solid JSX，`tui/**` 仍出 `React.createElement`。**零 preload 依赖。**
   - 实测：`bun build packages/cli/src/tui-solid/App.tsx` → 产物 import `@opentui/solid/jsx-dev-runtime`；
     `bun build packages/cli/src/tui/App.tsx` → 产物仍是 `React.createElement`。
2. **IDE / `tsc` 类型检查路径** —— 每个 `tui-solid/*.tsx` 顶部加
   `/** @jsxImportSource @opentui/solid */` **文件级 pragma**。
   - 为什么需要：`bun build` 认嵌套 tsconfig，但 `tsc`（走 `packages/cli/tsconfig.json`，
     `jsx:"react"`）在**整包 typecheck** 时也会按根配置解析 `tui-solid/` → 报 214 个
     "Property 'box' does not exist on type 'JSX.IntrinsicElements'"。
   - pragma 是**零配置**的逐文件开关，`tsc` 与 bun 都认。加了之后 `tui-solid/` 类型错误 **214 → 0**，
     整包 `tsc` 错误数回到 baseline（70，全部为 main 上既有错误）。
3. **`bun run <源码>` 路径** —— 需要 `scripts/tui-solid/solid-jsx-plugin.ts` 的**按路径收窄**转译插件
   （+ `bunfig.toml` preload）。见下面这个**踩过的坑**。

> ⚠️ **踩坑记录（务必别回退）**：在 `bun run` 下注册**任何全局 tsx `onLoad`**
> （包括 `@opentui/solid/preload` 官方 preload）都会干扰 bun 内置 tsx loader：
> `interactive-ink-escape-e2e-task-2297` 的子进程 runner **静默不执行**（不打印任何东西），
> 测试从 PASS 变 FAIL。「大 filter + 不匹配返回 `undefined`」也救不了（`undefined` 会压过内置 loader）。
>
> 因此最终方案拆成**危险度不同的两个注册项**：
> - **solid-js runtime 重定向**（`dist/server.js` → `dist/solid.js`）：**默认开**。实测无害
>   （e2e #2297 仍 PASS，interactive 正常启动）。
> - **tsx Solid 转译**：**opt-in**（`ROY_SOLID_JSX=1`）。默认关 —— 因为打包产物路径根本不需要它，
>   关掉才能保证「run 链路 + 全量测试零影响」。

---

## 1.6 片2 属性映射真值表（**Ink vs opentui 实测**）

> 来源：`scripts/tui-solid/frame-truth.tsx`（`@opentui/solid` 的 `testRender`
> 无头出帧）+ 真 pty 截图。`bun run scripts/tui-solid/frame-truth.tsx` 可复现。

### 1.6.1 容器 / 布局

| Ink | opentui（`<box>`） | 实测结论 |
|---|---|---|
| `<Box flexDirection="column">` | `<box style={{flexDirection:"column"}}>` | ✅ 同名同值（yoga 底座） |
| `<Box flexDirection="row">` | `<box style={{flexDirection:"row"}}>` | ✅ |
| `<Box marginBottom={1}>` | `style={{marginBottom:1}}` | ✅ |
| `<Box marginLeft={2}>` | `style={{marginLeft:2}}` | ✅ |
| `<Box paddingX={1}>` | `style={{paddingX:1}}` | ✅（opentui 有 paddingX/Y/T/R/B/L） |
| `<Box flexGrow={1}>` | `style={{flexGrow:1}}` | ✅ |
| `<Box alignItems="center">` | `style={{alignItems:"center"}}` | ✅ |
| `<Box justifyContent="space-between">` | `style={{justifyContent:"space-between"}}` | ✅ |
| `<Box gap={1}>` | `style={{gap:1}}` | ✅（另 rowGap/columnGap） |
| `<Box width={12}>` | `style={{width:12}}` | ✅（超宽自动换行，实测 `abcdefghijkl/mnopqrstuvwx/yz`） |
| — | `style={{borderStyle:"single"}}` | opentui **默认** 边框样式 = `single`（方框） |
| Ink `borderStyle="round"` | `style={{borderStyle:"rounded"}}` | ⚠️ **命名不同**（round → **rounded**）。仅支持 `single/double/rounded/heavy` |
| Ink `borderColor` | `style={{borderColor}}` | ✅ 同名 |

### 1.6.2 文本 / 颜色 / 属性

| Ink | opentui | 实测结论 |
|---|---|---|
| `<Text color={c}>` | `<text style={{fg:c}}>` | ⚠️ 属性名 `color` → **`fg`** |
| `<Text backgroundColor>` | `style={{bg}}` | ⚠️ `backgroundColor` → **`bg`** |
| `<Text dimColor>` | `style={{attributes:TextAttributes.DIM}}` | ⚠️ 布尔 → **位掩码** |
| `<Text bold>` | `style={{attributes:TextAttributes.BOLD}}` | ⚠️ 同上 |
| `<Text italic/underline>` | `TextAttributes.ITALIC / UNDERLINE` | ⚠️ 同上 |
| `<Text inverse>` | `TextAttributes.INVERSE` | ⚠️ 同上 |
| `<Text wrap="truncate">` | `style={{truncate:true}}` / `wrapMode` | ⚠️ Ink 用 `wrap`，opentui 用 `wrapMode:"none"|"char"|"word"` |
| `<Text>{'\n'}</Text>` | 同 | ✅ `content` / children 里的 `
` 正常换行 |
| `<Text>{ANSI}</Text>` | ❌ **不解析** | 🔴 **最大差异**：Ink 解析嵌套 SGR；opentui 把 `[1m` 当**字面文本**渲染成 `[1m`。必须转换（见 1.6.3） |
| `<Text color="">` | ❌ 品红 | 🔴 opentui `parseColor("")` 打 *"Invalid hex color: , defaulting to magenta"* 并画**品红**。必须 `"" → undefined` |
| 文本放 children | 也可 `content={str}` | ✅ 两者皆可 |
| `<Text><Text/>{x}</Text>`（行内） | `<text><span style={...}>…</span></text>` | ⚠️ 行内着色必须用 `<span>`（`textNodeKeys`: span/b/strong/i/em/u/a/br） |

### 1.6.3 ANSI → span 转换（**片2 的实质工作**）

`render/markdown.ts` 产出的是 **SGR 风格字符串**（`\x1b[1m` / `\x1b[33m` …）。
Ink 直接吃；opentui 必须转成 `<span>` 树。新模块 `tui-solid/style.ts`：

```ts
ansiToRuns("\x1b[1mbold\x1b[22m")  // → [{ text:"bold", style:{attributes: BOLD} }]
```

- 支持 SGR：reset / bold(1) / dim(2) / italic(3) / underline(4) / inverse(7) /
  strikethrough(9) 及其 off（22/23/24/27/29）、基础前景 30-37/90-97、背景 40-47/100-107、
  256 色 `38;5;n` / `48;5;n`、真彩 `38;2;r;g;b`
- 非 SGR 的 CSI 与 OSC/DCS/APC/PM 一律**剥离**（绝不作为文本泄漏）
- 相邻同样式 run 会自动合并，减少 DOM 节点

### 1.6.4 🔴 `<Show>` children 是**急求值**的（片2 修掉的致命 bug）

| | React / Ink | bun's Solid JSX |
|---|---|---|
| `cond ? <X/> : null` | ✅ 惰性（条件为假**不构造**） | — |
| `<Show when={false}><X/></Show>` | ✅ 惰性 | ❌ **`<X/>` 仍被构造**（`createComponent` 在 children 求值时调用） |
| `<Show when={false}>{() => <X/>}</Show>` | — | ✅ **惰性**（函数 children 才延迟） |

**后果（真实事故）**：`App.tsx` 的 `<Show when={item.role==="tool"}>` 为假时，
`<ToolCall info={item.tool!}/>` 仍被构造 → `describeToolCall(undefined)` →
`TypeError: undefined is not an object (evaluating 'props.info.name')`。
**只要 history 非空，整棵 App 渲染就抛错**（渲染器 ErrorBoundary 吞掉 → UI 静默冻结）。
片1 的启动截图 history 为空，因此漏检。

**修法（两重防御）**：
1. 所有条件 children 改成**函数式** `{() => …}`（`App.tsx` / `ToolCall.tsx`）
2. `ToolCall` 内 `props.info ?? EMPTY_INFO` 兜底

> 复现：`bun run scripts/tui-solid/frame-truth.tsx` 的第 [1] 组断言（5 行 history 不抛错）。

---

## 2. 风险清单

### ✅ R1（原最高风险，已解决）：`<Static>` 的替代 = `split-footer` + `writeToScrollback`

**Ink 的 `<Static>`**：把历史**永久写入终端 scrollback**、之后不再重渲染 → 防闪烁的根基。
**opentui 没有 `<Static>` 组件**，但有等价的**模式**：

```ts
const renderer = await createCliRenderer({
  screenMode: "split-footer",      // ← 默认是 "alternate-screen"，必须显式改
  footerHeight: 12,                // 底部动态区高度
  externalOutputMode: "capture-stdout",
});
renderer.writeToScrollback((ctx) => ({ root: someRenderable, width: ctx.width }));  // 写一次 = 一条历史
```

**片0 实证（`scripts/poc-opentui-solid/r1-capture.py`，真 pty 抓原始字节流）：**

| 问题 | 实测答案 |
|---|---|
| opentui 是否用 alternate screen？ | **默认是**（`resolveModes`: `config.screenMode ?? "alternate-screen"`；实测 `alternate-screen` 模式输出 `\e[?1049h` / `\e[?1049l`）。`main-screen` 与 **`split-footer` 都不进 alt screen**（无 1049h/l） |
| split-footer 能否复现"历史不重渲染"？ | ✅ **能**。写 3 条 HISTORY 到 scrollback，在 120ms 动态 tick 持续刷新下，**每条只出现 1 次**（累积计数恒为 1）→ write-once 语义成立 |
| 鼠标还能用吗（迁移的唯一理由）？ | ✅ **能**。`useMouse: true` 下三种 screenMode 都开启 `?1000h ?1002h ?1003h ?1006h`（SGR 鼠标追踪） |
| 对"直接写 stdout"方案意味着什么？ | alt screen 下**不行**（opentui 独占屏幕缓冲）；split-footer 下**可行**（它保留 main screen，正是为"历史留在终端 scrollback + 底部固定 footer"设计 —— opencode 就这么用） |

**推荐方案**：`screenMode: "split-footer"`；历史消息经 `writeToScrollback()` **一次性**提交
（等价 `<Static>`），底部动态区（thinking / streaming / 输入行）继续走 opentui 重渲染。
同时**保留 `main-screen` 作为降级**（若 split-footer 在个别终端表现异常）。

> 参考实现：opencode `packages/tui/src/mini/runtime.lifecycle.ts`（`createRuntimeLifecycle`）、
> `packages/tui/src/mini/scrollback.surface.ts`。

### 🔴 R2：测试基建 34 个文件

34 个文件依赖 `ink-testing-library`（片0 文档写 40，实测 **34**）。
opentui 的 `testRender` 可产出头帧（`captureCharFrame()`），但 API 不同。
**建议**：先建"新测试写法样板"（迁 1 个组件 + 它的测试作为范本），再批量推进（片5）。

### 🟡 R3：`useInput` → `useKeyboard` 不是机械替换（3 处）

范式不同（回调式 vs `KeyEvent` 判名）。要逐处重写并回归：
`tui-solid/TextInput.tsx`（编辑键 / 历史导航）、slash popup、`repl-ink`。
→ 片1 已把 `TextInput` 落到 `tui-solid/TextInput.tsx`（`name === "return"/"backspace"/"left"/…`）。

### 🟡 R4：布局/颜色属性逐个核对（9 + 10 处）

同用 yoga（flexbox 语义一致），但**取值/命名不同**，且**颜色空串陷阱**：
`parseColor("")` 会打印 *"Invalid hex color: , defaulting to magenta"* 并画品红。
Ink 里 `color=""` 是"无色"（NO_COLOR 模式），opentui 必须映射成 `undefined`。
→ 片1 在 `tui-solid/theme.ts` 提供 `fg(color)` 适配器（`"" → undefined`）。

### 🟡 R5：`useStdout` 直写 stdout 的那段（1 处）

`RunTui.tsx` 直接写 stdout（scrollback/spinner 清理）。换框架后大概率重写，且与 R1 强相关。

### 🟢 R6：附带红利可推迟

opentui 的 `<markdown>` / `<code>` / `<diff>` / `<select>` / `<tab-select>` 能替换手写实现 ——
**建议本次迁移不叠加这些重构**，保持"只换渲染器"的单一变量，否则出问题无法归因。

### ✅ R8（片2 发现 → **片3 已解决**）：`interactive` 完全非响应式（构建期双插件修复）

**最终机制（一句话）**：在 `Bun.build` 注入**两个**插件 ——
① `solidClientResolvePlugin()`（`onResolve` 把 `solid-js` / `solid-js/store` /
`@opentui/solid`(+jsx-runtime) 重写到**显式 client 产物**并 inline）；
② `scopedSolidTransformPlugin()`（**只对本仓库 Solid 源文件**跑官方
`transformSolidSource` = babel-preset-solid，**绝不触碰 node_modules**）。

实现：`scripts/tui-solid/solid-client-resolve-plugin.ts`
接入：`scripts/build-cli-dev.ts`、`scripts/build-cli-prod.ts`、`scripts/build-standalone.ts`

#### 根因有**两半**（片2 只找到一半 → 所以片2 的修复都没生效）

**半边 A（解析）**：`solid-js` 的 `exports["."].node` → `dist/server.js`（SSR）；
`packages:"external"` 让裸 specifier 留到运行期 → bun 按 node 条件命中 SSR。

**半边 B（转译）⚠️ 片2 完全漏掉，才是"能画首帧但完全死"的直接原因**：
**bun 内置 JSX transform 是"急求值"（React 风格）**，Solid 需要
babel-preset-solid 生成**惰性 prop getter + `effect(() => setProp(...))`**：

```js
// ❌ bun 内置：content 构造时求值，signal 变了也不重算
jsxDEV("text", { content: "TXT=" + txt() }, ...)
// ✅ Solid 转译：响应式
effect((_$p) => setProp(_el$2, "content", "TXT=" + txt(), _$p));
```

片1/片2 的「JSX 隔离三道防线」只保证 `jsxImportSource` 指向 `@opentui/solid`
（`createElement` 来自 opentui），**转译本身仍是 bun 内置** → 急求值 → 死。

#### 为什么必须自写 scoped 转译插件

官方 `@opentui/solid/bun-plugin` 的 `createSolidTransformPlugin()` 会**额外**注册一条
`node_modules/solid-js/dist/server.js → solid.js` 的**全局 onLoad**；在
`roy-bot run`（Ink/React）链路里会干扰 bun 内置 tsx loader → 实测把
`interactive-ink-escape-e2e-task-2297` 从 **PASS 打成 FAIL**。
我们的 scoped 版在 `onLoad` 里先判路径（`node_modules` 直接 `return undefined`，
非 scope 目录直接 `return undefined`）→ run 链路**零影响**。

#### 客观证据

| 维度 | 结果 |
|---|---|
| dist 裸 `solid-js` specifier | **0** 处 |
| dist 响应式转译 `effect((_$p) => setProp` | **18** 处 |
| 真 pty `--scenario typing` | **4/4 ✅**（hello world 回显 / 退格 / 方向键插入 / 回车清空） |
| 双 cwd（根 + `packages/cli`） | **都回显 `hello`** ✅ |
| `/help` | 正常输出 4 条命令 ✅ |
| `onMount` / `createEffect` | 真执行（探针 `effect txt: h→he→…→hello`） |
| `task-2297` e2e | **4 pass / 0 fail** ✅ |
| `test:cli:fast` | 1780 pass / 335 skip / 13 fail / 1 error；失败集合与 baseline **逐条一致**（零新增） |

**依赖面**：不依赖 cwd、不依赖 preload、可提交、对 dist 产物有效。
详见 `reports/4278-phase2-screenshots/R8-reactive-blocker.md`。

> 片2 的 7 条失败尝试中，**#6「runtime plugin 对 node_modules 不触发」是误判** ——
> 本轮实测 `onLoad`/`onResolve` **确实触发**；真正的坑是它依赖
> `bunfig#preload`，而 preload **只在 cwd = 仓库根时加载** → 不可提交。

---

### ✅ R1（片4 已落地）：`<Static>` 等价物 = `split-footer` + `writeSolidToScrollback()`

**机制**：已提交历史**不再留在响应式树里**。每条消息用
`writeSolidToScrollback(renderer, () => <HistoryEntry item={...}/>)`
一次性渲染进终端 scrollback（`@opentui/solid` 导出的 Solid 原生 API，
内部即 `createScrollbackWriter` + `renderer.writeToScrollback`），随后立刻脱离
响应式树 → 动态区 tick（spinner / 流式 / 实时工具卡）**无法**触发它重绘。

- 组件：`tui-solid/RunScreen.tsx#commitHistory()`
- 复用同一 `HistoryEntry`（已 `export`）渲染五行，scrollback 行与帧内行样式一致
- 兜底：renderer 不支持 scrollback 时（如单测 renderer）落到帧内 `fallbackHistory` 信号，消息不丢
- 前置条件：`commands/interactive.ts` 已设 `screenMode:"split-footer"`（片1 起）

**字节流级证据**（`scripts/tui-solid/verify-scrollback.py`，6/6 ✅）：

| 检查 | 结果 |
|---|---|
| ① 不进 alternate screen | `\e[?1049h` / `\e[?1049l` 均**不存在** |
| ② 历史 write-once | `/help` 指纹在**整条**字节流里只出现 **1** 次（后续打字也不重放） |
| ③ 鼠标追踪仍开 | `?1000h/1002h/1003h/1006h` 各 1 |
| ④ 历史可见 | 指纹出现在屏幕 |
| ⑤ 输入行回显 | `hello world` 出现在屏幕 |

---

### ⚠️ R7：`@opentui/core` 是**原生 Zig 内核**

有**平台二进制依赖**（`@opentui/core-linux-x64` 等 optionalDependencies）。已措施：
- 本机（linux-x64）原生内核可用（片0 实证）
- `packages/cli/bunup.config.ts` 加了 `external: ["@opentui/core","@opentui/solid","solid-js"]`，
  避免打包时内联各平台 .node/.so
- **仍需验证**：各平台（linux-arm64 / darwin-* / win32）可取到二进制；`scripts/build-standalone.ts`
  能否正确带上它（片7）。这会波及发布链路，不只是 TUI。

---

## 3. 分片计划（每片可独立验证）

| 片 | 内容 | 验证方式 | 状态 |
|---|---|---|---|
| **0. PoC（不改主代码）** | ① opentui 是否用 alt screen ② `<Static>` 替代可行性 ③ 最小 App：box+text+鼠标点击 ④ Zig 原生库本机可用 | 独立脚本，真 TTY 看到鼠标点击生效 | ✅ **完成**（`reports/4278-poc-screenshots/` 4 张 + `r1-out/`） |
| **1. 地基** | 依赖、`tui-solid/` fork、`render` 入口替换、退出语义、**JSX 转译隔离**、构建适配 | `roy-bot interactive` 能启动并显示静态内容 | ✅ **完成**（`reports/4278-phase1-screenshots/`） |
| **2. 布局与文本** | `<Box>`→`<box>`、`<Text>`→`<text>` 全量对齐（颜色走 `fg()` 适配器）；评估 `<markdown>` | 逐组件视觉回归 | 🟡 **部分**（属性对齐 + 急求值 bug + ANSI→span 已修；20/20 帧断言通过，见 §1.6；R8 已解决（片3），真 pty 运行时验收通过） |
| **3. 交互** | `useKeyboard` 语义对齐、`TextInput` 编辑键/历史、slash popup | 按键行为回归 | ✅ **完成**（`13ee23f6`/`d6b1bf05`；Home/End + Delete 独立语义；真 pty `editing_keys` 3/3） |
| **4. 历史渲染（R1）** | `split-footer` + `writeToScrollback()` 落地（把 history 从帧内挪进 scrollback） | 无闪烁 + 历史可读 + 鼠标仍可用 | ✅ **完成**（`3900ac20`/`c17cc45b`；`writeSolidToScrollback`；字节流 6/6） |
| **5. 测试基建（R2）** | `ink-testing-library` → `testRender`（34 文件） | 全绿 | 🟡 **样板完成 1/34**（`4cac3821`；Spinner 迁移 6 pass/1 skip；实测出 2 个 `bun test` 阻塞，见 §7.1） |
| **6. 目标功能** | **thinking 块可点击展开/折叠**（迁移的初衷） | 手动 + 测试 | ✅ **完成**（`8c47e7b2`；真 pty 注入 SGR 鼠标双向 9/9，见 §7.2） |
| **7. 发布链路（R7）** | standalone/多平台构建 + npm 发布验证 | `publish:full` 演练 | ✅ **完成**（5 平台构建 + standalone 产物真 pty 9/9；修掉交叉编译原生包缺失，见 §7.3） |

---

## 4. 片1 已落地的文件与机制（本片交付）

```
packages/cli/src/tui-solid/            ← 新增（fork，专供 interactive）
├── tsconfig.json                       ← ① 转译隔离第一道防线（jsxImportSource: @opentui/solid）
├── index.ts                            ← 组件出口
├── theme.ts                            ← 复用 tui/theme.ts + fg() 空串适配器
├── App.tsx                             ← fork tui/App.tsx（<box>/<text>/<Show>/<For>）
├── Markdown.tsx  Spinner.tsx  StatusBar.tsx  ToolCall.tsx  TextInput.tsx
├── use-streaming-accumulator.ts        ← React hook → Solid（信号 + 闭包 ref）
├── RunScreen.tsx                       ← fork RunTui.tsx 的组合根（对话循环）
└── mount.tsx                           ← JSX 桥（run.ts 是 .ts，写不了 JSX）

scripts/tui-solid/
├── solid-jsx-plugin.ts                 ← ② 转译隔离第二道防线（scoped，opt-in）
├── solid-jsx-preload.ts                ← bunfig preload 入口（runtime 重定向默认开）
└── capture-interactive-solid.py        ← 真 TTY → PNG 取证脚本

bunfig.toml                             ← preload 声明（默认只做 runtime 重定向）
packages/cli/src/commands/interactive.ts  ← render 入口换 opentui/solid（唯一改动的既有文件）
packages/cli/bunup.config.ts            ← external 加 @opentui/* + solid-js（R7）
```

**复用的纯模块（不 fork，避免漂移）**：`tui/theme.ts`、`tui/scrollback.ts`、
`tui/tool-call.ts`、`tui/text-input-editing.ts`、`render/markdown.ts`、`slash.ts`。

**退出语义**：`exitOnCtrlC: false` + RunScreen 的 `onExit` → `run.ts` 里
`screenMode: split-footer → main-screen` 再 `renderer.destroy()`，最后走既有
`shutdownRunSteps()` + `process.exit(0)`。

---

## 5. 片0/片1 实证证据索引

| 证据 | 位置 |
|---|---|
| 片0：鼠标点击 toggle 双向可用（4 张 PNG） | `reports/4278-poc-screenshots/01..04-*.png` |
| 片0：可复现渲染脚本（pty + pyte + PIL） | `scripts/poc-opentui-solid/render-screen.py` |
| 片0/片1：R1 三模式字节流判定 | `scripts/poc-opentui-solid/r1-capture.py`、`r1-out/summary.json`、`r1-out-mouse/summary.json` |
| 片0：React 路线失败证据（保留） | `scripts/poc-opentui-thinking.tsx`（`@jsxImportSource @opentui/react`，跑不起来） |
| 片1：interactive 启动截图 | `reports/4278-phase1-screenshots/01-interactive-solid-boot.png` |
| 片1：取证脚本 | `scripts/tui-solid/capture-interactive-solid.py` |

---

## 6. 待确认项（我没有替用户决定的）

1. **R1 体验取舍** —— `split-footer` 下历史留在终端 scrollback（不再由 TUI 重绘）。
   这意味着"向上滚看历史"由终端负责（与 Ink `<Static>` 一致）。若用户希望 TUI 内**自己滚动**，
   则改用"自管 buffer + `<scrollbox>`"（成本更高）。**当前推荐 split-footer。**
2. **是否接受"只换渲染器、不叠加 markdown/scrollbox 红利"** —— 建议接受（单一变量）。
3. **迁移期间 interactive 可用性** —— 片1 起 interactive 已切到 Solid；片2~6 期间视觉/交互会分步补齐。
   是否需要 feature flag 保留 Ink 版 interactive？（当前**没有**加 flag，因 `run` 链路仍完整可用。）
4. **R7 是否阻塞** —— 若 Zig 原生库在 standalone 构建/某些平台不可用，则发布链路受阻，需评估。

---

## 附：数据来源（可复现）

```bash
# ink API 面（roy-bot 实际用量）
grep -rhoE 'import \{[^}]*\} from "ink"' packages/cli/src | ... | sort | uniq -c
# → Text 10 / Box 9 / useInput 3 / useApp 3 / render 3 / Static 2 / useStdout 1

# 依赖 ink-testing-library 的测试文件数
grep -rl ink-testing-library packages/cli/src --include='*.test.ts*' | wc -l   # → 34

# @opentui/solid 的真实导出（本片真值来源）
cat node_modules/@opentui/solid/index.d.ts
cat node_modules/@opentui/solid/src/elements/hooks.d.ts        # → useKeyboard/useRenderer/…
cat node_modules/@opentui/solid/src/elements/catalogue.d.ts    # → box/text/scrollbox/markdown/…
cat node_modules/@opentui/solid/src/scrollback.d.ts            # → writeSolidToScrollback

# screenMode 默认值 + split-footer 语义（core 实现）
grep -o 'screenMode = config.screenMode ?? "[a-z-]*"' node_modules/@opentui/core/chunk-bun-*.js
# → "alternate-screen"

# 鼠标能力来源（opencode 用法）
/tmp/opencode/opencode-src/packages/tui/src/mini/runtime.lifecycle.ts
#   → screenMode: "split-footer", footerHeight, externalOutputMode: "capture-stdout"
#   → renderer.writeToScrollback(write)

# React 路线失败的 peer 证据
python3 -c "import json;print(json.load(open('node_modules/@opentui/react/package.json'))['peerDependencies'])"
# → {'react': '>=19.2.0', ...}

# 转译隔离实证
bun build packages/cli/src/tui-solid/App.tsx --outfile=/tmp/a.js  # → @opentui/solid/jsx-dev-runtime
bun build packages/cli/src/tui/App.tsx       --outfile=/tmp/b.js  # → React.createElement
```
EOF

---

## 7. 片5/片6/片7 结论（2026-10-17）

### 7.1 片5 测试基建（R2）— 样板 1/34 + 两个实测阻塞

样板：`packages/cli/src/tui-solid/Spinner.opentui.test.tsx`（Ink `tui/Spinner.test.tsx` 的
6 条断言 1:1 移植，**纯增量，未删任何测试**）→ `6 pass / 1 skip / 0 fail`。

**配方（后续 33 个文件照抄）**

| Ink（`ink-testing-library`） | opentui（`@opentui/solid`） |
|---|---|
| `render(<C {...props}/>)` | `await testRender(() => <C {...props}/>, {width,height})` |
| `const { lastFrame } = …` | `await t.renderOnce(); t.captureCharFrame()` |
| `rerender(<C …/>)` | ❌ 见阻塞 (2) |
| `unmount()` | `await t.dispose()` |

**🔴 阻塞 (1)：每个 .tsx 测试必须自带 `/** @jsxImportSource @opentui/solid */` 作第 1 行。**
`bun test` 的 `.tsx` 走 bun 内置 JSX 转译（默认 `react/jsxDEV`）→ 元素是 React descriptor，
`captureCharFrame()` 返回全空格帧。⚠️ 该 pragma **字面量也不能出现在 docblock 里** ——
bun 会扫注释里的 pragma 标记，然后去 `resolve('<pkg>/jsx-dev-runtime')` 并报
`Cannot find module '@opentui/solid`/jsx-dev-runtime'`。

**🔴 阻塞 (2)：`bun test` 把 `solid-js` 解析到 SSR 构建，且 opentui 测试渲染器不重绘。**
实测：`createEffect(() => seen.push(n())); setN(1)` 在 plain `bun test` 下 `seen=[]`，
`bun --conditions=browser test` 下 `[0,1,2]`。**但即使 client runtime 生效，
`captureCharFrame()` 在 signal 变更后仍不重绘**（实测 `repaintable=false`，
`flush()` / `renderOnce()` / `waitForFrame()` 都不触发）。因此：
- `bun test` 层 → 只断言**静态结构**（`captureCharFrame()` 首帧）✅
- repaint 类断言（动画 / 计时器 / 输入回显）→ 必须走**真 pty**（`scripts/tui-solid/e2e-*.py`）
  或 `bun run` 的 `frame-truth.tsx`

样板内置 `isSolidReactive()` / `canRepaint()` 探针，`skipIf` 由实测决定并打印
`[片5] solid-reactive=… repaintable=… => animation assertion SKIPPED` —— **杜绝假绿**。

**迁移进度：1/34**。剩余 33 个中约 20 个属 `run`/`ChatTui` 链路 —— 硬约束禁止改动，
其测试也无迁移必要；真正需迁的约 13 个（`tui/` 下与交互链路相关的组件测试）。

### 7.2 片6 目标功能 — thinking 块可点击（✅ 迁移初衷达成）

**真 pty 注入标准 xterm SGR 鼠标事件**（`ESC[<0;x;yM` 按下 + `ESC[<0;x;ym` 抬起，
与真人左键字节流一致）→ **9/9 断言全过**：
折叠（`▸ click to expand · t`）→ 点击**展开**（`▾ click to collapse · t` + reasoning 正文可见）
→ 再点击**收起**（双向）→ 键盘 `t` 再次展开（fallback）。
字节流：无 `\e[?1049h`、鼠标 `1000/1002/1003/1006` 全开。

**reasoning 链路（原本在三处断裂，本轮全部接通）**

1. `commands/interactive.ts#createStreamHandleQuery`：`llm.reasoning` 原在 `default:` 分支被**显式丢弃**。
   新增可选第 4 参 `onReasoning`，走**独立通道**（不进 `onChunk`，绝不污染回答正文）。
2. `services/stream-output.service.ts#handleReasoning`：`reasoningStarted` 分支**提前 return**，
   吞掉首条之后所有 reasoning delta（TUI 只能看到前 ~15 字符）。改为 `emitChunk` **无条件**执行。
3. `tui-solid/RunScreen.tsx#executeQuery`：**从未调用 `stream.start()`**（React 版 `RunTui.tsx:185` 有）
   → `status` 永不进入 `"thinking"` → 点击行根本不出现。

**UI**：`tui-solid/App.tsx` 新增 `ThinkingBlock` —— 整行承载 `onMouseUp`（片0 PoC 验证过的写法）
+ `useKeyboard('t')` fallback；条件 children 用**函数式**（避开片2 急求值坑）。
`use-streaming-accumulator.ts` 新增 `appendReasoning()` / `thinkingText()`
（追加式；**不改** `status`、**不动** `streamingText`）。

**与片4 兼容**：thinking 行留在 **footer 动态区**，历史仍走 `writeSolidToScrollback`
write-once（真 pty 复验无 alt screen + 鼠标仍开）。

**TDD**：accumulator 8、`run.ts` reasoning 转发 4、stream-output reasoning 全量 emit 2 —— 均先见 RED 再见 GREEN。

**证据**：`reports/4278-phase6-screenshots/`（5 PNG + `raw-thinking-clickable.bin` +
`ansi-thinking-clickable.json`）＋ 可复现 harness `scripts/tui-solid/e2e-thinking-clickable.py`
＋ 确定性 reasoning 流 `scripts/tui-solid/fake-reasoning-llm.ts`。

### 7.3 片7 发布链路（R7）— ✅ 关闭唯一未验证风险

| 检查 | 结果 |
|---|---|
| **standalone 产物真能跑** | ✅ `build-standalone.ts`（linux-x64，121.6MB）→ 真 pty **直接跑该产物**（不经 bun）→ 片6 全套 **9/9**（含 SGR 鼠标双向 + 键盘 t + reasoning 正文 + 无 alt screen + 鼠标全开） |
| **多平台** | ✅ `--all` 构建 **5/5 成功**：linux-arm64 125.8MB / linux-x64 127.5MB / darwin-arm64 90.5MB / darwin-x64 96.1MB / win32-x64 126.2MB |
| **原生包可获取** | ✅ 8 个 `@opentui/core-*` npm 0.6.6 全部存在 |

**🔴 发现并修复真实阻塞（交叉编译）**：`@opentui/core` 用**静态**
`await import("@opentui/core-{os}-{arch}")` 覆盖全部 8 个平台包，而 npm 只装当前平台的
`optionalDependency` → `build-standalone.ts --all` 报
`Could not resolve: "@opentui/core-linux-arm64"`。

- ❌ **不可行方案**：`external: [...]` 保留裸 specifier → 运行时
  `Cannot find module '@opentui/core-linux-x64' from '/$bunfs/root/src/bin/roy-bot.js'`
  （standalone 打包产物无 node_modules，必须真正内联）。
- ✅ **采用方案**：新增 `scripts/tui-solid/ensure-opentui-native-packages.ts`
  （从 registry `npm pack` + 解包到 `node_modules/@opentui/`，**绕过 npm 的 os/cpu 门禁**；
  幂等，支持 `--check`），并在 `build-standalone.ts` 的 `--all` 路径**自动调用**。
  已验证幂等性（移走任一包后能自动补回）。
