/**
 * @fileoverview Pure editing helpers for `TextInput` (Task #4103).
 *
 * Extracted from `TextInput.tsx` so that caret movement, insertion and
 * deletion can be unit-tested as pure functions — driving real keypresses
 * through `ink-testing-library`'s stdin is flaky and racy, which is how
 * the original cursor "fix" ended up shipping with vacuous tests.
 *
 * The caret (`cursor`) is an index into `value` in the range
 * `[0, value.length]`. The cursor sits *between* characters: index 0 is
 * before the first char, index `value.length` is after the last char.
 *
 * These helpers never mutate their input; they return a new `TextEdit`.
 */

export interface TextEdit {
  /** Current buffer contents. */
  value: string;
  /** Caret index in `[0, value.length]`. */
  cursor: number;
}

/** Clamp a caret index into `[0, value.length]`. */
export function clampCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.max(0, Math.min(Math.trunc(cursor), value.length));
}

/** Insert `text` at the caret. The caret ends up after the inserted text. */
export function insertText(state: TextEdit, text: string): TextEdit {
  const cursor = clampCursor(state.value, state.cursor);
  const value =
    state.value.slice(0, cursor) + text + state.value.slice(cursor);
  return { value, cursor: cursor + text.length };
}

/** Backspace: delete the character *before* the caret. No-op at index 0. */
export function deleteBefore(state: TextEdit): TextEdit {
  const cursor = clampCursor(state.value, state.cursor);
  if (cursor === 0) return { value: state.value, cursor };
  const value =
    state.value.slice(0, cursor - 1) + state.value.slice(cursor);
  return { value, cursor: cursor - 1 };
}

/** Delete: delete the character *at* the caret. No-op at end of buffer. */
export function deleteAt(state: TextEdit): TextEdit {
  const { value } = state;
  const cursor = clampCursor(value, state.cursor);
  if (cursor >= value.length) return { value, cursor };
  return { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor };
}

/** Move the caret one position left (clamped at 0). */
export function moveLeft(state: TextEdit): TextEdit {
  return {
    value: state.value,
    cursor: Math.max(0, clampCursor(state.value, state.cursor) - 1),
  };
}

/** Move the caret one position right (clamped at `value.length`). */
export function moveRight(state: TextEdit): TextEdit {
  const cursor = clampCursor(state.value, state.cursor);
  return {
    value: state.value,
    cursor: Math.min(state.value.length, cursor + 1),
  };
}

/**
 * Split the buffer at the caret for rendering:
 *   `<Text>{before}</Text><Text inverse>▌</Text><Text>{after}</Text>`
 * so the visible cursor block tracks the caret instead of always sitting
 * at the end of the line.
 */
export function splitAtCursor(state: TextEdit): {
  before: string;
  after: string;
  cursor: number;
} {
  const cursor = clampCursor(state.value, state.cursor);
  return {
    before: state.value.slice(0, cursor),
    after: state.value.slice(cursor),
    cursor,
  };
}

/** Actions the TextInput reducer understands. */
export type EditAction =
  | { type: "insert"; text: string }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "set"; value: string; cursor?: number }
  | { type: "clear" };

/**
 * Reducer over `TextEdit`.
 *
 * A reducer (rather than two independent `useState` calls) guarantees
 * `value` and `cursor` move together and are applied against the LATEST
 * state even when several keys arrive in one tick. With plain setState,
 * typing "abc" delivered as a single read would make each keystroke read the
 * stale render value and only the last character would survive.
 */
export function editReducer(state: TextEdit, action: EditAction): TextEdit {
  switch (action.type) {
    case "insert":
      return insertText(state, action.text);
    case "backspace":
      return deleteBefore(state);
    case "delete":
      return deleteAt(state);
    case "left":
      return moveLeft(state);
    case "right":
      return moveRight(state);
    case "set":
      return {
        value: action.value,
        cursor: action.cursor ?? action.value.length,
      };
    case "clear":
      return { value: "", cursor: 0 };
  }
}
