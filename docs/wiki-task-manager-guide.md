# wiki-task-manager 用户指南

> 统一入口管理 ONES Wiki task 操作的 workflow。单个 workflow 支持 5 种 action：`create` / `update` / `query` / `comment` / `migrate`。

**版本**: v1.2
**Workflow ID**: `wiki-task-manager` (查看实际 UUID: `bun packages/cli/dist/bin/roy-bot.js workflow list`)
**关联 workflows**:
- `wiki-create-iteration-task` v1.4 — 单次创建 task (本 workflow 的 create 分支复用其核心逻辑)
- `wiki-task-sync` v1.3 — 单次更新 task 状态/进度 (本 workflow 的 update 分支复用其核心逻辑)

---

## 1. 快速开始

### 1.1 调用方式

通过 `bun packages/cli/dist/bin/roy-bot.js workflow run wiki-task-manager --input <json>` 触发。

所有 action 共享以下通用 inputs（必填或常用）：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `userName` | string | ✅ | - | ONES 登录用户名 |
| `password` | string | ✅ | - | ONES 登录密码 |
| `action` | string | ✅ | - | `create` / `update` / `query` / `comment` / `migrate` |
| `baseUrl` | string | ❌ | `https://wiki.example.com` | ONES 服务地址 |
| `orgUUID` | string | ❌ | `ORG-UUID-PLACEHOLDER` | 组织 UUID |
| `teamUUID` | string | ❌ | `LgsUbAUo` | 团队 UUID |
| `projectId` | string | ❌ | `QqnvN7Xk4JKU4bfZ` | 项目 UUID |

### 1.2 通用调用模板

```bash
bun packages/cli/dist/bin/roy-bot.js workflow run wiki-task-manager --input '{
  "userName": "<your_username>",
  "password": "<your_password>",
  "action": "<create|update|query|comment|migrate>",
  ...action-specific-fields
}'
```

---

## 2. action=create 创建任务

### 2.1 inputs

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `iterationId` | string | ✅ | 迭代 UUID (如 `260702` 对应 `Gf2zafpn`) |
| `assignee` | string | ✅ | 被指派人 (支持用户名/邮箱/UUID，自动解析) |
| `taskTitle` | string | ✅ | 任务标题 |
| `taskContent` | string | ❌ | 任务描述 (HTML 友好) |
| `taskPriority` | string | ❌ | `urgent`/`highest`/`high`/`medium`/`normal`/`low`/`lowest` |
| `issueTypeUuid` | string | ❌ | 默认 top-level=`UrrXufAy`, 传 `parentTaskUUID` 时自动切换为子任务 `EwSzeaeh` |
| `parentTaskUUID` | string | ❌ | 父任务 UUID (不传 = 创建 top-level 任务) |

### 2.2 调用示例

**创建 top-level 任务**:

```bash
bun packages/cli/dist/bin/roy-bot.js workflow run wiki-task-manager --input '{
  "userName": "alice",
  "password": "secret",
  "action": "create",
  "iterationId": "260702",
  "assignee": "alice",
  "taskTitle": "实现 v1.1 修复",
  "taskContent": "<p>详细描述</p>",
  "taskPriority": "high"
}'
```

**创建子任务**:

```bash
bun packages/cli/dist/bin/roy-bot.js workflow run wiki-task-manager --input '{
  "userName": "alice",
  "password": "secret",
  "action": "create",
  "iterationId": "260702",
  "assignee": "alice",
  "taskTitle": "子任务标题",
  "parentTaskUUID": "TASK-UUID54524A6D"
}'
```

### 2.3 输出

成功创建后 `format-output` 节点输出 (v1.1 已修复空 taskUUID 问题):

```
| Field | Value |
|---|---|
| taskUUID | `TASK-UUID03D78D2D` |
| title | 实现 v1.1 修复 |
| priority | high |
| iteration | 260702 |
| assignee | alice |
| url | https://wiki.example.com/project/#/team/LgsUbAUo/work-item/task/TASK-UUID03D78D2D |
```

---

## 3. action=update 更新任务

### 3.1 inputs

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `taskUUID` | string | ✅ | 目标任务 UUID |
| `newStatus` | string | ❌ | `进行中`/`未开始`/`已完成`/`阻塞中`/`测试中` (中文名 / 英文 alias 都可) |
| `newPriority` | string | ❌ | 同 create 的 priority 值 |
| `newAssignee` | string | ❌ | 新的被指派人 (支持 username 解析) |
| `progressPercent` | string/number | ❌ | 进度百分比 (0-100) |
| `commentText` | string | ❌ | 顺带发的评论 |

### 3.2 调用示例

**更新状态 + 进度**:

```bash
bun packages/cli/dist/bin/roy-bot.js workflow run wiki-task-manager --input '{
  "userName": "alice",
  "password": "secret",
  "action": "update",
  "taskUUID": "TASK-UUID54524A6D",
  "newStatus": "已完成",
  "progressPercent": "100"
}'
```

