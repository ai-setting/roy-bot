---
name: lark-collaboration
description: Use when asked to collaborate with another person's Roy/飞书 agent (trigger phrases 协作 / 一起搞 / 找 @某人 的智能体 / cross-agent teamwork). Creates a Feishu group containing both the humans and both agents' bots, then communicates inside that group by @-mentioning the other agent. Covers the lark-cli commands that actually work (--as user + --bots), the naming convention that maps 企微 user name → bot name prefix, and the self-echo trap that silently drops bot→bot messages.
---

# 飞书多智能体协作（Lark multi-agent collaboration）

**目标**：让「我（Roy A）」和「别人的 Roy（Roy B）」在飞书里真正对话。
飞书 **不允许 bot 私聊 bot**，所以必须**建一个群**把两个 bot 都拉进去，
然后在群里**用 @ 的方式**说话。

**Announce at start**：「我用 lark-collaboration skill 建协作群 + @ 对方智能体。」

---

## 0. 铁律（读完再动手）

| # | 规矩 | 为什么 |
|---|---|---|
| 1 | 建群必须 `--as user`，**不能** `--as bot` | bot 身份邀请「别的 app 的 bot」会被飞书拒：`230003 Bot is not allowed to be invited by other app`（已实测） |
| 2 | `--bots` 要把**自己 + 对方**的 app_id 都写上 | 只写对方 ⇒ 自己的 bot 不在群里，后面发消息报 `230002 Bot/User can NOT be out of the chat`（#5425 同源坑） |
| 3 | 交流必须用**结构化 at 参数**（`{"tag":"at","user_id":"ou_xxx"}`），**不是**正文里打 `@名字` | 飞书只认结构化 at 节点才回填 `mentions`；正文 `@` 只是普通文字，对方收不到、也不触发 |
| 4 | 群名带**企微群名或群 Id** 做标记 | 方便人和 agent 双向定位「这个飞书群对应哪个企微群」 |
| 5 | bot 名字前缀 = 企微用户名 | 唯一的「用户 ↔ 智能体」匹配依据（见 §2） |
| 6 | 建群后**必须回读成员列表验证** | 静默少人（bot 未入群 / 用户不可见）会让整条协作链路在几小时后才暴露 |
| 7 | 回复对方前**必须先判断是否需要回**，绝不能无条件回，且不得回给「上一条是我发的」 | 群聊里 bot 消息现在会放行（#5459）。若 A、B 都无条件回复对方，就形成 ping-pong 无限刷屏 —— 门禁只保证「不自吞」，**挡不住两个 agent 互相热情** |

---

## 1. 五步流程

### Step 1 — 确认「对方是谁」（企微用户名 → 飞书用户 + bot）

```bash
# 1a. 用 open_id 查用户（+get-user，实测可用）
lark-cli --profile <本机profile> contact +get-user \
  --user-id <对方open_id> --as user

# 1b. 在**已存在的群**里读 bot 列表，按名字前缀匹配（实测可用）
lark-cli --profile <本机profile> im chat.members bots \
  --chat-id <某个你们都已在的群> --as user
# → data.items[].bot_name / bot_id（bot_id 就是 bot 的 open_id）
```

> ⚠️ **全局搜用户 / 搜 bot 有权限门槛（实测）**：
> - `contact +search-user` 需要 scope `contact:user:search`
> - `contact +search-bot` 需要 scope `search:bot`
>
> 当前常用 profile **都没授这两个 scope**，直接调会返回
> `missing required scope(s)`。所以**默认走「群成员反查」**：
> 只要你和对方同在某群，`im chat.members bots` 就能拿到全部 bot 的
> `bot_name + open_id`，按 `bot_name.startsWith(<企微用户名>)` 匹配即可。
>
> 真要开通搜人能力：
> ```bash
> lark-cli auth login --profile=<p> --scope "contact:user:search,search:bot" --no-wait --json
> # 把 verification_url 给用户确认，再 --device-code <code> 完成
> ```

### Step 2 — 建群（一次命令拉齐人 + 两个 bot）

```bash
# 自己的 app_id（本机 profile 对应）
MY_APP_ID=$(lark-cli --profile <本机profile> auth status --json | jq -r .appId)

lark-cli --profile <本机profile> im +chat-create \
  --as user \
  --name "协作-<企微群名或企微群Id>-<YYYYMMDD>" \
  --description "企微群:<企微群名或群Id> | 多智能体协作" \
  --users "<对方用户open_id>,<我方用户open_id>" \
  --bots "$MY_APP_ID,<对方bot的app_id>"
```

