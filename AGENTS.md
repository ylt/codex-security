# Repository Guidelines

## Project Structure & Module Organization

The repository contains the Codex Security plugin and its TypeScript SDK/CLI.

- `sdk/typescript/src/` contains the public SDK, CLI, runtime, scan contract, and engine implementations.
- `sdk/typescript/src/engine/` contains the Codex/Claude engine abstraction and provider-specific logic.
- `sdk/typescript/tests-ts/` contains Bun-based TypeScript tests (25 files — see key ones below).
- `sdk/typescript/_bundled_plugin/` contains the `.codex-plugin/` and `.claude-plugin/` manifests, Python workbench scripts (~30 files), JSON schemas, 13 agent skills, 11 reference docs, and the readable MCP server source.
- `sdk/typescript/scripts/` contains package-checking and smoke-test utilities.
- Root files such as `Dockerfile`, `compose.yaml`, and `SECURITY.md` cover packaging and deployment.

## Dual-Engine Architecture

This is a security scanning CLI and SDK with a dual-engine design: Codex (default) and Claude (selectable via `--engine claude`, `CODEX_SECURITY_ENGINE=claude`, or `config.engine: "claude"`).

Engine selection precedence: `--engine` CLI flag > `CODEX_SECURITY_ENGINE` env var > `"codex"`.

| Engine | Auth | SDK |
|--------|------|-----|
| Codex | `codex login` / `OPENAI_API_KEY` / `CODEX_API_KEY` | `@openai/codex-sdk` + `@openai/codex` binary |
| Claude | `ANTHROPIC_API_KEY` env / `~/.codex-security/auth.json` | `@anthropic-ai/sdk` |

The engine abstraction lives in `src/engine/`:
- `types.ts` — `ScanEngine`, `EngineThread`, `EngineEvent`, `EngineAuth` interfaces
- `index.ts` — `createEngine()` factory
- `codex-engine.ts` — CodexEngine wrapping `@openai/codex-sdk`
- `claude-engine.ts` — ClaudeEngine using `@anthropic-ai/sdk`
- `claude-auth.ts` — Anthropic API key file storage

Key integration point: `api.ts` constructs the engine and calls `createScanSession()` which returns an `EngineThread`. The thread's `runStreamed()` produces an `AsyncGenerator<EngineEvent>` consumed by `runScanEvents()` — both engines produce the same event contract.

## Build, Test, and Development Commands

Run commands from `sdk/typescript/`:

```sh
pnpm install                    # Install locked dependencies
pnpm run types                  # Validate TypeScript types
pnpm test                       # Run the Bun test suite
pnpm test -- --test-name-pattern "auth"  # Run a single test file
pnpm run build                  # Clean and emit dist/
pnpm run lint                   # tsc --noEmit (alias for types)
pnpm run format                 # Check Prettier formatting
pnpm run check:package <tgz>    # Validate npm tarball
pnpm run clean                  # Remove dist/
```

CI runs: install → types → test → format → build → pack → check:package.

For local CLI work, build first, then run `node dist/cli.js --help` or the `bin/codex-security.mjs` launcher.

## Scan Lifecycle

1. CLI parses args → `CodexSecurity.run(repo, options)`
2. Validate inputs (target, output dir, git repo)
3. Select engine (`codex`/`claude`) and check auth
4. Register scan via Python workbench (`register-cli-scan`)
5. Build environment (env vars for workbench scripts)
6. Call `engine.createScanSession()` → get `EngineThread`
7. Call `thread.runStreamed(prompt)` → get event stream
8. `runScanEvents()` processes events → validates output via `contract.ts` → returns `ScanResult`
9. Finalize scan via Python workbench (`complete-scan` / `fail-scan`)

## Coding Style & Naming Conventions

Use TypeScript with strict compiler settings, ES modules, two-space indentation,
and Prettier formatting. Use `camelCase` for variables/functions,
`PascalCase` for classes/types, and kebab-case for CLI option names and files.
Prefer existing error classes and typed interfaces over ad hoc errors or
provider-specific types leaking into shared scan code.

## Testing Guidelines

Tests use Bun and are named `*.test.ts` under `tests-ts/`. Add focused tests for
new engine behavior, CLI parsing, authentication, event translation, and
package metadata. Preserve existing Codex tests when extending shared paths;
run the full suite before submitting changes.

Key test files:
- `api.test.ts` / `api-events.test.ts` — core scan lifecycle and events
- `cli.test.ts` / `cli-authentication.test.ts` — CLI routing and auth
- `contract.test.ts` — schema validation
- `runtime.test.ts` — plugin/workbench execution
- `scan-comparison.test.ts` — finding matching across scans

## Commit & Pull Request Guidelines

Use concise imperative commit subjects with conventional prefixes, for example
`feat: implement Claude tool loop` or `fix: preserve Codex compatibility`.
Keep commits focused and checkpoint substantial work. Pull requests should
describe behavioral changes, identify affected CLI/SDK surfaces, list commands
run and their results, and call out authentication, package, or schema changes.

## Key Constraints

- ESM-only package (`"type": "module"`, `import`/`export`)
- `@openai/codex` ships platform-specific binaries resolved by `runtime.ts`'s `resolveCodexCommand()`
- Output directory must be outside the scanned repo and enclosing Git worktree
- Python 3.10+ required for scanning and exporting (`PYTHON` env var, `--python` flag, or `pythonPath` config)

## Security & Configuration Tips

Never commit API keys, generated credentials, `dist/`, tarballs, or local agent
state. Codex uses its existing login/API-key flow; Claude credentials are
resolved by the Anthropic SDK or `ANTHROPIC_API_KEY`. Preserve credential
redaction, isolated runtime directories, protected output-root checks, and
schema validation when changing scan orchestration.