**更新负责人 + 评论**:

```bash
bun packages/cli/dist/bin/roy-bot.js workflow run wiki-task-manager --input '{
  "userName": "alice",
  "password": "secret",
  "action": "update",
  "taskUUID": "TASK-UUID54524A6D",
  "newAssignee": "bob",
  "commentText": "已转交给 bob 处理"
}'
```

### 3.3 输出

```
## Update summary
- Status transition: applied
- Field update (progress/assignee/priority): applied
- Comment: sent
```

(只显示实际执行的子步骤)

---

## 4. action=query 查询任务

### 4.1 inputs

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `taskUUID` | string | ✅ | 目标任务 UUID |

### 4.2 调用示例

```bash
bun packages/cli/dist/bin/roy-bot.js workflow run wiki-task-manager --input '{
  "userName": "alice",
  "password": "secret",
  "action": "query",
  "taskUUID": "TASK-UUID54524A6D"
}'
```

### 4.3 输出

完整 verbose JSON (含 name / status / progress / priority / assignee / owner / sprint / parent):

```json
{
  "uuid": "TASK-UUID54524A6D",
  "name": "...",
  "status": { "name": "研发完成", "uuid": "..." },
  "progress": 5000000,
  "priority": { "name": "high", "uuid": "JKbHtgBK" },
  "assign": { "name": "...", "uuid": "..." },
  "owner": { "name": "...", "uuid": "..." },
  "sprint": { "name": "...", "uuid": "..." },
  "parent": null
}
```

> **Note**: 暂时不支持 `desc_rich` 字段 (ONES GraphQL schema 限制)。

---

## 5. action=migrate 跨 iteration 迁移任务 (v1.2 新增)

将一个 task 从当前 iteration 移动到另一个 iteration。底层调用 `POST /project/api/project/team/{TEAM}/tasks/update2` 并设置 `sprint_uuid` 字段。