实测成功的输出（`--as user` + 2 个 bot）：

```json
{ "ok": true, "identity": "user",
  "data": { "chat_id": "oc_xxxxxxxxxxxxxxxx",
            "name": "协作群B-企微175355", "chat_type": "private" } }
```

**取 chat_id**：`jq -r '.data.chat_id'`。

### Step 3 — 回读成员，确认真的拉齐了（关键验证步）

```bash
lark-cli --profile <本机profile> im +chat-members-list --chat-id <chat_id> --as user
# 看 users[] 有几个人、bots[] 有几个 bot（含 app_id）
```

实测通过的样子：

```
users: ['开发者本人']
bots: [('开发者本人-通助理（飞书小号）', 'cli_aXXXXXXXXXXXXXX'),
       ('通助理', 'cli_aXXXXXXXXXXXXXX')]
```

**少人就按 §4 补，不要继续往下走**。

### Step 4 — 在群里 @ 对方智能体说话（结构化 at，不是正文 @）

```bash
body_file="$(mktemp /tmp/collab.XXXX.md)"
cat > "$body_file" <<'EOF'
协作请求：<要对方做什么>
EOF

# ★ 关键：at 是**参数节点**，正文只放 md
content="$(jq -nc --rawfile md "$body_file" \
  --arg uid "<对方bot的 open_id，ou_xxx>" \
  '{zh_cn:{content:[[{tag:"at",user_id:$uid}],[{tag:"md",text:$md}]]}}')"

lark-cli --profile <本机profile> im +messages-send \
  --chat-id <chat_id> --as bot --msg-type post --content "$content"
```

- `user_id` 填**对方 bot 的 open_id**（`ou_xxx`）。
  从 Step 3 的 `bots[].member_id` 拿（那就是 bot 的 open_id），
  或 `im chat.members bots --chat-id <chat_id>` 查。
- **不要**写成 `at user_id="ou_xxx"` 的文本标签，飞书不识别。

### Step 5 — 收对方消息（正常情况下自动到达，但要确认门禁没拦）

对方 bot @ 我之后，我方 consumer 会收到 `chat_type=group` + `sender_type=app/bot`
的事件。**Task #5459 之后这类事件会放行**（`reason=group-bot-message`）。

自查（历史 bug 就在这里被发现的）：

```bash
grep "self-echo event dropped" ~/.local/share/roy-bot/logs/app.log | tail -5
```

- 看到 `reason=group-bot-message` ⇒ 正常（放行，不会出现在 dropped 日志里）
- 看到 `reason=bot-sender` + `chatKind=group` ⇒ **门禁又误杀了**，见 §5
- 看到 `reason=self-bot-id` ⇒ 是我方自己发的，正常拦截

---

## 2. 命名规范（用户 ↔ 智能体匹配的唯一依据）

```
飞书用户名           = 企微用户名            （用于找人）
飞书智能体（bot）名   = <企微用户名> + 自由后缀  （用于找 agent）
```

实测样例：

| 企微/飞书用户 | 该用户的智能体（bot 名） | 前缀匹配 |
|---|---|---|
| 开发者本人 | `开发者本人-通助理（飞书小号）` | ✅ `开发者本人` |
| 开发者本人 | `通助理` | ❌ 无前缀（主号命名，不能靠它匹配） |

**所以**：
- 找 agent 时按 `name.startsWith(<对方用户名>)` 过滤 `bots[]`
- 匹配到 0 个 → 别猜，直接问用户要 bot app_id
- 匹配到多个 → 让用户选（列出 `name + app_id`）

---

## 3. 触发条件（什么时候用这个 skill）

命中任一即用：

- 企微/飞书里被 @ 且提到 **「协作」/「一起搞」/「找 @某人的智能体」/「跟他的 agent 对接」**
- 需要**跨人**的多智能体配合（我做一半、对方 agent 做另一半）
- 用户明确说「建个群把我俩的智能体拉进来」

不适用：

- 只是让**自己的**另一个 sub-session 干活（用 delegate，不要建群）
- 单向通知某人（直接 `+messages-send`，不用建群）

---

## 4. 降级路径（拉不到 bot / 拉不到人时）

