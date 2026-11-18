/**
 * @fileoverview Seed script to populate session with AI SDK v6 compatible messages
 * 
 * Creates a complete conversation flow with:
 * - user query
 * - assistant thinking + tool call
 * - tool call result
 * - assistant response text
 */

import { SQLiteSessionStore } from "../packages/core/src/env/session/storage/sqlite";
import { randomUUID } from "crypto";
import { join } from "path";

async function seedSession() {
  console.log("🔧 Seeding session with AI SDK v6 message format...\n");

  // Use a test database path
  const dbPath = join("/tmp", `test-seed-${Date.now()}.db`);
  const store = new SQLiteSessionStore(dbPath);

  try {
    // 1. Create a session
    const session = await store.create({ 
      title: "Test Session - AI SDK v6 Format Demo"
    });
    console.log(`✅ Created session: ${session.id}`);
    console.log(`   Title: ${session.title}\n`);

    // 2. User message
    const userMsgId = await store.addMessage(session.id, {
      role: "user",
      content: "帮我搜索一下代码中的 TODO 注释，并统计数量",
      parts: [
        { type: "text", content: "帮我搜索一下代码中的 TODO 注释，并统计数量" }
      ]
    });
    console.log(`✅ Added user message: ${userMsgId}`);

    // 3. Assistant message with reasoning + tool call
    const assistant1MsgId = await store.addMessage(session.id, {
      role: "assistant",
      content: "我来帮你搜索 TODO 注释",
      parts: [
        { 
          type: "reasoning", 
          content: "用户想要搜索代码中的 TODO 注释并统计数量。我应该使用 grep 工具来搜索 'TODO' 关键字，这可以快速找到所有标记为 TODO 的代码位置。",
          reasoningType: "core",
          state: "completed",
          metadata: {
            tokenCount: 85,
            time: { start: Date.now() - 1000, end: Date.now() }
          }
        },
        { 
          type: "text", 
          content: "我来帮你搜索 TODO 注释" 
        },
        { 
          type: "tool-call",
          toolCallId: "call_" + randomUUID().slice(0, 8),
          toolName: "grep",
          arguments: { 
            pattern: "TODO", 
            path: "/src",
            recursive: true,
            ignoreCase: true
          },
          state: "pending"
        }
      ]
    });
    console.log(`✅ Added assistant message with reasoning + tool call: ${assistant1MsgId}`);

    // 4. Tool result message
    const toolMsgId = await store.addMessage(session.id, {
      role: "tool",
      content: "找到 5 处 TODO:\n1. src/index.ts:15 - TODO: 实现用户登录功能\n2. src/auth.ts:42 - TODO: 添加 token 刷新逻辑\n3. src/utils.ts:8 - TODO: 优化性能\n4. src/api.ts:100 - TODO: 处理错误边界\n5. src/db.ts:55 - TODO: 添加索引",
      parts: [
        { 
          type: "tool-result",
          toolCallId: "call_" + randomUUID().slice(0, 8),
          toolName: "grep",
          output: "找到 5 处 TODO:\n1. src/index.ts:15 - TODO: 实现用户登录功能\n2. src/auth.ts:42 - TODO: 添加 token 刷新逻辑\n3. src/utils.ts:8 - TODO: 优化性能\n4. src/api.ts:100 - TODO: 处理错误边界\n5. src/db.ts:55 - TODO: 添加索引",
          state: "completed"
        }
      ]
    });
    console.log(`✅ Added tool result message: ${toolMsgId}`);

    // 5. Assistant final response
    const assistant2MsgId = await store.addMessage(session.id, {
      role: "assistant",
      content: "代码中共找到 **5 处 TODO 注释**：\n\n1. **src/index.ts:15** - 实现用户登录功能\n2. **src/auth.ts:42** - 添加 token 刷新逻辑\n3. **src/utils.ts:8** - 优化性能\n4. **src/api.ts:100** - 处理错误边界\n5. **src/db.ts:55** - 添加索引\n\n建议按优先级处理这些待办事项。",
      parts: [
        { 
          type: "reasoning",
          content: "根据 grep 结果，我找到了 5 处 TODO。让我整理成清晰的列表格式，方便用户查看和处理。",
          reasoningType: "core",
          state: "completed"
        },
        { type: "text", content: "代码中共找到 **5 处 TODO 注释**：" },
        { type: "text", content: "1. **src/index.ts:15** - 实现用户登录功能" },
        { type: "text", content: "2. **src/auth.ts:42** - 添加 token 刷新逻辑" },
        { type: "text", content: "3. **src/utils.ts:8** - 优化性能" },
        { type: "text", content: "4. **src/api.ts:100** - 处理错误边界" },
        { type: "text", content: "5. **src/db.ts:55** - 添加索引" },
        { type: "text", content: "\n建议按优先级处理这些待办事项。" }
      ]
    });
    console.log(`✅ Added assistant final response: ${assistant2MsgId}`);

    // 6. Another user query
    const userMsg2Id = await store.addMessage(session.id, {
      role: "user",
      content: "好的，那帮我看看 src/auth.ts 中的 TODO 具体内容是什么？",
      parts: [
        { type: "text", content: "好的，那帮我看看 src/auth.ts 中的 TODO 具体内容是什么？" }
      ]
    });
    console.log(`✅ Added second user message: ${userMsg2Id}`);

    // 7. Assistant with another tool call
    const assistant3MsgId = await store.addMessage(session.id, {
      role: "assistant",
      content: "让我查看一下 auth.ts 文件的内容",
      parts: [
        { 
          type: "reasoning",
          content: "用户想要查看 auth.ts 文件的具体内容，特别是 TODO 注释的上下文。我需要读取该文件来获取完整信息。",
          reasoningType: "core",
          state: "completed"
        },
        { type: "text", content: "让我查看一下 auth.ts 文件的内容" },
        {
          type: "tool-call",
          toolCallId: "call_" + randomUUID().slice(0, 8),
          toolName: "readFile",
          arguments: {
            path: "src/auth.ts",
            startLine: 35,
            endLine: 50
          },
          state: "pending"
        }
      ]
    });
    console.log(`✅ Added assistant message with read tool call: ${assistant3MsgId}`);

    // 8. Tool result with file content
    const toolMsg2Id = await store.addMessage(session.id, {
      role: "tool",
      content: `// src/auth.ts (lines 35-50)

// TODO: 添加 token 刷新逻辑
// 当前问题：access_token 过期后需要用户重新登录
// 建议方案：在 access_token 过期前自动调用 refresh_token 接口
// 实现难度：中等
async function refreshToken() {
  const refreshToken = getRefreshTokenFromCookie();
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }
  
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  });
  
  if (!response.ok) {
    throw new Error('Token refresh failed');
  }
  
  return response.json();
}`,
      parts: [
        {
          type: "tool-result",
          toolCallId: "call_" + randomUUID().slice(0, 8),
          toolName: "readFile",
          output: `// src/auth.ts (lines 35-50)\n\n// TODO: 添加 token 刷新逻辑\n// 当前问题：access_token 过期后需要用户重新登录\n// 建议方案：在 access_token 过期前自动调用 refresh_token 接口\n// 实现难度：中等\nasync function refreshToken() {\n  const refreshToken = getRefreshTokenFromCookie();\n  if (!refreshToken) {\n    throw new Error('No refresh token available');\n  }\n  \n  const response = await fetch('/api/auth/refresh', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ refreshToken })\n  });\n  \n  if (!response.ok) {\n    throw new Error('Token refresh failed');\n  }\n  \n  return response.json();\n}`,
          state: "completed"
        }
      ]
    });
    console.log(`✅ Added tool result with file content: ${toolMsg2Id}`);

    // 9. Final assistant response
    const assistant4MsgId = await store.addMessage(session.id, {
      role: "assistant",
      content: `在 **src/auth.ts** 的第 42 行找到了这个 TODO：

\`\`\`
// TODO: 添加 token 刷新逻辑
// 当前问题：access_token 过期后需要用户重新登录
// 建议方案：在 access_token 过期前自动调用 refresh_token 接口
// 实现难度：中等
\`\`\`

**分析：**
- 这个 TODO 是关于实现自动刷新 token 的功能
- 需要在 access_token 过期前主动刷新
- 建议添加一个定时检查机制

**建议的实现方式：**
1. 在登录时记录 token 的过期时间
2. 设置一个提前量（如过期前 5 分钟）
3. 启动一个定时器自动刷新 token

需要我帮你实现这个功能吗？`,
      parts: [
        { type: "text", content: "在 **src/auth.ts** 的第 42 行找到了这个 TODO：" },
        { 
          type: "file",
          mime: "text/plain",
          url: "file:///src/auth.ts",
          filename: "auth.ts"
        },
        { type: "text", content: "\n**分析：**" },
        { type: "text", content: "- 这个 TODO 是关于实现自动刷新 token 的功能" },
        { type: "text", content: "- 需要在 access_token 过期前主动刷新" },
        { type: "text", content: "- 建议添加一个定时检查机制" },
        { type: "text", content: "\n**建议的实现方式：**" },
        { type: "text", content: "1. 在登录时记录 token 的过期时间" },
        { type: "text", content: "2. 设置一个提前量（如过期前 5 分钟）" },
        { type: "text", content: "3. 启动一个定时器自动刷新 token" },
        { type: "text", content: "\n需要我帮你实现这个功能吗？" }
      ]
    });
    console.log(`✅ Added final assistant response: ${assistant4MsgId}`);

    // Retrieve and display all messages
    console.log("\n" + "=".repeat(70));
    console.log("📋 All messages in session:");
    console.log("=".repeat(70));

    const messages = await store.getMessages(session.id);
    
    for (const msg of messages) {
      console.log(`\n[${msg.role.toUpperCase()}] ${msg.id}`);
      console.log("-".repeat(50));
      
      if (msg.parts && msg.parts.length > 0) {
        for (const part of msg.parts as any[]) {
          switch (part.type) {
            case "text":
              console.log(`  📝 Text: ${part.content.slice(0, 100)}${part.content.length > 100 ? "..." : ""}`);
              break;
            case "reasoning":
              console.log(`  🧠 Reasoning (${part.reasoningType || "default"}): ${part.content.slice(0, 80)}...`);
              break;
            case "tool-call":
              console.log(`  🔧 Tool Call: ${part.toolName}(${JSON.stringify(part.arguments).slice(0, 50)}...)`);
              break;
            case "tool-result":
              console.log(`  ✅ Tool Result: ${part.output.slice(0, 80)}...`);
              break;
            case "file":
              console.log(`  📎 File: ${part.filename || part.url}`);
              break;
            case "checkpoint":
              console.log(`  📍 Checkpoint: ${part.title || part.checkpointId}`);
              break;
          }
        }
      } else {
        console.log(`  ${msg.content.slice(0, 100)}${msg.content.length > 100 ? "..." : ""}`);
      }
    }

    console.log("\n" + "=".repeat(70));
    console.log(`✅ Total messages: ${messages.length}`);
    console.log(`✅ Database path: ${dbPath}`);
    console.log("=".repeat(70));

  } finally {
    await store.close();
  }
}

seedSession().catch(console.error);
