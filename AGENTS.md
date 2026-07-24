# Repository Guidelines

## Project Structure

InkOS is a pnpm workspace containing three TypeScript packages:

- `packages/core/` — agents, LLM providers, pipelines, state management, models, and built-in genres in `genres/`.
- `packages/cli/` — the `inkos` Commander.js CLI and terminal UI in `src/commands/` and `src/tui/`.
- `packages/studio/` — the web workbench, API routes, pages, components, and client state.

Tests live beside implementation in `*.test.ts` files and `src/__tests__/`. Shared maintenance and release scripts are in `scripts/`; images and other static files are in `assets/`.

## Build, Test, and Development Commands

Use Node.js 20+ and pnpm 9+; Node 22 is the repository default (`.nvmrc`). From `inkos/`:

```bash
pnpm install --frozen-lockfile  # Install exact locked dependencies
pnpm dev                        # Run package development/watch processes
pnpm build                      # Build every workspace package
pnpm test                       # Run all Vitest suites
pnpm typecheck                  # Type-check all packages without emitting
```

Target a package when iterating: `pnpm --filter @actalk/inkos-core test` or `pnpm --filter @actalk/inkos test`. Run `pnpm audit:semantic-patterns` when changing semantic or prompt-sensitive behavior.

## Coding Style and Naming

Use strict TypeScript with two-space indentation, ES modules, and descriptive camelCase identifiers. Prefer immutable updates such as `{ ...value, key: nextValue }` over mutation. Keep functions under roughly 50 lines and files under 800 lines where practical. Do not swallow errors; a catch that intentionally suppresses an error must explain why. Use kebab-case filenames for new modules, matching nearby code.

## Testing Guidelines

Vitest is the test framework. Name tests `<subject>.test.ts` and place them next to the source or in the package `src/__tests__/` directory. New behavior should include tests. Mock LLM calls for pipeline-related tests; never make real API requests. Before opening a PR, run `pnpm build`, `pnpm test`, and `pnpm typecheck`.

## Commits and Pull Requests

Use atomic commits in the form `<type>: <description>`; common types are `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, and `ci`. PRs should explain the change and motivation, identify affected files, link related issues, and call out breaking changes. Complete the PR template’s test plan and include manual verification details or screenshots for UI changes. Keep diffs focused and avoid unrelated formatting.

For each completed task, branch from the latest `upstream/master` as `codex/<task-slug>`. After relevant checks pass, stage only task-owned files, push to `origin`, and open a PR against `master`. Never auto-merge, force-push, or commit `.env`, `.inkos/`, `test-project/`, secrets, or generated writing output.

## Configuration and Publishing

Copy `.env.example` to `.env` for local credentials, and never commit secrets. Keep publishable package manifests free of `workspace:*`; use registry-installable internal versions and verify with `pnpm verify:publish-manifests`.
