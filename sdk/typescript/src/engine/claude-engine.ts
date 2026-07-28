import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  EngineAuth,
  EngineConfig,
  EngineEvent,
  EngineThread,
  ScanEngine,
} from "./types.js";
import { ANTHROPIC_SDK_VERSION } from "../version.js";

const execFileAsync = promisify(execFile);
const MAX_TOOL_ROUNDS = 100;
const MAX_TOOL_OUTPUT = 4 * 1024 * 1024;
const MAX_RETRIES = 3;

type AnthropicClient = {
  messages: {
    create(
      input: Record<string, unknown>,
    ): Promise<AsyncIterable<ClaudeStreamEvent>>;
  };
};

type ClaudeStreamEvent = {
  type: string;
  index?: number;
  message?: { usage?: { input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
    usage?: { output_tokens?: number };
  };
};

type ToolCall = { id: string; name: string; input: Record<string, unknown> };

async function createClient(): Promise<AnthropicClient> {
  const load = new Function(
    "return import('@anthropic-ai/sdk')",
  ) as () => Promise<{
    default: new (options?: Record<string, unknown>) => AnthropicClient;
  }>;
  const module = await load();
  return new module.default();
}

export class ClaudeEngine implements ScanEngine {
  readonly engineType = "claude" as const;
  readonly codexCommand = null;
  readonly metadata = {
    sdk: "@anthropic-ai/sdk",
    sdkVersion: ANTHROPIC_SDK_VERSION,
  };

  public constructor(
    private readonly config: EngineConfig,
    _environment: Record<string, string | undefined>,
  ) {}

  async checkAuth(
    env: Record<string, string | undefined>,
  ): Promise<EngineAuth> {
    const hasKey = Boolean(env["ANTHROPIC_API_KEY"]?.trim());
    return {
      method: hasKey ? "api_key" : "stored_credentials",
      verified: false,
      engine: "claude",
    };
  }

  async login(_options: {
    apiKey?: string;
    env: Record<string, string | undefined>;
    signal?: AbortSignal;
  }): Promise<{ success: boolean }> {
    // Anthropic SDK resolves credentials automatically from the environment.
    return { success: true };
  }

  async logout(): Promise<void> {
    // Anthropic SDK manages its own credential state.
  }

  async createScanSession(options: {
    env: Record<string, string>;
    workingDirectory: string;
  }): Promise<EngineThread> {
    const anthropic = await createClient();
    const threadId = randomUUID();
    const model = this.config.model ?? "claude-sonnet-4-20250514";
    return {
      id: threadId,
      runStreamed: async (input, runOptions) => ({
        events: claudeEvents({
          anthropic,
          environment: options.env,
          workingDirectory: options.workingDirectory,
          threadId,
          model,
          input,
          signal: runOptions.signal,
        }),
      }),
    };
  }
}

async function* claudeEvents(options: {
  anthropic: AnthropicClient;
  environment: Record<string, string>;
  workingDirectory: string;
  threadId: string;
  model: string;
  input: string;
  signal: AbortSignal;
}): AsyncGenerator<EngineEvent> {
  yield { type: "thread.started", thread_id: options.threadId };
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: options.input },
  ];
  let usage: Record<string, number> | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    throwIfAborted(options.signal);
    const response = await createWithRetry(options, messages);
    const result = await consumeResponse(response, options.signal);
    usage = result.usage ?? usage;
    if (result.text.length > 0) {
      yield {
        type: "item.completed",
        item: { type: "agent_message", text: result.text },
      };
    }
    if (result.toolCalls.length === 0) {
      yield { type: "turn.completed", usage };
      return;
    }

    messages.push({ role: "assistant", content: result.content });
    const toolResults: Array<Record<string, unknown>> = [];
    for (const call of result.toolCalls) {
      throwIfAborted(options.signal);
      const output = await executeTool(call, options);
      yield {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: call.name === "run_workbench" ? output.command : call.name,
          aggregated_output: output.text,
        },
      };
      toolResults.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: output.text,
        ...(output.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  yield {
    type: "turn.failed",
    error: {
      message: `Claude scan exceeded the ${MAX_TOOL_ROUNDS}-turn tool limit.`,
    },
  };
}

