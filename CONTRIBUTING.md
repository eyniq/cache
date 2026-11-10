# Contributing to Eyniq Cache

Thanks for your interest. Please open an issue before starting a larger change, so we can agree on the approach.

## Development setup

Requirements: Node.js 26 (see `.nvmrc`) and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm check              # typecheck, lint, format check and all tests
pnpm test:unit | test:integration | test:concurrency
pnpm build && PUBLIC_URL=http://localhost:4873 FS_ROOT=./.data pnpm start
```

`CLAUDE.md` and `docs/DESIGN.md` describe the layout and the rules of the code base.

## Rules

- Tests first: add or change a test that fails without your change.
- Zero runtime dependencies: `src/` imports only `node:*` built-ins and relative files. A new runtime dependency needs an entry in `docs/DEPENDENCIES.md` and maintainer approval.
- The cache-hit hot path must not parse JSON or run policy code.
- Changes touching HTTP, storage, authentication or policy get a security review; say in the pull request what you considered.
- Keep `pnpm check` green.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, ...), in English.
- Keep a pull request to one logical change and fill in the pull request template.

## Contributor License Agreement

Eyniq Cache is source-available under FSL-1.1-ALv2. Contributions are accepted under the [Contributor License Agreement](CLA.md). When you open your first pull request, the CLA Assistant bot asks you to sign by commenting `I have read the CLA Document and I hereby sign the CLA`. You only sign once.

## Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
