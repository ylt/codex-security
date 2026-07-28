import { randomUUID } from "node:crypto";
import { readClaudeApiKey, removeClaudeApiKey, saveClaudeApiKey } from "./claude-auth.js";
import type { EngineAuth, EngineConfig, EngineThread, ScanEngine } from "./types.js";
import { ANTHROPIC_SDK_VERSION } from "../version.js";

type AnthropicClient = { messages: { create(input: Record<string, unknown>): Promise<any> } };

async function client(apiKey?: string): Promise<AnthropicClient> {
  const load = new Function("return import('@anthropic-ai/sdk')") as () => Promise<{ default: new (options: { apiKey: string }) => AnthropicClient }>;
  const module = await load();
  return new module.default(apiKey === undefined ? {} : { apiKey });
}

export class ClaudeEngine implements ScanEngine {
  readonly engineType = "claude" as const;
  readonly codexCommand = null;
  readonly metadata = { sdk: "@anthropic-ai/sdk", sdkVersion: ANTHROPIC_SDK_VERSION };
  public constructor(private readonly config: EngineConfig, private readonly environment: Record<string, string | undefined>) {}

  async checkAuth(env: Record<string, string | undefined>): Promise<EngineAuth> {
    const key = await readClaudeApiKey(env);
    return { method: key === null ? "stored_credentials" : (env.ANTHROPIC_API_KEY ? "api_key" : "stored_credentials"), verified: false, engine: "claude" };
  }

  async login(options: { apiKey?: string }): Promise<{ success: boolean }> {
    if (options.apiKey === undefined) return { success: true };
    await saveClaudeApiKey(options.apiKey);
    return { success: true };
  }

  async logout(): Promise<void> { await removeClaudeApiKey(); }

  async createScanSession(options: { env: Record<string, string>; workingDirectory: string }): Promise<EngineThread> {
    const key = await readClaudeApiKey({ ...this.environment, ...options.env });
    const anthropic = await client(key);
    const id = randomUUID();
    const model = this.config.model ?? "claude-sonnet-4-20250514";
    return {
      id,
      runStreamed: async (input, runOptions) => ({ events: claudeEvents(anthropic, id, model, input, runOptions.signal) }),
    };
  }
}

async function* claudeEvents(anthropic: AnthropicClient, id: string, model: string, input: string, signal: AbortSignal): AsyncGenerator<any> {
  yield { type: "thread.started", thread_id: id };
  if (signal.aborted) return;
  try {
    const response = await anthropic.messages.create({ model, max_tokens: 8192, messages: [{ role: "user", content: input }], stream: false });
    const text = Array.isArray(response.content) ? response.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("") : "";
    yield { type: "item.completed", item: { type: "agent_message", text } };
    yield { type: "turn.completed", usage: response.usage ?? null };
  } catch (error) {
    yield { type: "turn.failed", error: { message: error instanceof Error ? error.message : String(error) } };
  }
}
