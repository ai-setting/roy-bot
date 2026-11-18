/**
 * @fileoverview TextInput — Ink single-line input with history navigation.
 *
 * **Compatibility shim (Task #4688).**
 *
 * The original 200-line `tui/TextInput.tsx` became an orphan when Task #4681
 * removed the Ink `RunTui.tsx` (its only live consumer). Measured against the
 * built CLI bundle, the component body was fully tree-shaken — the file
 * contributed only its two `import` lines (7 sourcemap segments, all landing
 * on original lines 12-13) to the artifact, while the component body starting
 * at line 34 was absent.
 *
 * `tui/index.ts` still re-exports `TextInput` / `TextInputProps`, so this
 * file preserves that public surface with a **real, working** Ink component
 * rather than a dangling export.
 *
 * Why an implementation and not a stub:
 *   - Route 1 (re-exporting the Solid `tui-solid/TextInput.js`) was measured
 *     to break the two-chain isolation invariant (Task #4278 片1): bundling
 *     the Ink-only entry point (`ChatTui.tsx`) went from `solid-js`=0 /
 *     `@opentui`=0 to `solid-js`=1 / `@opentui`=3.
 *   - A stub that renders nothing would keep the export "present" but not
 *     "usable", which is the weaker form of a public API break.
 *
 * The editing state machine is shared with the Solid implementation through
 * the pure module `tui/text-input-editing.ts` (`editReducer` / `splitAtCursor`).
 *
 * @deprecated The Ink `TextInput` has no live consumer in the CLI. New code
 *   should use the Solid implementation in `tui-solid/TextInput.tsx` (the
 *   component that actually runs in `roy-bot interactive`). This export is
 *   kept only so `tui/index.ts` keeps its public surface intact.
 */

import React, { useEffect, useReducer, useState } from "react";
import { Box, Text, useInput } from "ink";
import { editReducer, splitAtCursor } from "./text-input-editing.js";

export interface TextInputProps {
  /** Prompt label shown before the input. */
  label: string;
  /** Optional prefix character (e.g. "👤"). */
  prefix?: string;
  /** Called with the entered text when Enter is pressed. */
  onSubmit: (value: string) => void;
  /** Called when the user presses Ctrl+C. */
  onCancel?: () => void;
  /** Placeholder shown when value is empty. */
  placeholder?: string;
  /**
   * Past submitted values, most recent first. ↑ walks back, ↓ walks
   * forward. The current draft is preserved when entering history mode.
   */
  history?: string[];
}

/**
 * @deprecated See the file header — prefer `tui-solid/TextInput.tsx`.
 */
export const TextInput: React.FC<TextInputProps> = ({
  label,
  prefix,
  onSubmit,
  onCancel,
  placeholder,
  history = [],
}) => {
  // Task #4103: value + caret live in one reducer so they always update
  // together against the latest state (see editReducer for why).
  const [{ value, cursor }, dispatch] = useReducer(editReducer, {
    value: "",
    cursor: 0,
  });
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [draft, setDraft] = useState<string>("");

  // Reset history cursor when history prop changes (new entries added)
  useEffect(() => {
    setHistoryIndex(-1);
  }, [history.length]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel?.();
      return;
    }
    if (key.return) {
      const submitted = value;
      dispatch({ type: "clear" });
      setHistoryIndex(-1);
      setDraft("");
      onSubmit(submitted);
      return;
    }
    if (key.backspace || key.delete) {
      // Any edit clears the history cursor (we're now in "draft" mode)
      if (historyIndex !== -1) {
        setHistoryIndex(-1);
      }
      // Task #4103: delete the character *before* the caret (not blindly the
      // tail). NOTE: Ink maps both the physical Backspace byte (\x7f) and the
      // Delete key to `key.delete`, and `useInput` never exposes the raw
      // sequence — so we deliberately treat both as Backspace. Forward-delete
      // (`deleteAt`) stays available in the reducer for when Ink can tell the
      // two apart.
      dispatch({ type: "backspace" });
      return;
    }
    // Task #4103: ←/→ move the caret. Previously unhandled — arrow keys
    // produced no `input` so they fell through and did nothing.
    if (key.leftArrow) {
      dispatch({ type: "left" });
      return;
    }
    if (key.rightArrow) {
      dispatch({ type: "right" });
      return;
    }
    if (key.upArrow) {
      if (history.length === 0) return;
      // Entering history mode: save current draft
      if (historyIndex === -1) {
        setDraft(value);
      }
      const nextIndex = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(nextIndex);
      dispatch({ type: "set", value: history[nextIndex] ?? "" });
      return;
    }
    if (key.downArrow) {
      if (historyIndex === -1) return;
      const nextIndex = historyIndex - 1;
      if (nextIndex < 0) {
        // Exit history mode, restore draft
        setHistoryIndex(-1);
        dispatch({ type: "set", value: draft });
      } else {
        setHistoryIndex(nextIndex);
        dispatch({ type: "set", value: history[nextIndex] ?? "" });
      }
      return;
    }
    // Regular character input — clear history cursor
    if (historyIndex !== -1) {
      setHistoryIndex(-1);
    }
    if (input) {
      dispatch({ type: "insert", text: input });
    }
  });

  const { before, after } = splitAtCursor({ value, cursor });

  return (
    <Box>
      <Text bold color="green">
        {prefix ?? "❯"}{" "}
      </Text>
      <Text bold>{label}: </Text>
      {/* Task #4103: render a visible cursor block *at the caret* so the
          user can see where the next keystroke lands and can move it with
          ←/→. `before` / `after` come from splitAtCursor(), so the block
          sits between characters rather than always at the end. A Unicode
          block glyph (▌) is used because background-color-only cursors get
          stripped by some terminal emulators. When the buffer is empty the
          caret sits at index 0, so the block is shown ahead of the dim
          placeholder. */}
      {value ? (
        <>
          <Text>{before}</Text>
          <Text inverse>▌</Text>
          <Text>{after}</Text>
        </>
      ) : placeholder ? (
        <>
          <Text inverse>▌</Text>
          <Text dimColor>{placeholder}</Text>
        </>
      ) : (
        <Text inverse>▌</Text>
      )}
      {historyIndex !== -1 ? (
        <Text dimColor>  (history)</Text>
      ) : null}
    </Box>
  );
};

export default TextInput;
