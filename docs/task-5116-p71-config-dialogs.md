# Task #5116 P7.1 — 配置类弹窗命令：/connect auth.json + /model 选 default（摸底报告）

> 分片：roy-bot interactive TUI 对齐 opencode 工程（Task #4954）P7.1。
> 用户需求（2026-11-06 17:24 / 17:30 飞书）：见 Task #5109 附录 A.1 / A.2。
> 摸底基线：opencode v2.2.5（/tmp/opencode-src）vs roy-bot main @ aededa61（P7 已合入）。
> 日期：2026-11-06

---

## 1. opencode Dialog 组件族（摸底 file:line）

### 1.1 solid 侧 Dialog 基座（packages/ui/src/overlays/dialog/dialog.tsx）

- `Dialog`（Kobalte `@kobalte/core/dialog` 的 Content/Title/Description 包装）
  + `DialogHeader` / `DialogTitleGroup` / `DialogBody` / `DialogFooter`。
  CSS 面向 Web（dialog.css），**不能直接搬**——roy-bot 是 opentui 节点树。
- 真正可借鉴的是 **TUI 侧**实现（packages/tui/src/ui/dialog.tsx）：

| 要素 | opencode 实现 | file:line |
|---|---|---|
| 全屏遮罩 | `position="absolute" zIndex={3000}` + `backgroundColor=RGBA(0,0,0,150)` 半透明 | packages/tui/src/ui/dialog.tsx:30-58 |
| 尺寸 | `dialogWidth(size)`：medium=60 / large=88 / xlarge=116 | dialog.tsx:17-21 |
| 选择列表 | `DialogSelect`（options + onSelect + onCancel + filter） | packages/tui/src/ui/dialog-select.tsx:32-77 |
| 标题/描述/页脚 | `DialogHeader` / `DialogLayout` / `DialogFooter` | dialog.tsx（后续段） |
| 键位 | ↑↓ move / Enter select / Esc cancel | dialog-select.tsx + keybind.ts |

### 1.2 /connect 的 opencode 实现（component/dialog-integration.tsx）

- `DialogIntegration`（dialog-integration.tsx:99-）：
  `DialogSelect` 包装，options = integrations（name/description/footer 状态行/✓ gutter/onSelect）。
- `/connect` slash 命令（app.tsx:1019-1031）→ `dialog.show(() => <DialogIntegration onConnected=…>)`，
  连接成功后 `dialog.replace(() => <DialogModel providerID=…>)`。
- `DialogModel`（component/dialog-model.tsx:14-40）：
  `local.model.set({ providerID, modelID }, { recent: true })` —— 选择即持久化偏好。

### 1.3 用户需求到 roy-bot 的映射

opencode 的 connect/model 弹窗的共同形状：**遮罩 + 卡片 + 列表 + ↑↓/Enter/Esc**。
roy-bot 侧用户原话：

- `/connect`：「进入一个类似 opencode 的出来的那个弹窗，通过展示和可添加各种 provider 和 apikey，持久化到 ~/.roy-bot/auth.json 中」
- `/model`：「罗列 config.jsonc 中配置的模型以及选择一个 default 模型」

---

## 2. roy-bot 配置链路（摸底 file:line）

### 2.1 auth.json 读侧（生产链路在用）

- `resolveFallbackProviderConfig`：packages/core/src/env/llm/llm.ts:145-194
  - authPath = `path.join(os.homedir(), ".roy-bot", "auth.json")`（:151）
  - 形状：`{ providers: { [name]: { apiKey, baseURL } } }`（:169 JSON.parse，纯 JSON 设计）
- 真实文件实测（~/.roy-bot/auth.json）：`providers` 下 10+ 个 provider
  （openai/anthropic/minimax/deepseek/volcengine/glm/ali/tong/opencodego…），
  每个 `{apiKey, baseURL}`；另有顶层 `_note` 未知字段（写侧必须保留）。

### 2.2 config.jsonc 读侧 + default 模型语义

- 生产配置 `~/.roy-bot/config.jsonc`（**JSONC 带注释**）：
  - `llm.defaultModel` / `llm.defaultProvider`（当前 "GLM-5.3-Flash" / "tong"，且带大量注释掉的备选行）
  - `llm.providers.{name}.models[]` + `llm.providers.{name}.defaultModel`
  - `${file://auth.json#providers.X.apiKey}` 协议引用 auth.json（protocol-resolver）
