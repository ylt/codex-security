# codex-security

> **Fork of [`@openai/codex-security`](https://github.com/openai/codex-security)** —
> a dual-engine security scanning CLI and SDK supporting both Codex and Claude
> as scan backends.

**What's different from the upstream:**
- **Dual-engine** — select engine with `--engine codex` (default) or `--engine claude`
- **Claude engine** — `@anthropic-ai/sdk` integration with `ANTHROPIC_API_KEY` auth
- **Scan comparison** — finding matching via Claude when using `--engine claude`
- Renamed to `codex-security` (Claude + Codex portmanteau)
- Private fork — not published to npm

## Quick start

Requires Node.js 22+, Python 3.10+, and credentials for your chosen engine.

```bash
# Codex (default)
npx codex-security login
npx codex-security scan /path/to/repo

# Claude
ANTHROPIC_API_KEY=sk-... npx codex-security --engine claude scan .
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
