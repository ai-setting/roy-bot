export {
  type ConfigSource,
  type ConfigSourceType,
  type ConfigChangeEvent,
  type ConfigComponentOptions,
  type SourceRegistration,
  type KeyRegistration,
  type ComponentRegistration,
  ConfigSourceNotFoundError,
  ConfigFileNotFoundError,
  ConfigComponent,
  MemorySource,
} from "./config-component";

export { FileSource, type FileSourceOptions } from "./file-source";
export { EnvSource, type EnvSourceOptions } from "./env-source";

export {
  parseJSONC,
  parseJSONCWithEnv,
  parseJSONCWithProtocols,
  substituteEnvVars,
  substituteProtocolRefs,
} from "./config-parser";

// ★ Task #5194 MAJOR-1：护栏 API 从 config barrel 导出
//   （cli 侧 tui-solid 测试的 bun 模块解析只认 barrel 子路径）
export {
  guardConfigWrite,
  snapshotConfigDir,
  appendAuditLog,
  readAuditLog,
  checkSourceCountDrop,
  readSourceCountFromDisk,
  PROTECTED_CONFIG_FILES,
  type AuditEntry,
  type SourceDropCheck,
} from "./config-protection";
