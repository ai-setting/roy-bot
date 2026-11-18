# @ai-setting/roy-bot-cli Changelog

All notable changes to the CLI package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.8] — 2026-08-11 (Patch: wiki batch 3 bug 修复 — Task #2900)

3 个 bug 同步修复（涉及 core 1.7.5 / cli 1.7.8 联动）：

### Fixed

- **🔴 P0-A: `executor` 静默吞 bash 节点错误**（Task #2900）

  `packages/core/src/env/workflow/nodes/tool-node.ts` 的 `execute` 路径下，
  bash 工具返回 `{success: false, error: "..."}` 时，wrapper 错误被丢弃 —— `NodeExecutionResult.error` 始终是 `undefined`，
  节点被错标为 `completed`，下游 `engine.ts:1675` 的 `markCompleted` 误触发。

  修复：调用 `extractErrorFromWrapper(output)` 解析 wrapper 层的 `{success, error}` 字段，
  当 `success === false && error` 非空时，把它作为 `NodeExecutionResult.error` 透传，
  让 engine 的 `if (result.error) return` 路径正确把节点标 `failed`。

- **🔴 P0-B: 重建 `lib/wiki-auth.sh` 库**（Task #2900）

  `packages/core/src/env/workflow/lib/wiki-auth.sh` 整个库（连同 `lib/` 目录）都不存在，
  而 `get-jwt` workflow 节点硬依赖 `safe_run_dir / preflight_check / jwt_lock_acquire /
  jwt_cache_exists / jwt_cache_read / cookie_extract_sid` 等 11 个函数。

  重建全部 11 个函数（328 行 bash）：
  - `safe_run_dir`（runId 抗冲突）
  - `preflight_check`（JSON 状态输出）
  - `jwt_lock_acquire` / `jwt_lock_release`（flock + mkdir 兜底，0600 mode）
  - `jwt_cache_exists` / `jwt_cache_age_seconds` / `jwt_cache_read` / `jwt_cache_write`
  - `cookie_extract_sid`（ones-ids-sid 解析）
  - `is_retryable_error` / `is_non_retryable_error`（HTTP status 判断）

  安全：cache / lock 文件 0600 mode，LDAP_PASSWORD env-only（不写日志）。

- **🟡 P1: `SessionComponent.updateSession` redact 敏感字段**（Task #2900）

  `packages/core/src/env/workflow/engine/engine.ts` 的 SessionComponent.create / merge 路径下，
  整个 `input` 对象被 `JSON.stringify` 到 `metadata.input` 持久化 —— 包含明文 `password` /
  `LDAP_PASSWORD` / `apiKey` / `token` / `secret` 等敏感字段，存在泄露风险。

  修复：新增 `packages/core/src/env/workflow/utils/sensitive-redact.ts`（93 行），
  递归遍历输入，case-insensitive 匹配以下 key：
  `password / ldap_password / apikey / api_key / token / secret / auth / access_token /
   refresh_token / authorization / cookie / private_key / session_token / sid`，
  命中后值替换为 `'[REDACTED]'`（不返回原值，且不修改原 input）。

  在 `engine.ts` 的 create (`L450`) 和 merge (`L515`) 两个持久化点都注入。

**测试**（关键数字）：
- `tool-node-bash-error-propagation.test.ts`：**4/4 PASS**（bash error 透传 / 回归保护 / timeout / 抛错）
- `redact-sensitive-input.test.ts`：**9/9 PASS**（top-level / case-insensitive / nested / object / array / 不可变 / undefined / 字符串透传）
- `lib/wiki-auth.test.sh`：**17/17 PASS**（11 个函数 + 边界场景）
- `install.test.ts`（不回归）：**27/27 PASS**

**验证**: claude-minimax 交叉验证 `APPROVE-MERGE-READY` ✅ + typecheck + build + 真实测试全绿。

升级命令: `npm install -g @ai-setting/roy-bot-cli@1.7.8`

## [Unreleased]

### Added

- **`task_operation_create` 状态语义重构：action_* → milestone_* 双维度清晰化**（Task #2211）

  把 `task_operation` 的 `action_type / action_title / action_description` 重命名为更准确的里程碑语义
  `milestone_type / milestone_title / milestone_description`，与 `process_description` 形成清晰的
  **"状态/里程碑维度 + 过程维度"** 双维度分工：

  | 维度 | 字段 | 语义 |
  |------|------|------|
  | 状态/里程碑（主） | milestone_type / milestone_title / milestone_description | "达到什么状态/里程碑" |
  | 过程（可选） | process_description（100-150 字符） | "如何达到（策略+工具步骤概要）" |

  旧 `action_*` 字段标记为 `@deprecated` 兼容窗口期：
  - DB migration 004 用 `ALTER TABLE RENAME COLUMN` 改名（数据保留）
  - rowToOperation 同时输出 `milestone_*` + `action_*` 两套字段（action_* 是 alias）
  - tool schema (create/update/list) 通过 zod preprocess 自动映射 `action_*` → `milestone_*`
  - tool 输出顶部追加 `DEPRECATION NOTICE` + `metadata.deprecated_fields_used` 提示迁移
  - 旧调用方零感知（保持兼容即可），新调用方应改用 `milestone_*` 主字段

  CLI 渲染双维度：
  - `tasks operations` / `tasks get --operations` 输出区分"里程碑字段"与"📋 过程概要"标签
  - `tasks update` / `tasks complete` 内部写入改用 `milestone_*` 主命名
  - `task-event-handler` 输出 `[milestoneType] milestoneTitle` 格式

  Agent prompt 升级：
  - `prompts-index.ts` 增加"Task Operation Record — 双维度分工规范"段落
  - 明确禁止"action 当状态"和"process_description 与 milestone_description 重复"两个反模式
  - 附双维度齐全的 JSON 范例
  - `lark-cli-task-notify-plugin` 输出里程碑类型/标题/描述 + 过程概要两个独立字段

- **`task_operation_create` 新增 `process_description` 字段**（Task #2203）

  操作记录现在可以同时记录两段语义清晰的描述：
  - `action_description`：达成的状态/结果描述（保留原义，可长可短）
  - `process_description`：**新** — 采取了什么策略 + 工具步骤的过程概要

  字符范围硬约束 **100-150 字符**（应用层 zod schema refine 校验）。
  - 太短（<100）= 拒绝：无法表达过程概要就没价值
  - 太长（>150）= 拒绝：避免退化为日志细节，保持 milestone 摘要克制

  设计哲学：操作记录只承担节点阶段 milestone 摘要；
  完整过程细节通过 `sessionId` 回查 session 历史（不在此处展开）。

  - SQLite migration `003_add_process_description`（idempotent，向后兼容）
  - TaskComponent / TaskStore 透传 processDescription，create / update / get / list 全链路
  - `searchTasksByKeywords` 操作记录搜索增加 process_description LIKE 字段
  - CLI `tasks operations` / `tasks get --operations` 输出增加 `📋 过程:` 行（gray）
  - `EnvironmentServiceOptions.taskStorage` 新增（用于测试隔离）

### Performance

- **Coder harness LSP plugins now default to startup prewarming** — the unified, TypeScript, Python, and Markdown plugins establish their LSP connection during initialization so the first diagnostic call avoids process startup and initialize-handshake latency. Explicit `preloadMode: "lazy"` and `"disabled"` overrides remain supported.

- **Coder harness LSP manager caches diagnostics and dedupes inflight requests** (Task #2120) — `LSPManager.getDiagnostics()` now consults a 5-second TTL cache before contacting the server and reuses in-flight Promises for concurrent calls on the same file. Combined with prewarm, repeat diagnostic queries within 5 seconds are sub-millisecond (≈0–1 ms); 100 parallel `getDiagnostics` calls on the same file collapse to a single server round-trip.

- **Coder harness LSP manager exposes `workspaceRoot` config and CLI injects the git toplevel** (Task #2120) — `LSPManagerConfig.workspaceRoot?: string` lets callers pin a root so prewarm connections and per-file lookups share a key. The `act` CLI now detects the workspace root via `git rev-parse --show-toplevel` (cwd fallback) and passes it to the manager, ensuring prewarmed connections are actually reused.

- **Coder harness LSP manager defers idle connection pings to 30 seconds** (Task #2120) — connections reused within 30 s skip the `window/showMessageRequest` health probe, removing roughly one round-trip of latency on quick follow-up calls. Prewarmed connections skip the ping entirely.

### ⚠ BREAKING CHANGES

- **`EnvironmentServiceOptions.loadPlugins` 默认改为 `false`**（Task #1960）

  之前 `EnvironmentService.create()` **总是**初始化 `PluginComponent` 并注册到 env。
  即使命令不需要插件（如 `sessions list`、`tasks list`、`agents list`、`skills list` 等 ~60 个只读命令），
  也要付出 PluginComponent 的初始化开销。

  修复后：
  - `loadPlugins: false`（**默认**）：完全跳过 `PluginComponent` 的 init + register + dispose 清理
  - `loadPlugins: true`：保留旧行为（init + 按 `plugins` 列表加载）

  **迁移指南**：只有真正需要插件的命令才需要显式 opt-in。当前已 opt-in 的命令：
  - `roy-bot act` — `loadPlugins: true, commandName: "act"`
  - `roy-bot interactive` — `loadPlugins: true, commandName: "interactive"`
  - `roy-bot tasks complete --plugin <x>` — `loadPlugins: true, commandName: "tasks:complete"`

  其他 ~60 个只读命令（sessions/*, tasks/{list,get,create,update,...}, agents/*, skills/*, memory/*,
  prompt/*, config/*, tools/*, mcp/*, eventsource/*, workflow/commands/*, commands-*）
  **不需要任何改动** —— 它们以前就不传 `plugins`，默认 `loadPlugins: false` 对它们是正确行为。

- **新增 `EnvironmentServiceOptions.commandName?: string`**

  仅用于日志。可选地标识哪个 CLI 命令调用了 `envService.create()`，
  当 `loadPlugins === false` 时会在 debug 日志中输出 `command=<name>`。

### Fixed

- **`roy-bot install --global` 对 symlinked global install 找不到 `package.json`**（Task #1960）

  之前 `readPackageInfo()` 只在 4 条固定路径中搜索 `package.json`：
  - `process.cwd()/node_modules/<pkg>/package.json`
  - `<parent>/node_modules/<pkg>/package.json`
  - `process.cwd()/.roy/plugins/<pkg>/package.json`
  - `~/.roy-bot/node_modules/<pkg>/package.json`

  当 npm 把全局包安装到 symlinked 路径（例如 `pnpm` 全局 store、`bun add -g` 走非标准 root）时，
  `npm install -g <pkg>` 报告的全局 root（`$(npm root -g)`）与 `~/.roy-bot/node_modules` 不一致，
  导致 `readPackageInfo()` 返回 `null`，`plugins.json` 写入失败或写入错的包信息。

  修复：在 4 条固定路径之后追加第 5 条兜底路径 `$(npm root -g)/<pkg>/package.json`，
  通过新函数 `getNpmGlobalRoot()` 调用 `spawnSync("npm", ["root", "-g"], {encoding:"utf-8"})` 解析。
  `getNpmGlobalRoot()` 在 `status !== 0` 或 `stdout` 为空时返回 `null`，自动跳过兜底路径。

## [1.7.7] — 2026-08-11 (Patch: 修复 `roy-bot install --global` 升级时 plugins.json version drift — Task #2899)

**User feedback (飞书)**: `roy-bot install --global @ai-setting/roy-plugin-task-show@2.5.9` 升级后，
用户看到的 `Updated plugin` 信息显示 `v2.5.7`（陈旧），与 npm global root 真实安装的 `v2.5.9` 不一致，
导致 `~/.roy-bot/plugins.json` 记录的 version 与实际可用的版本错位。

### Fixed

- **`roy-bot install --global` 升级场景的 plugin version drift**（Task #2899）

  `packages/cli/src/commands/install/index.ts` 的 `readPackageInfo` 搜索顺序里
  `~/.roy-bot/node_modules/` 排在 `$(npm root -g)`（npm global root）之前，
  而 `install --global` 的 cp 逻辑有 `if (!existsSync(globalNm))` 的 guard
  —— 升级路径下 cp 目录已存在 v2.5.7 → 跳过 cp → v2.5.9 永远进不去 cp 目录；
  之后 `readPackageInfo` 命中 stale copy → `plugins.json` 记的是 v2.5.7（与 npm 真实装的 2.5.9 不一致）。

  **修复**:
  1. **去掉 cp 逻辑**：`roy-bot install --global` 不再复制到 `~/.roy-bot/node_modules/`
     —— 解决升级路径被 stale copy 阻塞的问题，简化架构：npm 是权威，roy-bot 不再二次存储。
  2. **`readPackageInfo` 搜索顺序调整**：把 `$(npm root -g)` 提到 `~/.roy-bot/node_modules` 之前
     —— npm global root 是权威路径；历史 cp 副本降为最低优先级兜底（向后兼容旧 install 留下的副本）。
  3. **删除 `cpSync` import**：不再需要。
  4. **JSDoc 重写**：`readPackageInfo` 5 条搜索路径的清晰说明 + Task #2899/#1960/#1993 兼容说明。
  5. **remove 命令保留 best-effort `rm -rf ~/.roy-bot/node_modules/<pkg>`** 作为历史 cp 副本清理
     —— 不影响主流程（npm uninstall -g 是核心），仅清理历史状态。

**测试** (`packages/cli/src/commands/install/install.test.ts` 27 pass / 0 fail / 80 expect() calls):
- Task #1960 测试 9 个仍通过（不回归）
- Task #2899 新测试 4 个全绿：
  - 场景 A: 首次 install（cp 目录不存在）→ 命中 npm global root
  - 场景 A-2: cp 目录存在 v2.5.7 但 npm global root v2.5.0 → 命中 npm global root v2.5.0（搜索顺序验证）
  - 场景 B: 升级 install（cp v2.5.7 vs npm v2.5.9）→ 必读 v2.5.9（核心 bug）
  - 场景 C: install --global 不再 cp 到 ~/.roy-bot/node_modules/（源码不再 cpSync）

**验证**: 27/27 测试全绿 + typecheck install/ 包 0 errors + build exit 0 + 真实 install 实测（升/降级都同步到 npm global root 版本）。

升级命令: `npm install -g @ai-setting/roy-bot-cli@1.7.7`