| 症状 | 原因 | 处理 |
|---|---|---|
| `230003 Bot is not allowed to be invited by other app` | 用了 `--as bot` | 改 `--as user` 重试 |
| `230002 Bot/User can NOT be out of the chat` | 自己的 bot 不在群里 | 用 `--as user` + `im chat.members create` 把**自己**的 app_id 补进去 |
| 用户不在群里（`users[]` 少人） | 该用户对 bot 不可见 | `im chat.members create --as user --member-id-type open_id --succeed-type 1 --data '{"id_list":["ou_x"]}'` |
| 对方 bot 的 app_id 不知道 | 无法全局搜 bot（缺 `search:bot` scope） | ① 在共同群 `im chat.members bots` 读 `bot_name` 前缀匹配；② 仍拿不到就让用户把对方 agent 拉进群，再读一次 |

补 bot 入群的命令（实测有效）：

```bash
lark-cli --profile <本机profile> im chat.members create \
  --chat-id <chat_id> --member-id-type app_id --succeed-type 1 \
  --data '{"id_list":["cli_xxx"]}' --as user
```

---

## 5. 已知坑（踩过，别再踩）

0. **⚠️ ping-pong 无限回灌（最需要小心的一条）**
   门禁只保证「自己发的东西不会喂回自己」（`senderId ∈ selfBotIds`）。
   但**群聊里别的 bot 的消息会放行**（那是协作入站，必须处理）。于是：
   若 A、B 都对「对方 bot 的消息」无条件回复 → 无限来回。

   **做法**：
   - 回对方之前先判断「这条**需要我回**吗？」—— 只是知会/确认类，不用回
   - **绝不**回复「上一条发送者是我自己」的对话轮（已经是对方在回我，该收尾）
   - 一次协作目标明确说清「我要什么」，对方回复后**主动结束**，不要客套
   - 自查信号：若发现自己在同一个群里已连续发 > 3 条，立刻停下核对
   - 运维侧：`eventHandler.getSelfEchoAllowedGroupBotCount()` 短时间暴涨
     = 两个 agent 在互相热情，需要人工介入

1. **`--as bot` 建群会漏自己**：创建者 bot 默认不在群里 → 发卡/发消息 `230002`。（#5425）
2. **bot 拉 bot 必失败**：`230003`，只能 `--as user`。
3. **正文 `@名字` 无效**：必须是结构化 at 节点，否则对方收不到。
4. **self-echo 门禁误杀**（#5459 已修）：群聊里别的 bot 的消息曾按
   `senderType ∈ {bot,app}` 一刀切丢弃 → 协作消息永远进不来。
   修好后群聊 bot 消息放行；**自己**发的仍按 `selfBotIds` 拦截（防自循环）。
   ⇒ 如果你的 profile 身份解析失败（`selfBotIds=[]`），群聊会出现自回灌，
   检查 `~/.lark-cli/config.json` 是否有该 profile 的 `appId`。
5. **群名 ≤ 60 字符 / 描述 ≤ 100 字符**：超了 lark-cli 直接报错（#3974）。
6. **`--users` 最多 50 个，`--bots` 最多 5 个**。
7. **⚠️ 平台层限制：bot→bot 消息默认不推送**（#5466 实测）。
   飞书 `im.message.receive_v1` **不把「其他机器人发的消息」推给 bot**，
   即使对方在群里、即使结构化 at 命中。实测证据：同一 50s 窗口内，
   用户身份 @ 目标 bot → 入站 1 条；A bot @ 目标 bot → 入站 0 条；
   事件库最近 300 条事件里 `sender_type=bot/app` 计数恒为 0。
   ⇒ 要真正双向协作，应用必须申请并获批 scope：
   `im:message.group_at_msg.include_bot:readonly`（或 `im:message.group_msg.include_bot:read`），
   在开发者后台（开放平台 → 权限管理）添加并**发布版本**后才生效。
   ⇒ **不要**把这种情况误判成本项目 self-echo 门禁 bug（门禁 37/37 全绿）；
   排查顺序：先看事件库有没有 bot 发送者事件（`sender_type=bot/app`），
   恒 0 ⇒ 平台没推，与你自己的过滤逻辑无关。

---

## 6. 清单（收尾前逐条打勾）

- [ ] 群名带企微群名/群Id 标记
- [ ] `--as user` 建群（不是 `--as bot`）
- [ ] `--bots` 含**自己 + 对方** app_id
- [ ] 回读 `+chat-members-list`：用户齐、两个 bot 都在
- [ ] 首条消息用结构化 at 节点 @ 对方 bot 的 open_id
- [ ] 日志里没有 `reason=bot-sender` + `chatKind=group` 的误杀
