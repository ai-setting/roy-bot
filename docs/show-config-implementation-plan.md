# config 命令实现计划

> **⚠️ 已废弃**: 此文档描述的 `show-config` 命令已被重构为 `config` 子命令结构。
> 
> 请参阅 [show-config-command-design.md](./show-config-command-design.md) 获取最新的设计文档。

---

## 历史背景

### 旧设计 (show-config)

```
roy show-config [component] [options]
```

- 单命令结构，通过参数指定 Component
- 分散的 Component 渲染器
- 不支持导出/导入

### 新设计 (config)

```
roy config
├── list      # 查看配置
├── export    # 导出配置
└── import    # 导入配置
```

- 子命令结构，职责分离
- ConfigService 统一处理
- 完整支持导出/导入

---

## 迁移说明

### 命令对照表

| 旧命令 | 新命令 |
|--------|--------|
| `roy show-config` | `roy config list` |
| `roy show-config tool` | `roy config list tool` |
| `roy show-config all` | `roy config list all` |
| `roy show-config --json` | `roy config list --json` |

### 目录变更

| 旧目录 | 新目录 |
|--------|--------|
| `packages/cli/src/commands/show-config/` | `packages/cli/src/commands/config/` |
| `show-config/component-renderers/` | (已删除，合并到 ConfigService) |
| `show-config/config-renderer.ts` | `config/config-service.ts` |
| `show-config/formatters.ts` | (合并到 OutputService) |

### 新增文件

```
packages/cli/src/commands/config/
├── index.ts                  # 主命令入口
├── list.ts                  # list 子命令
├── export.ts                # export 子命令
├── import.ts                # import 子命令
├── config-service.ts         # 配置服务
├── config-service.test.ts   # 配置服务测试
├── deep-merge.ts             # 深度合并工具
├── deep-merge.test.ts      # 深度合并测试
└── types.ts                 # 类型定义
```

---

## 实现状态

### ✅ 已完成

- [x] 创建 `config` 子命令结构
- [x] 实现 `config list` 子命令
- [x] 实现 `config export` 子命令
- [x] 实现 `config import` 子命令
- [x] 实现 `ConfigService` 配置服务
- [x] 实现 `deep-merge` 深度合并工具
- [x] 添加单元测试 (21 个测试全部通过)
- [x] 删除旧的 `show-config` 目录
- [x] 添加 `session`/`sessions` 别名支持
- [x] 统一静态默认配置到 ConfigComponent

### ⏳ 待完成

- [ ] 代码审查
- [ ] 合并到 main 分支

---

## 相关文档

- [show-config-command-design.md](./show-config-command-design.md) - 新设计文档
- [config-component-design.md](./config-component-design.md) - ConfigComponent 详细设计
- [component-decentralized-config-design.md](./component-decentralized-config-design.md) - 去中心化配置注册机制
