import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const pluginRoot = join(import.meta.dir, "../_bundled_plugin");
const children: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

describe("bundled Claude compatibility", () => {
  test("ships Codex and Claude manifests with shared skills and MCP config", async () => {
    const [codex, claude, mcp, contract] = await Promise.all([
      readFile(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
      readFile(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8"),
      readFile(join(pluginRoot, ".mcp.json"), "utf8"),
      readFile(join(import.meta.dir, "../plugin-files.json"), "utf8"),
    ]);
    expect(JSON.parse(codex).name).toBe("codex-security");
    expect(JSON.parse(claude)).toMatchObject({
      name: "codex-security",
      skills: "../skills/",
      mcpServers: "../.mcp.json",
    });
    expect(JSON.parse(mcp).mcpServers["codex-security"].env_vars).toContain(
      "ANTHROPIC_API_KEY",
    );
    expect(JSON.parse(contract).shippedExact).toContain(
      ".claude-plugin/plugin.json",
    );
  });

  test("launches the bundled MCP runtime over stdio", async () => {
    const child = spawn(
      process.execPath,
      [join(pluginRoot, "mcp/server.mjs")],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.push(child);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      })}\n`,
    );
    const output = await new Promise<string>((resolve, reject) => {
      let value = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        value += chunk;
        if (value.includes("\n")) resolve(value.split("\n", 1)[0] ?? "");
      });
      child.once("error", reject);
    });
    expect(JSON.parse(output).result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "codex-security" },
    });
  });
});