- 解析：`parseJSONC`（packages/core/src/config/config-parser.ts:8-67，基于 jsonc-parser，
  allowTrailingComma + 注释）。CLI 侧复用：packages/cli/src/commands/config/config-service.ts:11。

### 2.3 JSONC 写回策略（决策：jsonc-parser modify/applyEdits）

**评估过的三条路**：

| 方案 | 注释 | 破坏面 | 结论 |
|---|---|---|---|
| JSON.parse + JSON.stringify 重建 | ❌ 全丢 | 大（用户 config 有几十行注释备选） | 弃 |
| 手写正则替换 `defaultModel` 行 | ✅ | 中（无该字段时插入点难定） | 弃 |
| **jsonc-parser `modify` + `applyEdits`** | ✅ | **最小 diff**（只动一个值） | ✅ 采纳 |

实测验证（本机 bun + node_modules jsonc-parser@3.3.1）：
- 已有字段含尾注释：`"defaultModel": "x", // comment` → 替换值注释保留；
- 无该字段：插入到对象末尾，其余注释保留；
- formattingOptions `{tabSize:2, insertSpaces:true}`。
- **风险**：formatting 可能规范化目标行缩进（仅该行），整文件不动。

### 2.4 atomic 写

`fs.writeFile(tmp)` → `fs.rename(tmp, target)`（同目录 rename 原子性）。
tmp 命名 `.auth.json.tmp-<pid>-<rand>`（同目录保证同文件系统）。

---

## 3. TUI 侧实现设计（tui-solid）

### 3.1 既有结构复用

| 既有物 | 位置 | P7.1 复用点 |
|---|---|---|
| 命令注册表 | tui-solid/slash-registry.ts:52-58 | /connect /model 注册 |
| 补全面板 | tui-solid/SlashPalette.tsx | 不动 |
| 主题 token | tui-solid/theme.ts（P5 15 token + useTuiThemeReactive） | Dialog 配色 |
| 键盘 | tui-solid/TextInput.tsx:235-（useKeyboard 单处理器） | 打开弹窗时 gate |
| ESC 消费契约 | TextInput onKeyConsumed + RunScreen 微任务判定 | 复用 |

### 3.2 新组件 Dialog（tui-solid/Dialog.tsx）

仿 opencode dialog.tsx 形状（opentui 版）：

```tsx
<Show when={visible}>
  <box position="absolute" width="100%" height="100%" zIndex={3000}
       backgroundColor=遮罩>          {/* 遮罩点击不关闭（终端无点击测试需求） */}
    <box width={60} flexDirection="column" borderStyle="rounded"
         borderColor=theme.borderActive backgroundColor=theme.backgroundPanel>
      <text bold fg=theme.primary>{title}</text>      {/* 标题行 */}
      {children}                                       {/* 列表或表单 */}
      <text dim fg=theme.textMuted>{hints}</text>      {/* 键位提示行 */}
    </box>
  </box>
</Show>
```

- **尺寸**：宽 60（opencode medium）；高按内容自适应。
- **列表项**：`▶ /name  description`（与 SlashPalette 行形一致，选中 `backgroundElement` 底）。
- **表单**（/connect 添加 provider）：两字段（name / apiKey / baseURL）逐字段高亮，
  Enter 下一字段、最后字段 Enter 提交、Esc 取消。输入复用受控渲染（测试渲染器首帧约束，
  见 frame-shot-p7.tsx 头注释——bun 急求值 JSX 下 testRender 只保证首帧）。

### 3.3 键盘接线（关键决策）

**打开弹窗时，TextInput 必须让位**。方案：`TextInput` 新增 prop
`keyGate?: () => boolean`——useKeyboard 回调**最开头**：

```ts
if (props.keyGate?.()) return;   // 弹窗开着 ⇒ 输入框不消费任何键
```

弹窗自己的 `useKeyboard`（挂载在 Dialog 内，RunScreen 渲染分支里）处理
↑↓/Enter/Esc/可打印字符。注意 opentui `useKeyboard` 无消费语义 ⇒
与 P7 的 ESC 契约一致：Dialog 消费 ESC 时调用既有 `onKeyConsumed` 同款通知
（由 RunScreen 传入同一 `consume` 回调），面板/弹窗都开着时 Esc 关弹窗优先。

### 3.4 命令注册表扩展

