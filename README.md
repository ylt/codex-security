# codex-security

> **Fork of [`@openai/codex-security`](https://github.com/openai/codex-security)** —
> a multi-engine security scanning CLI and SDK supporting Codex, Claude, and
> ACP-compatible agents as scan backends.

**What's different from the upstream:**
- **Multiple engines** — select `codex` (default), `claude`, or `acp`
- **Claude engine** — uses the Anthropic SDK's built-in credential resolution;
  `ANTHROPIC_API_KEY` is optional
- **ACP engine** — connect to an external Agent Client Protocol agent over stdio
- **Scan comparison** — finding matching via Claude when using `--engine claude`
- Renamed to `codex-security` (Claude + Codex portmanteau)
- Private fork — not published to npm

## Quick start

Requires Node.js 22+ and Python 3.10+. Authentication is provided by the
selected engine or its host; an API key is not universally required.

```bash
# Codex (default)
npx codex-security login
npx codex-security scan /path/to/repo

# Claude (Anthropic SDK-managed auth; ANTHROPIC_API_KEY is optional)
npx codex-security scan /path/to/repo --engine claude

# ACP agent (the agent owns its authentication)
npx codex-security scan /path/to/repo --engine acp --engine-command "your-acp-agent"

# The engine and ACP command can also be configured through the environment.
CODEX_SECURITY_ENGINE=acp \
CODEX_SECURITY_ENGINE_COMMAND="your-acp-agent" \
npx codex-security scan /path/to/repo
```

## TypeScript SDK

```ts
import { CodexSecurity } from "@openai/codex-security";

const security = new CodexSecurity();
const result = await security.run(".", {
  outputDir: "/path/outside/repo/results",
});

console.log(result.reportPath);
await security.close();
```

## CLI reference

See [sdk/typescript/README.md](sdk/typescript/README.md) for full CLI documentation,
or run `npx codex-security --help`.
