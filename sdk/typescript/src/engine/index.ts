import { ClaudeEngine } from "./claude-engine.js";
import { CodexEngine } from "./codex-engine.js";
import { AcpEngine } from "./acp-engine.js";
import type { EngineConfig, EngineType, ScanEngine } from "./types.js";

export function createEngine(
  type: EngineType,
  config: EngineConfig,
  env: Record<string, string | undefined>,
): ScanEngine {
  switch (type) {
    case "codex":
      return new CodexEngine(config, env);
    case "claude":
      return new ClaudeEngine(config, env);
    case "acp":
      return new AcpEngine(config, env);
  }
}

export type * from "./types.js";
export { ClaudeEngine } from "./claude-engine.js";
export { CodexEngine } from "./codex-engine.js";
export { AcpEngine } from "./acp-engine.js";
