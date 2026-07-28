export type EngineType = "codex" | "claude";

export interface EngineConfig {
  type: EngineType;
  model?: string;
  reasoningEffort?: string;
  pythonPath?: string;
}

export interface EngineAuth {
  readonly method: "api_key" | "stored_credentials";
  readonly verified: boolean;
  readonly engine: EngineType;
}

export interface EngineEvent {
  readonly type: string;
  readonly thread_id?: string;
  readonly threadId?: string;
  readonly [key: string]: unknown;
}

export interface EngineThread {
  readonly id: string | null;
  runStreamed(
    input: string,
    options: { signal: AbortSignal },
  ): Promise<{ events: AsyncGenerator<EngineEvent> }>;
}

export interface ScanEngine {
  readonly engineType: EngineType;
  readonly codexCommand: (() => import("../runtime.js").CodexCommand) | null;
  readonly metadata: {
    sdk: string;
    sdkVersion: string;
    executable?: string;
    executableVersion?: string;
  };
  createScanSession(options: {
    env: Record<string, string>;
    workingDirectory: string;
    signal?: AbortSignal;
  }): Promise<EngineThread>;
  checkAuth(env: Record<string, string | undefined>): Promise<EngineAuth>;
  login?(options: {
    apiKey?: string;
    env: Record<string, string | undefined>;
    signal?: AbortSignal;
  }): Promise<{ success: boolean }>;
  logout?(): Promise<void>;
}
