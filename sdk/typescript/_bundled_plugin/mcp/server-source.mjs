import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";
const CLI_COMMAND = process.env.CODEX_SECURITY_CLI_PATH || "codex-security";

const tools = [
  {
    name: "scan_repository",
    description: "Run a Codex Security scan against a repository.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string", description: "Repository root." },
        paths: { type: "array", items: { type: "string" } },
        engine: { type: "string", enum: ["codex", "claude", "acp"] },
        engineCommand: { type: "string" },
        model: { type: "string" },
        mode: { type: "string", enum: ["standard", "deep"] },
        outputDir: { type: "string" },
      },
      required: ["repository"],
      additionalProperties: false,
    },
  },
  {
    name: "scan_diff",
    description: "Run a Codex Security scan against repository changes.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string", description: "Repository root." },
        base: { type: "string" },
        head: { type: "string" },
        workingTree: { type: "boolean" },
        engine: { type: "string", enum: ["codex", "claude", "acp"] },
        engineCommand: { type: "string" },
        model: { type: "string" },
        outputDir: { type: "string" },
      },
      required: ["repository"],
      additionalProperties: false,
    },
  },
  {
    name: "export_results",
    description: "Export completed scan findings as JSON, CSV, or SARIF.",
    inputSchema: {
      type: "object",
      properties: {
        scanDir: { type: "string" },
        format: { type: "string", enum: ["csv", "json", "sarif"] },
        sourceRoot: { type: "string" },
      },
      required: ["scanDir"],
      additionalProperties: false,
    },
  },
  {
    name: "validate_finding",
    description: "Validate one or more candidate security findings.",
    inputSchema: {
      type: "object",
      properties: {
        findings: { type: "array", items: { type: "string" } },
      },
      required: ["findings"],
      additionalProperties: false,
    },
  },
];

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function requiredString(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function cliArgs(name, args) {
  if (name === "scan_repository") {
    const result = ["scan", requiredString(args, "repository"), "--format", "json"];
    for (const path of args.paths ?? []) result.push("--path", requiredString({ path }, "path"));
    if (args.engine !== undefined) result.push("--engine", requiredString(args, "engine"));
    if (args.engineCommand !== undefined) result.push("--engine-command", requiredString(args, "engineCommand"));
    if (args.model !== undefined) result.push("--model", requiredString(args, "model"));
    if (args.mode !== undefined) result.push("--mode", requiredString(args, "mode"));
    if (args.outputDir !== undefined) result.push("--output-dir", requiredString(args, "outputDir"));
    return result;
  }
  if (name === "scan_diff") {
    const result = ["scan", requiredString(args, "repository"), "--format", "json"];
    if (args.workingTree === true) result.push("--working-tree");
    else if (args.base !== undefined) {
      result.push("--diff", requiredString(args, "base"));
      if (args.head !== undefined) result.push("--head", requiredString(args, "head"));
    } else throw new Error("scan_diff requires workingTree or base.");
    if (args.engine !== undefined) result.push("--engine", requiredString(args, "engine"));
    if (args.engineCommand !== undefined) result.push("--engine-command", requiredString(args, "engineCommand"));
    if (args.model !== undefined) result.push("--model", requiredString(args, "model"));
    if (args.outputDir !== undefined) result.push("--output-dir", requiredString(args, "outputDir"));
    return result;
  }
  if (name === "export_results") {
    const result = ["export", requiredString(args, "scanDir"), "--export-format", args.format ?? "sarif", "--output", "-"];
    if (args.sourceRoot !== undefined) result.push("--source-root", requiredString(args, "sourceRoot"));
    return result;
  }
  return ["validate", ...(args.findings ?? []), "--format", "json"];
}

function runTool(name, args, progressToken) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(CLI_COMMAND, cliArgs(name, args), {
      cwd: args.repository ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (progressToken !== undefined) {
        send({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken, progress: stderr.length, message: chunk.trim() },
        });
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Codex Security exited with code ${code ?? 1}.`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function handle(request) {
  if (request.method === "notifications/initialized") return;
  if (request.method === "initialize") {
    send(response(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "codex-security", version: "0.1.0" },
    }));
    return;
  }
  if (request.method === "tools/list") {
    send(response(request.id, { tools }));
    return;
  }
  if (request.method !== "tools/call") {
    send(errorResponse(request.id, -32601, `Unsupported method ${request.method}.`));
    return;
  }
  const params = object(request.params);
  const name = params?.name;
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    send(errorResponse(request.id, -32602, `Unknown tool ${String(name)}.`));
    return;
  }
  const args = object(params.arguments) ?? {};
  try {
    const result = await runTool(name, args, params._meta?.progressToken);
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = result.stdout;
    }
    send(response(request.id, {
      content: [{ type: "text", text: typeof parsed === "string" ? parsed : JSON.stringify(parsed) }],
      structuredContent: typeof parsed === "object" ? parsed : undefined,
      isError: false,
    }));
  } catch (error) {
    send(response(request.id, {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    }));
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (line.trim() === "") continue;
  try {
    await handle(JSON.parse(line));
  } catch (error) {
    send(errorResponse(null, -32700, error instanceof Error ? error.message : String(error)));
  }
}
