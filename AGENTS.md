# Repository Guidelines

## Project Structure & Module Organization
- Source: `src/` with key areas `agents/`, `server/`, `db/`, `llm/`, `lib/`, `cli/`, `frontend/`, `types/`.
- Tests: `tests/` (e.g., `tests/integration/`, `tests/bridge/`) plus a few root-level `test-*.ts` utilities.
- Server entry: `src/server/index.ts` (Hono HTTP + WS). CLI demos in `src/cli/`.
- Data: SQLite at `data.db` (ignored by Git). Env files: `.env`, `.env.example`.

## Build, Test, and Development Commands
- `bun install`: install dependencies.
- `bun run dev` or `bun run dev:backend`: start the API/WS server (defaults to `PORT=3000`).
- `bun run dev:frontend`: serve `src/frontend/watch/index.html` on port 3001 for quick UI iteration.
- `bun test` / `bun run test:watch`: run tests (preloads `tests/setup.ts` via `bunfig.toml`).
- `bun run typecheck`: TypeScript checks with strict settings.
- `bun run clean`: remove local SQLite artifacts (`data.db*`).

## Coding Style & Naming Conventions
- Language: TypeScript (ES modules). Strict compiler options enabled (`noImplicitAny`, `strictNullChecks`, etc.).
- Indentation: 2 spaces; keep lines focused and readable.
- Naming: kebab-case files (`ws-run-auto-convo.ts`), PascalCase for types/components, camelCase for variables/functions.
- Imports: prefer named exports; use path alias `$src/*` when appropriate.

## Testing Guidelines
- Runner: Bun test. Organize by feature under `tests/**`; root `test-*.ts` helpers are OK.
- Add unit tests for utilities and integration tests for orchestration, WS, and CLI flows.
- Naming: prefer descriptive filenames (e.g., `orchestrator.claim-turn.test.ts` or `tests/integration/ws-conversation.ts`).
- Run `bun test` and `bun run typecheck` before pushing.

## Commit & Pull Request Guidelines
- Commits: short, imperative subject lines; include scope when helpful (e.g., "server: claim-turn expiry").
- PRs: include summary, rationale, linked issues, reproduction steps/CLI commands, and screenshots for UI changes.
- Requirements: green `bun test`, passing `bun run typecheck`, and no stray database or `.env` changes.

## Security & Configuration Tips
- Configure `.env` from `.env.example` (keys: `DB_PATH`, `PORT`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`). Do not commit secrets or databases.
- Local data: use `bun run clean` to reset. Prefer synthetic scenarios over real PHI/PII.
- See `README.md` for architecture and scenario concepts before extending agents or routes.

