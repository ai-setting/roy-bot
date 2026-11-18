/**
 * @fileoverview Sessions Command Entry
 * 
 * 命令入口：roy-bot sessions [action]
 * 
 * 注意：--quiet / -q 选项现在由 cli.ts 的全局 middleware 统一处理
 */

import { CommandModule } from "yargs";
import { ListCommand } from "./list";
import { GetCommand } from "./get";
import { NewCommand } from "./new";
import { RenameCommand } from "./rename";
import { DeleteCommand } from "./delete";
import { MessagesCommand } from "./messages";
import { CompactCommand } from "./compact";
import { CheckpointsCommand } from "./checkpoints";
import { AdaptCheckpointsCommand } from "./adapt-checkpoints";
import { ActiveCommand } from "./active";
import { AddMessageCommand } from "./add-message";
import { MockCommand } from "./mock";
import { GrepCommand } from "./grep";

/**
 * Sessions Command
 * 
 * 会话管理命令，提供以下子命令：
 * - list: 列出所有会话
 * - get: 获取会话详情
 * - new: 创建新会话
 * - rename: 更新会话标题
 * - delete: 删除会话（支持批量删除、全量删除、按时间删除）
 * - messages: 查看消息
 * - grep: 全文搜索消息
 * - compact: 压缩会话 (new)
 * - checkpoints: 查看检查点 (new)
 * - active: 活跃会话管理
 * - add-message: 添加单条消息
 * - mock: 插入模拟消息（用于测试）
 * 
 * 删除命令使用示例：
 *   roy-bot sessions delete <id>                    # 删除单个会话
 *   roy-bot sessions delete <id1> <id2> <id3>       # 批量删除
 *   roy-bot sessions delete --all                    # 删除所有会话
 *   roy-bot sessions delete --all --keep-active     # 删除所有非活跃会话
 *   roy-bot sessions delete --older-than 30          # 删除30天前的会话
 *   roy-bot sessions delete --dry-run               # 预览模式
 * 
 * 搜索命令使用示例：
 *   roy-bot sessions grep K8s deployment error       # 多关键字搜索
 *   roy-bot sessions grep "exact phrase"            # 精确短语
 *   roy-bot sessions grep --session <id> query      # 搜索指定会话
 *   roy-bot sessions grep --limit 10 query         # 限制结果数
 *   roy-bot sessions grep --json query              # JSON 输出
 */
export const SessionsCommand: CommandModule = {
  command: "sessions",
  describe: `会话管理 - 列出、创建、删除和管理会话
  
删除命令使用示例：
  roy-bot sessions delete <id>                    # 删除单个会话
  roy-bot sessions delete <id1> <id2> <id3>       # 批量删除
  roy-bot sessions delete --all                   # 删除所有会话
  roy-bot sessions delete --all --keep-active     # 删除所有非活跃会话
  roy-bot sessions delete --older-than 30         # 删除30天前的会话
  roy-bot sessions delete --dry-run               # 预览模式

搜索命令使用示例：
  roy-bot sessions grep K8s deployment error       # 多关键字搜索
  roy-bot sessions grep "exact phrase"            # 精确短语
  roy-bot sessions grep --session <id> query      # 搜索指定会话
  roy-bot sessions grep --limit 10 query          # 限制结果数
  roy-bot sessions grep --json query              # JSON 输出`,
  builder: (yargs) => {
    // 注意：--quiet / -q 选项现在由 cli.ts 的全局 middleware 统一处理
    return yargs
      .command(ListCommand)
      .command(GetCommand)
      .command(NewCommand)
      .command(RenameCommand)
      .command(DeleteCommand)
      .command(MessagesCommand)
      .command(GrepCommand)
      .command(CompactCommand)
      .command(CheckpointsCommand)
      .command(AdaptCheckpointsCommand)
      .command(ActiveCommand)
      .command(AddMessageCommand)
      .command(MockCommand)
      .demandCommand()
      .help();
  },
  handler: () => {
    // Default handler - shouldn't be reached if demandCommand is true
    console.log("Use 'roy-bot sessions --help' for usage information");
  },
};
