/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5116 P7.1 —— 配置弹窗（Dialog）渲染层。
 *
 * 仿 opencode TUI Dialog（packages/tui/src/ui/dialog.tsx:30-58）的
 * opentui 形状：全屏遮罩 + 卡片 + 列表/表单 + 键位提示行。
 * 配色全走 P5 token（useTuiThemeReactive）——不得新增硬编码色。
 *
 * ## 受控组件
 *
 * 面板状态（selectedIndex / 表单字段）全部来自 props ——
 * 状态机（dialog-state.ts）由 RunScreen 驱动（useKeyboard）。
 * 这保证了 testRender 首帧可断言（急求值 JSX 约束）。
 *
 * ## 两种形态
 *
 * - 列表（items 非空 / 无 form）：provider 或 model 选择；
 * - 表单（form prop 存在）：添加 provider（name/apiKey/baseURL 三字段）。
 */

import { For, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { fg, useTuiThemeReactive } from "./theme.js";
import type { DialogListItem } from "./dialog-state.js";
import { CONNECT_FORM_FIELDS } from "./dialog-state.js";

export interface DialogFormProps {
  mode: "form";
  fieldIndex: number;
  fields: { name: string; apiKey: string; baseURL: string };
}

export interface DialogProps {
  /** 弹窗标题（卡片首行）。 */
  title: string;
  /** 可见性（false 时不渲染）。 */
  visible: boolean;
  /** 列表项（list 形态）。 */
  items: DialogListItem[];
  /** 当前高亮（list 形态）。 */
  selectedIndex: number;
  /** 键位提示行（可选）。 */
  hint?: string;
  /** 表单形态（存在 ⇒ 渲染表单而非列表）。 */
  form?: DialogFormProps;
}

export function Dialog(props: DialogProps) {
  const theme = useTuiThemeReactive();
  const FIELD_LABELS: Record<string, string> = {
    name: "name",
    apiKey: "apiKey",
    baseURL: "baseURL",
  };

  return (
    <Show when={props.visible}>
      <box
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          left: 0,
          top: 0,
          alignItems: "center",
          paddingTop: 2,
          backgroundColor: fg("#00000080"),
        }}
      >
        <box
          style={{
            width: 60,
            flexDirection: "column",
            borderStyle: "rounded",
            borderColor: fg(theme.borderActive),
            backgroundColor: fg(theme.backgroundPanel),
            paddingX: 1,
          }}
        >
          <text style={{ fg: fg(theme.primary), attributes: TextAttributes.BOLD }}>
            {props.title}
          </text>
          <Show
            when={props.form}
            fallback={() => (
              <box style={{ flexDirection: "column", marginTop: 1 }}>
                <Show
                  when={props.items.length > 0}
                  fallback={() => (
                    <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}>
                      No entries
                    </text>
                  )}
                >
                  <For each={props.items}>
                    {(item, index) => (
                      <DialogRow
                        item={item}
                        selected={index() === props.selectedIndex}
                      />
                    )}
                  </For>
                </Show>
              </box>
            )}
          >
            {() => (
              <box style={{ flexDirection: "column", marginTop: 1 }}>
                <For each={[...CONNECT_FORM_FIELDS]}>
                  {(field, index) => (
                    <box style={{ flexDirection: "row" }}>
                      <text
                        style={{
                          fg:
                            index() === props.form!.fieldIndex
                              ? fg(theme.primary)
                              : fg(theme.textMuted),
                          attributes:
                            index() === props.form!.fieldIndex
                              ? TextAttributes.BOLD
                              : 0,
                        }}
                      >
                        {`${index() === props.form!.fieldIndex ? "▶" : " "} ${FIELD_LABELS[field]}: `}
                      </text>
                      <text style={{ fg: fg(theme.text) }}>
                        {props.form!.fields[field] || (field === "name" ? "" : "")}
                      </text>
                      <Show when={!props.form!.fields[field]}>
                        <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}>
                          _
                        </text>
                      </Show>
                    </box>
                  )}
                </For>
              </box>
            )}
          </Show>
          <Show when={props.hint}>
            <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}>
              {props.hint}
            </text>
          </Show>
        </box>
      </box>
    </Show>
  );
}

function DialogRow(props: { item: DialogListItem; selected: boolean }) {
  const theme = useTuiThemeReactive();
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
        {`${props.selected ? "▶" : " "} /${props.item.label}`}
      </text>
      <Show when={props.item.badge}>
        <text style={{ fg: fg(theme.success) }}>{` [${props.item.badge}]`}</text>
      </Show>
      <Show when={props.item.detail}>
        <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}>
          {`  ${props.item.detail}`}
        </text>
      </Show>
    </box>
  );
}

export default Dialog;
