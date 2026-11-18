/**
 * @fileoverview EventSource Command
 *
 * 事件源管理命令入口
 */

import { CommandModule } from "yargs";
import { EventSourceListCommand } from "./list";
import { EventSourceAddCommand } from "./add";
import { EventSourceUpdateCommand } from "./update";
import { EventSourceRemoveCommand } from "./remove";
import { EventSourceStartCommand } from "./start";
import { EventSourceStopCommand } from "./stop";
import { EventSourceStatusCommand } from "./status";

/**
 * EventSource Command
 *
 * 事件源管理命令
 */
export const EventSourceCommand: CommandModule = {
  command: "eventsource",
  aliases: ["es", "event-source"],
  describe: "事件源管理 - 添加、启动、停止各种事件源（lark-cli、timer、websocket）",

  builder: (yargs) =>
    yargs
      .command(EventSourceListCommand)
      .command(EventSourceAddCommand)
      .command(EventSourceUpdateCommand)
      .command(EventSourceRemoveCommand)
      .command(EventSourceStartCommand)
      .command(EventSourceStopCommand)
      .command(EventSourceStatusCommand)
      .demandCommand()
      .help(),

  handler: () => {
    // 空实现，yargs 会显示帮助信息
  },
};

export {
  EventSourceListCommand,
  EventSourceAddCommand,
  EventSourceUpdateCommand,
  EventSourceRemoveCommand,
  EventSourceStartCommand,
  EventSourceStopCommand,
  EventSourceStatusCommand,
};
