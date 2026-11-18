# MCP Component 集成指南

## 概述

McpComponent 是 roy-bot 的 MCP 客户端管理组件，支持：
- 本地 MCP 服务器（stdio 传输）
- 远程 MCP 服务器（HTTP 传输）
- 多路径扫描（类似 SkillComponent）
- 与 ToolComponent 无缝集成

## 快速开始

### 1. 导入 McpComponent

```typescript
import { McpComponent } from "./mcp";
```

### 2. 注册到 Environment

在具体的 Environment 子类中覆盖 `registerDefaultComponents()` 方法：

```typescript
import { McpComponent } from "./mcp";
import type { ConfigComponent } from "../../config/config-component";

export class MyEnvironment extends BaseEnvironment {
  protected registerDefaultComponents(): void {
    // 注册 ConfigComponent（如果尚未注册）
    const configComponent = this.getComponent<ConfigComponent>("config");
    if (!configComponent) {
      this.registerComponent(new ConfigComponent());
    }

    // 注册 ToolComponent（如果尚未注册）
    const toolComponent = this.getComponent<ToolComponent>("tool");
    if (!toolComponent) {
      this.registerComponent(new ToolComponent());
    }

    // 注册 McpComponent
    const mcpComponent = new McpComponent();
    this.registerComponent(mcpComponent);
  }
}
```

### 3. 配置 McpComponent

通过 ConfigComponent 配置：

```typescript
// 在初始化时传入配置
mcpComponent.init({
  options: {
    configComponent: myConfigComponent,
    config: {
      enabled: true,
      mcpPaths: [
        { type: "user", path: "~/.config/roy-bot/mcp" },
        { type: "project", path: ".roy/mcp" },
      ],
      timeout: 30000,
    },
  },
});
```

### 4. 启动顺序

组件启动顺序很重要：

```typescript
async start(): Promise<void> {
  await super.start();
  
  // 1. 先启动 ToolComponent
  const toolComponent = this.getComponent<ToolComponent>("tool");
  await toolComponent?.start();
  
  // 2. 再启动 McpComponent（McpComponent 需要 ToolComponent 来注册 tools）
  const mcpComponent = this.getComponent<McpComponent>("mcp");
  await mcpComponent?.start();
}
```

## 配置方式

### 方式 1: 代码配置

```typescript
mcpComponent.init({
  options: {
    configComponent,
    config: {
      mcpPaths: [
        { type: "user", path: "~/.config/roy-bot/mcp" },
      ],
      servers: {
        "my-server": {
          type: "local",
          command: ["bun", "run", "/path/to/server.ts"],
        },
      },
    },
  },
});
```

### 方式 2: 环境变量

```bash
export MCP_ENABLED=true
export MCP_TIMEOUT=60000
```

### 方式 3: 配置文件

在配置文件中添加：

```json
{
  "mcp": {
    "enabled": true,
    "timeout": 30000,
    "mcpPaths": [
      { "type": "user", "path": "~/.config/roy-bot/mcp" }
    ]
  }
}
```

## MCP 服务器发现

McpComponent 会扫描配置的路径，查找子目录作为 MCP 服务器：

```
~/.config/roy-bot/mcp/
├── filesystem-mcp/
│   ├── server.ts
│   └── config.jsonc
├── memory-mcp/
│   └── server.mjs
```

### config.jsonc 格式

```jsonc
{
  "enabled": true,
  "command": ["bun", "run", "server.ts"],
  "timeout": 60000,
  "environment": {
    "NODE_ENV": "production"
  }
}
```

## 远程 MCP 服务器

可以通过显式配置添加远程 MCP 服务器：

```typescript
mcpComponent.init({
  options: {
    configComponent,
    config: {
      servers: {
        "remote-api": {
          type: "remote",
          url: "https://mcp.example.com",
          headers: {
            "Authorization": "Bearer token"
          }
        }
      }
    }
  }
});
```

## 公共 API

### 获取服务器状态

```typescript
const status = mcpComponent.getServerStatus("my-server");
console.log(status?.status); // "connected" | "error" | "disconnected"
```

### 列出所有服务器

```typescript
const servers = mcpComponent.listServers();
servers.forEach(s => {
  console.log(`${s.name}: ${s.status} (${s.toolsCount} tools)`);
});
```

### 列出所有 MCP 工具

```typescript
const tools = mcpComponent.listTools();
tools.forEach(t => {
  console.log(`- ${t.name}: ${t.description}`);
});
```

### 重新加载

```typescript
await mcpComponent.reload();
```

## 工具命名

MCP 工具会被注册为 `mcp_{serverName}_{toolName}` 格式：

| MCP Server | MCP Tool | 注册名 |
|------------|----------|--------|
| filesystem-mcp | read_file | mcp_filesystem-mcp_read_file |
| memory | search | mcp_memory_search |

## 错误处理

单个 MCP 服务器的连接失败不会影响其他服务器：

```typescript
// 服务器状态会记录错误
const status = mcpComponent.getServerStatus("failed-server");
if (status?.status === "error") {
  console.log(`Error: ${status.error}`);
}
```

## 类型定义

```typescript
import type {
  McpComponentConfig,
  McpServerConfig,
  McpServerStatus,
} from "./mcp";
```
