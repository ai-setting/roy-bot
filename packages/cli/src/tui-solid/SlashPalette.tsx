/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5109 P7 —— 斜杠命令**补全面板**（渲染层）。
 *
 * ## 职责
 *
 * 把注册表命令（`SlashCommandSpec[]`）按 `query` 过滤后画成列表：
 *   - 每行 `/name` + 别名提示 + 描述；
 *   - 高亮行（`selectedIndex`）用 `▶` 前缀 + `backgroundPanel` 底 + `borderActive` 描边；
 *   - 无匹配时显示空态提示；
 *   - `visible=false` 时不渲染。
 *
 * ## 与 opencode 的对齐
 *
 * opencode 的 `footer.prompt.tsx` 用 `createFooterMenuState` 画 10 行
 * （`PANEL_LIST_ROWS = 10`），选中行高亮；本仓简化为**全量渲染 + 高亮行**，
 * 因为 P7 首版只有 5 条命令，不需要翻页。
 *
 * ## 颜色
 *
 * 一律走 P5 token（`backgroundPanel` / `borderActive` / `textMuted` / `primary`），
 * **不得新增硬编码色**（P5 纪律）。
 */

import { createMemo, For, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { fg } from "./style.js";
import { useTuiThemeReactive } from "./theme.js";
import { filterSlashCommands, type SlashCommandSpec } from "./slash-registry.js";

export interface SlashPaletteProps {
  /** 注册表命令集。 */
  specs: SlashCommandSpec[];
  /** 当前过滤词（`/` 之后的部分）。 */
  query: string;
  /** 当前高亮下标。 */
  selectedIndex: number;
  /** 面板可见性（false 时不渲染）。 */
  visible: boolean;
}

export function SlashPalette(props: SlashPaletteProps) {
  const theme = useTuiThemeReactive();
  const filtered = createMemo(() => filterSlashCommands(props.specs, props.query));

  return (
    <Show when={props.visible}>
      <box
        style={{
          flexDirection: "column",
          backgroundColor: fg(theme.backgroundPanel),
          borderStyle: "rounded",
          borderColor: fg(theme.borderActive),
          paddingX: 1,
          marginBottom: 1,
        }}
      >
        <Show
          when={filtered().length > 0}
          fallback={
            <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}>
              No matching commands
            </text>
          }
        >
          <For each={filtered()}>
            {(spec, index) => (
              <SlashRow
                spec={spec}
                selected={index() === props.selectedIndex}
              />
            )}
          </For>
        </Show>
      </box>
    </Show>
  );
}

function SlashRow(props: { spec: SlashCommandSpec; selected: boolean }) {
  const theme = useTuiThemeReactive();
  const aliasHint = () => {
    const aliases = props.spec.aliases ?? [];
    if (aliases.length === 0) return "";
    return ` (${aliases.map((a) => `/${a}`).join(", ")})`;
  };

  return (
    <box
      style={{
        flexDirection: "row",
        backgroundColor: props.selected ? fg(theme.backgroundElement) : undefined,
      }}
    >
      <text
        style={{
          fg: props.selected ? fg(theme.primary) : fg(theme.text),
          attributes: props.selected ? TextAttributes.BOLD : 0,
        }}
      >
        {`${props.selected ? "▶ " : "  "}/${props.spec.name}`}
      </text>
      <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}>
        {aliasHint()}
      </text>
      <text style={{ fg: fg(theme.textMuted) }}>{`  ${props.spec.description}`}</text>
    </box>
  );
}

export default SlashPalette;
