# Dependencies

## Runtime dependencies

None. Eyniq Cache runs on Node.js 26+ built-ins only (`node:http`, `node:crypto`, `node:worker_threads`, `node:fs`, `node:stream`, the bundled `fetch`/undici).

Adding a runtime dependency requires an entry below with a written justification (why a built-in or a small amount of own code is not enough, maintenance and supply-chain risk, licence) and maintainer approval before merging. `test/unit/repo-rules.test.ts` and the ESLint config fail the build when `src/` imports anything other than `node:` built-ins or relative files.

| Package | Version | Justification | Approved |
| ------- | ------- | ------------- | -------- |
| (none)  |         |               |          |

## Development dependencies

Allowed without approval; never shipped in the container image.

| Package                                     | Purpose                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `typescript`                                | Compiler (pinned to 6.0.x: typescript-eslint 8 does not support 6.1+ yet) |
| `@types/node`                               | Node 26 type definitions (major pinned to the minimum supported runtime)  |
| `vitest`, `@vitest/coverage-v8`             | Tests and coverage                                                        |
| `eslint`, `@eslint/js`, `typescript-eslint` | Linting, including the adapter-boundary and no-runtime-dependency rules   |
| `prettier`                                  | Formatting                                                                |