> **原理**: ONES `tasks/add2` 和 `tasks/update2` 的字段 schema 一致，都接受 `sprint_uuid` 字段 ([ONES 官方文档](https://docs.ones.cn/project/open-api-doc/project/task.html))。v1.2 利用 update2 的 sprint_uuid 来实现跨 iteration 迁移。

### 5.1 inputs

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `taskUUID` | string | ✅ | 目标任务 UUID |
| `targetIterationId` | string | ✅ | 目标 iteration UUID (如 `Gf2zafpn` 对应 `260702`) |
| `sourceIterationId` | string | ❌ | 源 iteration UUID (可选, 仅用于 verbose 日志/校验) |

### 5.2 调用示例

```bash
bun packages/cli/dist/bin/roy-bot.js workflow run wiki-task-manager --input '{
  "userName": "alice",
  "password": "secret",
  "action": "migrate",
  "taskUUID": "TASK-UUID12345678",
  "targetIterationId": "Gf2zafpn",
  "sourceIterationId": "5rM9kqLp"
}'
```

**curl 形式 (JSON request body 风格)**:

```bash
curl -X POST http://localhost:3000/workflow/wiki-task-manager/run \
  -H 'Content-Type: application/json' \
  -d '{
    "userName": "alice",
    "password": "secret",
    "action": "migrate",
    "taskUUID": "TASK-UUID12345678",
    "targetIterationId": "Gf2zafpn"
  }'
```

### 5.3 输出

```
# wiki-task-manager v1.2 - action=migrate

| Field | Value |
|---|---|
| taskUUID | `TASK-UUID12345678` |
| sourceIteration | `5rM9kqLp` (260701) |
| targetIteration | `Gf2zafpn` |
| url | https://wiki.example.com/project/#/team/LgsUbAUo/work-item/task/TASK-UUID12345678 |

## Migration summary
- tasks/update2 call: applied (sprint_uuid=`Gf2zafpn`)
```

### 5.4 错误处理

| 错误场景 | workflow 行为 |
|---|---|
| 缺 `taskUUID` | `ERROR: taskUUID required for action=migrate` (exit 1) |
| 缺 `targetIterationId` | `ERROR: targetIterationId required for action=migrate` (exit 1) |
| `taskUUID` 不存在 | ONES 返回 `bad_tasks` 非空，workflow 退出 (exit 1) |
| `targetIterationId` 无效 | ONES 返回 `bad_tasks` 非空，workflow 退出 (exit 1) |
| HTTP 5xx | 自动重试 3 次 (1s → 2s → 4s)，最终失败退出 |

### 5.5 内部机制 (v1.2)

1. **route-action**: 验证 `action=migrate` 合法
2. **lookup-assignee-shared**: skipped (migrate 不需要 assignee)
3. **migrate-handler**:
   - 校验 `taskUUID` + `targetIterationId` 非空
   - **可选**: GraphQL 查询源 task 的 sprint (verbose 日志)
   - 构造 payload `{"tasks": [{"uuid": "...", "sprint_uuid": "..."}]}`
   - `POST /tasks/update2` (with `curl_with_retry`, max 3 attempts)
   - 解析响应: `bad_tasks` 非空则报错；`tasks[0]` 写入 `/tmp/wiki-migrated-to.txt`
4. **format-output**: 渲染 markdown 表格 + URL

### 5.6 不支持的场景

- ❌ 批量迁移多 task 到同一 iteration (单次仅 1 个 task；如需批量请用循环多次调用)
- ❌ 跨项目 migration (sprint_uuid 必须属于同一 project)
- ❌ 异步 / 后台任务 (同步等待响应)

### 5.7 临时文件

| 文件 | 写入者 | 读取者 | 说明 |
|---|---|---|---|
| `/tmp/wiki-migrate-pre.json` | migrate-handler | - | 源 task 的 GraphQL 查询响应 (verbose) |
| `/tmp/wiki-migrate-body.json` | migrate-handler | - | update2 payload |
| `/tmp/wiki-migrate-response.json` | migrate-handler | - | update2 响应 |
| `/tmp/wiki-migrate-source-uuid.txt` | migrate-handler | format-output | 源 sprint UUID |
| `/tmp/wiki-migrate-source-name.txt` | migrate-handler | format-output | 源 sprint 名称 |
| `/tmp/wiki-migrated-to.txt` | migrate-handler | format-output | 目标 sprint UUID |

---

## 6. action=comment 发评论

### 5.1 inputs

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `taskUUID` | string | ✅ | 目标任务 UUID |
| `commentText` | string | ✅ | 评论内容 |

### 5.2 调用示例

```bash
bun packages/cli/dist/bin/roy-bot.js workflow run wiki-task-manager --input '{
  "userName": "alice",
  "password": "secret",
  "action": "comment",
  "taskUUID": "TASK-UUID54524A6D",
  "commentText": "已完成 v1.1 修复，请 review"
}'
```

### 5.3 输出

```
{"code": 200, "errcode": "OK"}
```

---

## 7. 故障排查 FAQ

### Q1: 报 `ERROR: action required (create|update|query|comment|migrate)`
**原因**: `action` input 缺失或为空。  
**解决**: 显式传入 `action` 字段，不要省略。

### Q2: 报 `ERROR: taskUUID required`
**原因**: `action=update/query/comment/migrate` 时未传 `taskUUID`。  
**解决**: 补上 `taskUUID` 字段。

### Q3: 报 `ERROR: iterationId required` / `ERROR: taskTitle required`
**原因**: `action=create` 时缺少必填字段。  
**解决**: 至少传 `iterationId` + `taskTitle` + `assignee`。

### Q4: 报 `ERROR: assignee missing`
**原因**: `assignee` 解析失败 (用户不存在或 lookup 错误)。  
**解决**: 确认用户存在；或直接传 `orgUserUUID`。

### Q5: 报 `ERROR: targetIterationId required for action=migrate`
**原因**: `action=migrate` 时缺少 `targetIterationId`。  
**解决**: 补上 `targetIterationId` 字段 (源 iteration UUID；如不知道可省略 `sourceIterationId`)。

### Q5: format-output 显示 `taskUUID | (空)` (Issue 1, v1.0 旧版本)
**原因**: v1.0 的 format-output 读 `/tmp/wiki-task-uuid.txt`，可能被之前 wiki-create-iteration-task 残留值覆盖。  
**解决**: **升级到 v1.1** — 已改用独立文件 `/tmp/wiki-task-uuid-final.txt`。

### Q6: HTTP 5xx 失败会重试吗？
**答**: 是。`curl_with_retry` 最多 3 次重试，指数退避 (1s → 2s → 4s)。最终失败会输出 HTTP code 和响应 body。

### Q7: GraphQL query 缺 `desc` / `desc_rich` 字段？
**答**: 当前 ONES schema 不支持这 2 个字段，查询时已省略。其他核心字段 (name/status/progress/priority/assign/owner/sprint/parent) 都已覆盖。

### Q8: 状态中文名/英文 alias 都行吗？
**答**: 是。`newStatus` 支持中文 (`进行中`/`未开始`/`已完成`/`阻塞中`/`测试中`) 和英文 alias (`in_progress`/`todo`/`done`/`closed`/`blocked`/`testing`)。

### Q9: 如何知道 workflow 当前版本？
```bash
bun packages/cli/dist/bin/roy-bot.js workflow list --search wiki-task-manager
```
然后查 yaml 头部 `version` 字段或直接 `workflow get`。

### Q10: 同一个 task 多次创建会失败吗？
**答**: 不会。`tasks/add2` 会按生成的 uuid 接受，每次调用生成新 uuid。后续 update/query 都用返回的 taskUUID。

---

## 8. 关联 Workflow 列表

| Workflow | Version | 用途 |
|---|---|---|
| `wiki-task-manager` | v1.2 | 统一入口 (本文档) |
| `wiki-create-iteration-task` | v1.4 | 单独的创建 task (单次调用) |
| `wiki-task-sync` | v1.3 | 单独的更新 task (单次调用) |

**何时用哪个**:
- **一次操作** (如只创建或只更新): `wiki-create-iteration-task` / `wiki-task-sync`
- **跨 iteration 迁移**: `wiki-task-manager` v1.2 `action=migrate`
- **多次操作** (如脚本批量): `wiki-task-manager` 统一入口

---

## 9. 重试 & 错误处理

所有 API 调用都包裹在 `curl_with_retry` 函数中：

```bash
curl_with_retry() {
  local outfile="$1"; shift
  local attempt=1
  local max_attempts=3
  local delay=1
  while [ $attempt -le $max_attempts ]; do
    http_code=$(curl -s -w "%{http_code}" -o "$outfile" "$@" 2>/dev/null)
    if [ "$http_code" = "200" ]; then
      echo "$http_code"
      return 0
    fi
    if [ $attempt -lt $max_attempts ]; then
      sleep $delay
      delay=$((delay * 2))
    fi
    attempt=$((attempt + 1))
  done
  echo "$http_code"
  return 1
}
```

- **最多 3 次重试** (指数退避 1s → 2s → 4s)
- 只对 HTTP 5xx 重试 (4xx 不重试，因客户端错误)
- 失败时输出 HTTP code 到 stdout，调用方据此判断

---

## 10. 临时文件清单

| 文件 | 写入者 | 读取者 | 说明 |
|---|---|---|---|
| `/tmp/wiki-jwt.txt` | get-jwt | 所有 handler | JWT token |
| `/tmp/wiki-real-org-user.txt` | get-jwt | handler | 当前用户的 org_user_uuid |
| `/tmp/wiki-mgr-action.txt` | route-action | handler / format-output | 当前 action |
| `/tmp/wiki-assignee-uuid.txt` | lookup-assignee-shared | create/update handler | 解析后的 assignee UUID |
| `/tmp/wiki-assignee-display.txt` | lookup-assignee-shared | format-output | assignee 显示名 |
| `/tmp/wiki-task-uuid.txt` | create-handler | (其他 workflow 也用) | 兼容旧版 |
| `/tmp/wiki-task-uuid-final.txt` | create-handler | format-output | **v1.1 新增**，避免旧值干扰 |
| `/tmp/wiki-create-response.json` | create-handler | - | tasks/add2 响应 |
| `/tmp/wiki-cur.json` | update-handler | - | 当前状态查询 |
| `/tmp/wiki-transitions.json` | update-handler | - | 状态机 transitions |
| `/tmp/wiki-update-response.json` | update-handler | - | tasks/update2 响应 |
| `/tmp/wiki-msg-response.json` | update/comment handler | - | send_message 响应 |
| `/tmp/wiki-migrate-pre.json` | migrate-handler | - | 源 task 的 GraphQL 查询响应 (verbose) |
| `/tmp/wiki-migrate-body.json` | migrate-handler | - | update2 payload |
| `/tmp/wiki-migrate-response.json` | migrate-handler | - | update2 响应 |
| `/tmp/wiki-migrate-source-uuid.txt` | migrate-handler | format-output | 源 sprint UUID |
| `/tmp/wiki-migrate-source-name.txt` | migrate-handler | format-output | 源 sprint 名称 |
| `/tmp/wiki-migrated-to.txt` | migrate-handler | format-output | 目标 sprint UUID |

---

## 11. 版本变更

### v1.2 (2026-07-23)
- **New**: `action=migrate` 跨 iteration 迁移任务 (8 → 9 节点)
- **New**: `targetIterationId` / `sourceIterationId` inputs
- **API**: 利用 ONES `tasks/update2` 的 `sprint_uuid` 字段实现 (与 `tasks/add2` schema 一致)
- **Docs**: 第 5 节新增 migrate 章节；故障排查 FAQ 增 Q5

### v1.1 (2026-07-23)
- **Fix**: Issue 1 — `format-output` 现在读取 `/tmp/wiki-task-uuid-final.txt` (workflow 专用文件)，不再受旧值干扰
- **Docs**: 新增本用户指南

### v1.0 (2026-07-23)
- 初始版本：集成 create / update / query / comment 4 个 action
- 共享 `get-jwt` + `lookup-assignee-shared` + `curl_with_retry`

---

**维护者**: dev-author &lt;dev@example.com&gt;
**最后更新**: 2026-07-23 (v1.2 发布)