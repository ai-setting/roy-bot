# Task 存储：本地 SQLite / 远程 task-service（Task #5440）

roy-bot 的 task 存储支持两种引擎，由 `task.storage.type` 决定。

## 一、本地 SQLite（默认，行为不变）

```yaml
task:
  storage:
    type: sqlite
    dbPath: ~/.local/share/roy-bot/tasks.db   # 可省略，用默认路径
```

- 引擎：`bun:sqlite` → `node:sqlite` → `better-sqlite3` 自动挑选
- 单进程、单文件，零运维

## 二、远程 task-service（`type=remote`）

指向常驻的 [roy-task-service](../../../../roy-task-service)（`/store/<method>` 与
`TaskStore` 1:1 映射的 HTTP 服务）。

```yaml
task:
  storage:
    type: remote
    endpoint: http://127.0.0.1:7820       # 必填
    authToken: <与 service 的 TASK_AUTH_TOKEN 一致>   # service 未配 token 时可省略
```

环境变量等价写法（`TASK_` 前缀 + 驼峰转大写下划线）：

```bash
export TASK_STORAGE_TYPE=remote
export TASK_STORAGE_ENDPOINT=http://127.0.0.1:7820
export TASK_STORAGE_AUTH_TOKEN=<token>
```

### 起一个 service（sqlite 引擎）

```bash
cd ../roy-task-service
TASK_AUTH_TOKEN=<token> TASK_PORT=7820 TASK_HOST=127.0.0.1 TASK_DB_PATH=/path/tasks.db \
  bun run packages/backend/src/server.ts
```

## 三、行为契约

| 项 | 行为 |
|---|---|
| 握手 | 首次调用前 `GET /version`，`protocol.major` 不匹配 → `RemoteProtocolError` |
| 幂等 | 写方法带 `Idempotency-Key`；**同一逻辑调用重试复用同一 key**（服务端重放缓存），不同调用用不同 key |
| 鉴权失败 | 401 → `RemoteAuthError`，**不重试**（错误信息含 endpoint 与 `task.storage.authToken` 指引） |
| 幂等冲突 | 409 `IDEMPOTENCY_CONFLICT` → `RemoteIdempotencyConflictError`，**不重试** |
| batch 占用 | sqlite 后端 batch 事务期间并发写被拒（503 `BUSY`）→ 有界重试，超限 `RemoteBatchBusyError` |
| 网络错 / 5xx / 超时 | 有界重试（默认 3 次，指数退避），超限明确报错 |
| **断服务** | **明确报错，绝不静默退回本地库**（避免双库分叉，方案 §1.3 非目标） |

## 四、两条独立接线路径都要配

`task.storage.type` 只覆盖 **agent 工具链**（`TaskComponent`）。MCP 通道
（`TaskStoreBackend`）走的是另一条路径，需要：

```ts
import { createTaskPortFromConfig, TaskStoreBackend } from "@ai-setting/roy-bot-core/env/task/backend";
import { createTaskMcpServer } from "@ai-setting/roy-bot-core/env/task/mcp";

const { port, kind } = await createTaskPortFromConfig(configComponent);
const server = createTaskMcpServer(new TaskStoreBackend(port, { sessionId }));
```

`createTaskPortFromConfig` 读同一套 `task.storage.*` 键，按 type 返回
`SQLiteTaskStore`（+ `createSQLiteTaskPort`）或 `RemoteTaskStore`（+ remote port）。

## 五、owner（负责人）字段

`Task.owner` 是 **可空字符串**：`null` = 未指派（新建默认）。

- 工具：`task_create` / `task_update` 入参含可选 `owner`（`task_update` 传
  `null` 或 `""` 表示清空，省略表示不改）
- CLI：`roy-bot tasks create --owner <x>` / `roy-bot tasks update <id> --owner <x>`
- 存储：`task` 表新增 `owner TEXT` 列 + `idx_task_owner` 索引；老库首次打开
  自动补列（migration `006_add_task_owner`），存量行 `owner` 为 `null`

## 六、验证

```bash
# 单测（mock service，覆盖全部方法与故障分支）
bun test packages/core/src/env/task/storage/remote-task-store.test.ts
bun test packages/core/src/env/task/backend/remote-task-port.test.ts
bun test packages/core/src/env/task/task-initstore-remote.test.ts
bun test packages/core/src/env/task/task-owner.test.ts
bun test packages/cli/src/commands/tasks/owner-option.test.ts

# 联调（真 service）
TASK_AUTH_TOKEN=... TASK_PORT=7899 TASK_HOST=127.0.0.1 bun run packages/backend/src/server.ts &
bun run /tmp/e2e-5440/integration.ts
```