async function createWithRetry(
  options: Parameters<typeof claudeEvents>[0],
  messages: Array<Record<string, unknown>>,
): Promise<AsyncIterable<ClaudeStreamEvent>> {
  const tools = [
    {
      name: "run_workbench",
      description:
        "Run one bundled Codex Security workbench command. Use this for scan registration, progress, artifact validation, and finalization.",
      input_schema: {
        type: "object",
        properties: { args: { type: "array", items: { type: "string" } } },
        required: ["args"],
      },
    },
    {
      name: "run_command",
      description:
        "Run a non-interactive repository command in the scan directory. Use this for inspection and invoking bundled scan scripts.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["command", "args"],
      },
    },
  ];
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await options.anthropic.messages.create({
        model: options.model,
        max_tokens: 16_384,
        system:
          "You are running Codex Security in a non-interactive scan. Follow the supplied scan instructions exactly. Use run_command for repository and bundled scan scripts, and run_workbench for workbench database operations. Never stop before writing the required scan artifacts and completing the requested scan.",
        messages,
        tools,
        stream: true,
      });
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES || !isRetryable(error)) throw error;
      await delay(2 ** attempt * 500, options.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function consumeResponse(
  response: AsyncIterable<ClaudeStreamEvent>,
  signal: AbortSignal,
): Promise<{
  text: string;
  content: Array<Record<string, unknown>>;
  toolCalls: ToolCall[];
  usage: Record<string, number> | null;
}> {
  const content: Array<Record<string, unknown>> = [];
  const toolInputs = new Map<
    number,
    { block: Record<string, unknown>; json: string }
  >();
  let text = "";
  let usage: Record<string, number> | null = null;
  for await (const event of response) {
    throwIfAborted(signal);
    if (
      event.type === "message_start" &&
      event.message?.usage?.input_tokens !== undefined
    ) {
      usage = { input_tokens: event.message.usage.input_tokens };
    }
    if (
      event.type === "content_block_start" &&
      event.index !== undefined &&
      event.content_block !== undefined
    ) {
      const block = event.content_block;
      if (block.type === "text")
        content[event.index] = { type: "text", text: "" };
      if (block.type === "tool_use") {
        const toolBlock = {
          type: "tool_use",
          id: block.id ?? randomUUID(),
          name: block.name ?? "",
        };
        content[event.index] = toolBlock;
        toolInputs.set(event.index, { block: toolBlock, json: "" });
      }
    }
    if (
      event.type === "content_block_delta" &&
      event.index !== undefined &&
      event.delta !== undefined
    ) {
      const delta = event.delta;
      if (delta.type === "text_delta" && delta.text !== undefined) {
        text += delta.text;
        const block = content[event.index];
        if (block !== undefined && typeof block["text"] === "string")
          block["text"] += delta.text;
      }
      if (
        delta.type === "input_json_delta" &&
        delta.partial_json !== undefined
      ) {
        const tool = toolInputs.get(event.index);
        if (tool !== undefined) tool.json += delta.partial_json;
      }
    }
    if (
      event.type === "message_delta" &&
      event.delta?.usage?.output_tokens !== undefined
    ) {
      usage = {
        ...(usage ?? {}),
        output_tokens: event.delta.usage.output_tokens,
      };
    }
  }
  const toolCalls: ToolCall[] = [];
  for (const { block, json } of toolInputs.values()) {
    let input: unknown = {};
    try {
      input = json === "" ? {} : JSON.parse(json);
    } catch {
      input = { error: "Claude returned invalid tool input JSON." };
    }
    toolCalls.push({
      id: String(block["id"]),
      name: String(block["name"]),
      input: isRecord(input) ? input : { value: input },
    });
    block["input"] = isRecord(input) ? input : { value: input };
  }
  return { text, content, toolCalls, usage };
}

async function executeTool(
  call: ToolCall,
  options: Parameters<typeof claudeEvents>[0],
): Promise<{ text: string; command: string; isError: boolean }> {
  try {
    if (call.name === "run_workbench") {
      const args = stringArray(call.input["args"]);
      const python = requiredEnvironment(options.environment, "PYTHON");
      const pluginRoot = requiredEnvironment(
        options.environment,
        "CODEX_SECURITY_PLUGIN_ROOT",
      );
      const result = await execFileAsync(
        python,
        ["-I", "-B", join(pluginRoot, "scripts", "workbench_db.py"), ...args],
        {
          cwd: options.workingDirectory,
          env: sanitizedEnvironment(options.environment),
          maxBuffer: MAX_TOOL_OUTPUT,
        },
      );
      return {
        text: result.stdout,
        command: [python, ...args].join(" "),
        isError: false,
      };
    }
    if (call.name === "run_command") {
      const command = requiredString(call.input["command"], "command");
      const args = stringArray(call.input["args"]);
      const result = await execFileAsync(command, args, {
        cwd: options.workingDirectory,
        env: sanitizedEnvironment(options.environment),
        maxBuffer: MAX_TOOL_OUTPUT,
      });
      return {
        text: result.stdout,
        command: [command, ...args].join(" "),
        isError: false,
      };
    }
    return {
      text: `Unknown Claude tool: ${call.name}`,
      command: call.name,
      isError: true,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      text: detail.slice(0, MAX_TOOL_OUTPUT),
      command: call.name,
      isError: true,
    };
  }
}

function sanitizedEnvironment(
  environment: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !/(?:KEY|TOKEN|SECRET|PASSWORD)/iu.test(name),
    ),
  );
}

function requiredEnvironment(
  environment: Record<string, string>,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0)
    throw new Error(`Claude scan environment is missing ${name}.`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Claude tool input requires ${name}.`);
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error("Claude tool input requires an args string array.");
  return value;
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/(?:429|500|502|503|504)/u.test(error.message) ||
      /rate.?limit|overloaded|temporar/iu.test(error.message))
  );
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("The Claude scan was aborted."));
      },
      { once: true },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason ?? new Error("The Claude scan was aborted.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
