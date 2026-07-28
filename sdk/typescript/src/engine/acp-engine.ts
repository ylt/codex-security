import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexSecurityError } from "../errors.js";
import { VERSION } from "../version.js";
import type {
  EngineAuth,
  EngineConfig,
  EngineEvent,
  EngineThread,
  ScanEngine,
} from "./types.js";

const ACP_PROTOCOL_VERSION = "2025-03-26";
const REQUEST_TIMEOUT_MS = 30_000;

interface RpcNotification {
  readonly jsonrpc?: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

type Command = { command: string; args: string[] };

export class AcpEngine implements ScanEngine {
  readonly engineType = "acp" as const;
  readonly codexCommand = null;
  readonly metadata = { sdk: "ACP", sdkVersion: ACP_PROTOCOL_VERSION };

  public constructor(
    private readonly config: EngineConfig,
    private readonly environment: Record<string, string | undefined>,
  ) {
    const commandText =
      config.engineCommand ?? environment["CODEX_SECURITY_ENGINE_COMMAND"];
    if (commandText === undefined || commandText.trim().length === 0) {
      throw new CodexSecurityError(
        "ACP engine requires --engine-command or CODEX_SECURITY_ENGINE_COMMAND.",
      );
    }
    parseEngineCommand(commandText);
  }

  async checkAuth(
    _env: Record<string, string | undefined>,
  ): Promise<EngineAuth> {
    return { method: "stored_credentials", verified: false, engine: "acp" };
  }

  async createScanSession(options: {
    env: Record<string, string>;
    workingDirectory: string;
    repositoryDirectory?: string;
  }): Promise<EngineThread> {
    const commandText =
      this.config.engineCommand ??
      this.environment["CODEX_SECURITY_ENGINE_COMMAND"]!;
    const command = parseEngineCommand(commandText);
    const transport = new JsonRpcTransport(command, {
      cwd: options.repositoryDirectory ?? options.workingDirectory,
      environment: options.env,
    });
    try {
      const initialized = await transport.request(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientInfo: { name: "codex-security", version: VERSION },
          capabilities: {},
        },
        REQUEST_TIMEOUT_MS,
      );
      const protocolVersion = initialized["protocolVersion"];
      if (
        typeof protocolVersion === "string" &&
        protocolVersion !== ACP_PROTOCOL_VERSION
      ) {
        throw new CodexSecurityError(
          `ACP agent negotiated unsupported protocol version ${protocolVersion}; expected ${ACP_PROTOCOL_VERSION}.`,
        );
      }
      const session = await transport.request(
        "session/new",
        {
          cwd: options.repositoryDirectory ?? options.workingDirectory,
          mcpServers: [],
        },
        REQUEST_TIMEOUT_MS,
      );
      const sessionId = session["sessionId"];
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new CodexSecurityError(
          "ACP agent returned an invalid session/new response.",
        );
      }
      return new AcpThread(transport, sessionId);
    } catch (error) {
      await transport.close();
      throw error;
    }
  }
}

class AcpThread implements EngineThread {
  readonly id: string;

  public constructor(
    private readonly transport: JsonRpcTransport,
    private readonly sessionId: string,
  ) {
    this.id = sessionId;
  }

  async runStreamed(
    input: string,
    options: { signal: AbortSignal },
  ): Promise<{ events: AsyncGenerator<EngineEvent> }> {
    return { events: this.events(input, options.signal) };
  }

  private async *events(
    input: string,
    signal: AbortSignal,
  ): AsyncGenerator<EngineEvent> {
    yield { type: "thread.started", thread_id: this.sessionId };
    let text = "";
    let cancelSent = false;
    const cancel = (): void => {
      if (cancelSent) return;
      cancelSent = true;
      void this.transport.notify("session/cancel", {
        sessionId: this.sessionId,
      });
      void this.transport.close();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) {
        cancel();
        throw signal.reason ?? new Error("ACP scan was aborted.");
      }
      const response = this.transport.request(
        "session/prompt",
        {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text: input }],
        },
        0,
      );
      for (;;) {
        const queued = this.transport.takeNotification();
        const outcome =
          queued === undefined
            ? await Promise.race([
                response.then((result) => ({
                  kind: "response" as const,
                  result,
                })),
                this.transport.nextNotification().then((notification) => ({
                  kind: "notification" as const,
                  notification,
                })),
              ])
            : { kind: "notification" as const, notification: queued };
        if (outcome.kind === "response") {
          this.transport.clearNotificationWaiter();
          if (typeof outcome.result["stopReason"] === "string") {
            const stopReason = outcome.result["stopReason"];
            if (stopReason === "endTurn") {
              if (text.length > 0) {
                yield {
                  type: "item.completed",
                  item: { type: "agent_message", text },
                };
              }
              yield { type: "turn.completed", usage: null };
            } else {
              yield {
                type: "turn.failed",
                error: {
                  message: `ACP agent stopped with reason ${stopReason}.`,
                },
              };
            }
          } else {
            yield { type: "turn.completed", usage: null };
          }
          return;
        }
        const notification = outcome.notification;
        if (notification.method !== "session/update") continue;
        const params = notification.params ?? {};
        if (params["sessionId"] !== this.sessionId) continue;
        const update = isRecord(params["event"]) ? params["event"] : params;
        const updateType = update["type"];
        if (
          updateType === "agent_message_chunk" &&
          typeof update["text"] === "string"
        ) {
          text += update["text"];
        }
        yield mapAcpUpdate(this.sessionId, update);
      }
    } catch (error) {
      this.transport.clearNotificationWaiter();
      if (signal.aborted) {
        cancel();
        throw error;
      }
      yield {
        type: "turn.failed",
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      signal.removeEventListener("abort", cancel);
      await this.transport.close();
    }
  }
}

class JsonRpcTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: unknown) => void;
    }
  >();
  readonly #notifications: RpcNotification[] = [];
  #notificationWaiter: {
    resolve: (notification: RpcNotification) => void;
    reject: (error: unknown) => void;
  } | null = null;
  #buffer = "";
  #nextId = 1;
  #closed = false;
  #stderr = "";

  public constructor(
    command: Command,
    options: { cwd: string; environment: Record<string, string> },
  ) {
    this.#child = spawn(command.command, command.args, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#receive(chunk));
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-8_192);
    });
    this.#child.on("error", (error) => this.#fail(error));
    this.#child.on("close", (code, signal) => {
      if (!this.#closed && (code !== 0 || signal !== null)) {
        this.#fail(
          new Error(
            `ACP agent exited with ${signal ?? `code ${code ?? 1}`}${this.#stderr.trim() === "" ? "" : `: ${this.#stderr.trim()}`}`,
          ),
        );
      }
    });
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (this.#closed)
      return Promise.reject(new Error("ACP transport is closed."));
    const id = this.#nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
    if (timeoutMs <= 0) return promise;
    return withTimeout(promise, timeoutMs, `${method} timed out.`);
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.#closed) return;
    this.#write({ jsonrpc: "2.0", method, params });
  }

  nextNotification(): Promise<RpcNotification> {
    const notification = this.#notifications.shift();
    if (notification !== undefined) return Promise.resolve(notification);
    return new Promise<RpcNotification>((resolve, reject) => {
      this.#notificationWaiter = { resolve, reject };
    });
  }

  takeNotification(): RpcNotification | undefined {
    return this.#notifications.shift();
  }

  clearNotificationWaiter(): void {
    const waiter = this.#notificationWaiter;
    this.#notificationWaiter = null;
    waiter?.reject(new Error("ACP notification wait ended."));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("ACP transport closed.");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#notificationWaiter?.reject(error);
    this.#notificationWaiter = null;
    if (!this.#child.killed) {
      this.#child.kill();
    }
  }

  #write(message: Record<string, unknown>): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.#fail(new Error("ACP agent emitted invalid JSON."));
        return;
      }
      if (!isRecord(message)) {
        this.#fail(new Error("ACP agent emitted an invalid JSON-RPC message."));
        return;
      }
      if (typeof message["id"] === "number") {
        const pending = this.#pending.get(message["id"]);
        if (pending === undefined) continue;
        this.#pending.delete(message["id"]);
        const error = message["error"];
        if (isRecord(error)) {
          pending.reject(
            new Error(String(error["message"] ?? "ACP request failed.")),
          );
        } else {
          pending.resolve(isRecord(message["result"]) ? message["result"] : {});
        }
      } else if (typeof message["method"] === "string") {
        const notification = message as unknown as RpcNotification;
        if (this.#notificationWaiter !== null) {
          const waiter = this.#notificationWaiter;
          this.#notificationWaiter = null;
          waiter.resolve(notification);
        } else {
          this.#notifications.push(notification);
        }
      }
    }
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#notificationWaiter?.reject(error);
    this.#notificationWaiter = null;
  }
}

function mapAcpUpdate(
  sessionId: string,
  update: Record<string, unknown>,
): EngineEvent {
  const type = update["type"];
  if (type === "tool_call" || type === "tool_call_update") {
    return {
      type: "item.completed",
      thread_id: sessionId,
      item: {
        type: "command_execution",
        command:
          typeof update["tool"] === "string" ? update["tool"] : "acp-tool",
        aggregated_output: JSON.stringify(update),
      },
    };
  }
  return { type: "worker.event", thread_id: sessionId, event: update };
}

export function parseEngineCommand(value: string): Command {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current !== "") {
        parts.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  if (quote !== null)
    throw new CodexSecurityError("Unclosed quote in --engine-command.");
  if (current !== "") parts.push(current);
  const command = parts.shift();
  if (command === undefined)
    throw new CodexSecurityError("--engine-command must not be empty.");
  return { command, args: parts };
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
