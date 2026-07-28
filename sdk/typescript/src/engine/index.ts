import { ClaudeEngine } from "./claude-engine.js";
import { CodexEngine } from "./codex-engine.js";
import type { EngineConfig, EngineType, ScanEngine } from "./types.js";

export function createEngine(
  type: EngineType,
  config: EngineConfig,
  env: Record<string, string | undefined>,
): ScanEngine {
  return type === "claude"
    ? new ClaudeEngine(config, env)
    : new CodexEngine(config, env);
}

export type * from "./types.js";
export { ClaudeEngine } from "./claude-engine.js";
export { CodexEngine } from "./codex-engine.js";
