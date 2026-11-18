/**
 * @fileoverview ToolCall — opencode-style tool invocation card (Task #4124).
 *
 * Renders one `ToolCallInfo` as:
 *
 *   ❯ Bash  ✓ 0.3s
 *     ls -la
 *     └ file1.txt
 *       file2.txt
 *
 * `running` cards live in App's dynamic region while the tool executes;
 * once the result arrives the card is committed to the transcript. The
 * status glyph therefore never needs to re-render a committed row.
 */

import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "./Spinner.js";
import { getTheme } from "./theme.js";
import {
  describeToolCall,
  formatDuration,
  type ToolCallInfo,
} from "./tool-call.js";

export interface ToolCallProps {
  info: ToolCallInfo;
  /** Show the (bounded) output preview. Defaults to true. */
  showOutput?: boolean;
}

/** Status badge: spinner while running, ✓ / ✗ once settled. */
const StatusBadge: React.FC<{ info: ToolCallInfo }> = ({ info }) => {
  const theme = getTheme();
  if (info.status === "running") {
    return <Spinner label="running" />;
  }
  const duration =
    info.durationMs !== undefined ? ` ${formatDuration(info.durationMs)}` : "";
  if (info.status === "error") {
    return (
      <Text color={theme.error}>
        ✗{duration || " failed"}
      </Text>
    );
  }
  return (
    <Text color={theme.success}>
      ✓{duration}
    </Text>
  );
};

export const ToolCall: React.FC<ToolCallProps> = ({
  info,
  showOutput = true,
}) => {
  const theme = getTheme();
  const { icon, label, detail } = describeToolCall(info.name, info.args);

  const outputLines =
    showOutput && info.output ? info.output.split("\n") : [];
  const errorLines =
    showOutput && info.error ? info.error.split("\n").slice(0, 12) : [];

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Title: icon + humanised name + status badge */}
      <Box>
        <Text color={theme.tool}>{icon} </Text>
        <Text bold color={theme.tool}>
          {label}
        </Text>
        <Text> </Text>
        <StatusBadge info={info} />
      </Box>

      {/* Primary argument */}
      {detail ? (
        <Box marginLeft={2}>
          <Text dimColor>{detail}</Text>
        </Box>
      ) : null}

      {/* Output preview (completed calls) */}
      {outputLines.map((line, i) => (
        <Box key={`out-${i}`} marginLeft={2}>
          <Text dimColor>
            {i === 0 ? "└ " : "  "}
            {line}
          </Text>
        </Box>
      ))}

      {/* Error preview (failed calls) */}
      {errorLines.map((line, i) => (
        <Box key={`err-${i}`} marginLeft={2}>
          <Text color={theme.error}>
            {i === 0 ? "└ " : "  "}
            {line}
          </Text>
        </Box>
      ))}
    </Box>
  );
};

export default ToolCall;
