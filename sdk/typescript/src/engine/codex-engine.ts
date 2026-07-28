import { Codex, type CodexOptions } from "@openai/codex-sdk";
import { loginApiKey, logout } from "../auth.js";
import { resolveCodexCommand, type CodexCommand } from "../runtime.js";
import { CODEX_EXECUTABLE_VERSION, CODEX_SDK_VERSION } from "../version.js";
import type {
  EngineAuth,
  EngineConfig,
  EngineThread,
  ScanEngine,
} from "./types.js";

export class CodexEngine implements ScanEngine {
  readonly engineType = "codex" as const;
  readonly codexCommand = (): CodexCommand => resolveCodexCommand();
  readonly metadata = {
    sdk: "@openai/codex-sdk",
    sdkVersion: CODEX_SDK_VERSION,
    executable: "@openai/codex",
    executableVersion: CODEX_EXECUTABLE_VERSION,
  };

  public constructor(
    private readonly config: EngineConfig,
    private readonly environment: Record<string, string | undefined>,
  ) {}

  async createScanSession(options: {
    env: Record<string, string>;
    workingDirectory: string;
  }): Promise<EngineThread> {
    const client = (
      (this.config.createCodex as
        | ((options: CodexOptions) => {
            startThread(options: {
              workingDirectory: string;
              skipGitRepoCheck: boolean;
              approvalPolicy: "never";
              model?: string;
            }): unknown;
          })
        | undefined) ?? ((options: CodexOptions) => new Codex(options))
    )({
      env: options.env,
      config: {
        default_permissions: "codex_security_scan",
        allow_login_shell: false,
        permissions: {
          codex_security_scan: {
            filesystem: { ":root": "read", ":workspace_roots": "write" },
          },
        },
      },
    });
    const thread = client.startThread({
      workingDirectory: options.workingDirectory,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      ...(this.config.model === undefined ? {} : { model: this.config.model }),
    });
    return thread as EngineThread;
  }

  async checkAuth(
    env: Record<string, string | undefined>,
  ): Promise<EngineAuth> {
    const hasKey = ["OPENAI_API_KEY", "CODEX_API_KEY"].some((name) =>
      Boolean(env[name]?.trim()),
    );
    if (hasKey) return { method: "api_key", verified: false, engine: "codex" };
    return { method: "stored_credentials", verified: false, engine: "codex" };
  }

  async login(options: {
    apiKey?: string;
    env: Record<string, string | undefined>;
    signal?: AbortSignal;
  }): Promise<{ success: boolean }> {
    if (options.apiKey === undefined) return { success: false };
    const result = await loginApiKey(
      this.codexCommand(),
      options.env,
      options.apiKey,
      options.signal,
    );
    return { success: result.success };
  }

  async logout(): Promise<void> {
    await logout(this.codexCommand(), this.environment);
  }
}