- `SlashCommandOutcome`（slash-registry.ts）扩展一个 kind：
  `{ kind: "open-dialog"; dialog: "connect" | "model" }`。
  handler 保持同步纯函数（返回意图），副作用（弹窗渲染）由 RunScreen 落地——
  与既有 `kind: "exit"` 由 handleSubmit 分支处理同构。
- `/model` 替换：P7 只读实现（interactive-slash-commands.ts:80-85）删除，
  新实现返回 `open-dialog model`；模型清单从 config.jsonc 读（RunScreen 层注入）。
- `/connect` 新增：返回 `open-dialog connect`。

### 3.5 数据模块（cli 侧，非 core）

新增 `packages/cli/src/tui-solid/app-config-io.ts`（**纯函数 + 显式 homeDir 参数**）：

- `readAuthProviders(homeDir): AuthProviderEntry[]`（损坏文件容错→空列表+error 字段）
- `upsertAuthProvider(homeDir, {name, apiKey, baseURL})`（原子写+未知字段保留）
- `redactApiKey(key): "••••1234"`（尾 4 位）
- `readModelsFromConfig(homeDir): {provider, model}[]`
- `setDefaultModel(homeDir, provider, model)`（jsonc modify 保注释 + 原子写）

⚠️ **测试隔离**：全部用 `mkdtemp` 临时 HOME，**绝不碰真实 ~/.roy-bot**
（真实 auth.json 含生产密钥）。

### 3.6 RunScreen 接线

- `const [dialog, setDialog] = createSignal<"connect"|"model"|null>(null);`
- handleSubmit 的 `open-dialog` 分支 → `setDialog(result.dialog)`；
- `<App>` children 里加 `<Show when={dialog()}>…</Show>` 弹窗 + TextInput `keyGate={() => !!dialog()}`；
- 弹窗选择 default model 后：`props.onModelChanged?.(newModel)`（App 状态栏 model 行刷新）+
  `setDialog(null)`；Esc → `setDialog(null)`。

---

## 4. 测试计划（TDD）

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯函数 | app-config-io.test.ts | auth.json 读/写/原子/未知字段/损坏容错/redact；config.jsonc 模型罗列/default 写回保注释（HOME 隔离） |
| 注册表 | interactive-slash-commands.test.ts | /connect /model 返回 open-dialog kind |
| 弹窗状态 | dialog-state.test.ts | 列表移动/表单字段切换/提交/取消纯函数 |
| 帧级 | Dialog.p71.test.tsx（browser） | 列表渲染/高亮/脱敏 key/表单渲染 |
| 截图 | scripts/tui-solid/frame-shot-p71.tsx | ≥2 张 PNG → /tmp/tui-p71/ |
| 回归 | tui-solid 全量 | 与 main 基线对账零新增 fail |

## 5. 边界与纪律

- 🔴 禁止 git stash（roy-bot 仓多 worktree 共享 stash 栈）。
- commit 身份 `developer <dev@example.com>`。
- P7.1 **不碰** packages/cli/src/commands/run.ts（run headless 并行进行中）。
- 测试不跑全量 packages/，只跑 tui-solid + 本文件。
- 写侧只在**用户显式操作**（弹窗提交）时落盘；不会在只读命令里碰文件。

---

## 6. 实施结果（TDD 记录）

| commit | 内容 |
|---|---|
| feea1780 | 摸底报告（本文件） |
| 77167164 | app-config-io.ts + 20 用例（GREEN） |
| 6a4ffec0 | dialog-state.ts + 13 用例（GREEN） |
| a1b1e475 | Dialog.tsx + 10 帧级用例（GREEN） |
| 229961de | RunScreen/TextInput/registry 接线 |
| 52debe24 | frame-shot-p71.tsx 截图脚本 |

- tui-solid 回归：worktree **477 pass / 11 skip / 0 fail** vs main 基线 444 / 0 ⇒ 零新增 fail。
- E2E 冒烟（HOME=mkdtemp）：providers 脱敏读 / upsert 未知字段保留 / models 罗列 / default 写回注释保留，全 pass。

## 7. 截图（/tmp/tui-p71/）

| 文件 | 内容 | 核验 |
|---|---|---|
| p71-01-connect-list.png | provider 列表 + 脱敏 key + ▶ 选中 | ✅ |
| p71-02-connect-form.png | 添加表单（name/apiKey/baseURL，▶ apiKey） | ✅ |
| p71-03-model-list.png | 模型列表 + [provider default] 徽标 | ✅ |
| p71-04-slash-palette-connect.png | /c 过滤面板含 /connect | ✅ |
