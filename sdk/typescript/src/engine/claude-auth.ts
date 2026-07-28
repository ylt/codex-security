import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginBootstrapError } from "../errors.js";

const authDirectory = () => join(homedir(), ".codex-security");
const authPath = () => join(authDirectory(), "auth.json");

export async function readClaudeApiKey(
  environment: Record<string, string | undefined>,
): Promise<string | null> {
  const fromEnvironment = environment["ANTHROPIC_API_KEY"]?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    const parsed: unknown = JSON.parse(await readFile(authPath(), "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "anthropicApiKey" in parsed &&
      typeof parsed.anthropicApiKey === "string" &&
      parsed.anthropicApiKey.trim()
    )
      return parsed.anthropicApiKey.trim();
  } catch {}
  return null;
}

export async function saveClaudeApiKey(apiKey: string): Promise<void> {
  if (!apiKey.trim())
    throw new PluginBootstrapError("The Anthropic API key must be non-empty.");
  await mkdir(authDirectory(), { recursive: true, mode: 0o700 });
  await chmod(authDirectory(), 0o700);
  await writeFile(
    authPath(),
    `${JSON.stringify({ anthropicApiKey: apiKey.trim() })}\n`,
    { mode: 0o600 },
  );
  await chmod(authPath(), 0o600);
}

export async function removeClaudeApiKey(): Promise<void> {
  await rm(authPath(), { force: true });
}
