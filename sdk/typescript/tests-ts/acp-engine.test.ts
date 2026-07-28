import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { AcpEngine } from "../src/engine/acp-engine.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fakeAgent(mode = "normal"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-security-acp-"));
  temporaryDirectories.push(root);
  const script = join(root, "agent.mjs");
  await writeFile(
    script,
    `
import readline from "node:readline";
const mode = ${JSON.stringify(mode)};
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  const message = JSON.parse(line);
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: mode === "mismatch" ? "wrong" : "2025-03-26", capabilities: {} } });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
  } else if (message.method === "session/prompt") {
    if (mode === "hang") continue;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", event: { type: "agent_message_chunk", text: "hello" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", event: { type: "tool_call", tool: "workbench", args: {} } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "endTurn" } });
  } else if (message.method === "session/cancel") {
    process.exit(0);
  }
}
`,
  );
  return script;
}

describe("ACP engine", () => {
  test("performs handshake, creates a session, and maps streamed updates", async () => {
    const script = await fakeAgent();
    const engine = new AcpEngine(
      { type: "acp", engineCommand: `${process.execPath} "${script}"` },
      {},
    );
    const thread = await engine.createScanSession({
      env: process.env as Record<string, string>,
      workingDirectory: "/tmp",
      repositoryDirectory: "/tmp",
    });
    const { events } = await thread.runStreamed("scan", {
      signal: AbortSignal.timeout(5_000),
    });
    const collected = [];
    for await (const event of events) collected.push(event);
    expect(collected.map((event) => event.type)).toEqual([
      "thread.started",
      "worker.event",
      "item.completed",
      "item.completed",
      "turn.completed",
    ]);
    expect(collected[1]?.["event"]).toMatchObject({
      type: "agent_message_chunk",
    });
    expect(collected[2]?.["item"]).toMatchObject({ type: "command_execution" });
    expect(collected[3]?.["item"]).toMatchObject({
      type: "agent_message",
      text: "hello",
    });
  });

  test("rejects an incompatible protocol version", async () => {
    const script = await fakeAgent("mismatch");
    const engine = new AcpEngine(
      { type: "acp", engineCommand: `${process.execPath} "${script}"` },
      {},
    );
    await expect(
      engine.createScanSession({ env: {}, workingDirectory: "/tmp" }),
    ).rejects.toThrow("unsupported protocol version");
  });

  test("requires an ACP command", async () => {
    const engine = new AcpEngine({ type: "acp" }, {});
    await expect(
      engine.createScanSession({ env: {}, workingDirectory: "/tmp" }),
    ).rejects.toThrow("--engine-command");
  });

  test("cancels and kills an in-flight prompt", async () => {
    const script = await fakeAgent("hang");
    const engine = new AcpEngine(
      { type: "acp", engineCommand: `${process.execPath} "${script}"` },
      {},
    );
    const thread = await engine.createScanSession({
      env: process.env as Record<string, string>,
      workingDirectory: "/tmp",
    });
    const controller = new AbortController();
    const { events } = await thread.runStreamed("scan", {
      signal: controller.signal,
    });
    const first = await events.next();
    expect(first.value?.type).toBe("thread.started");
    controller.abort(new Error("cancelled by test"));
    await expect(events.next()).rejects.toThrow("cancelled by test");
  });
});
