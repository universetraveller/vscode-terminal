# Terminal OSS Agent Instructions

Application source belongs in `src/`, build tools in `scripts/`, and focused tests in `test/`. VS Code is an unmodified Git submodule at `vendor/vscode`, pinned by its gitlink and `upstream.json`. Do not put application changes inside the submodule. Import upstream source with the `@vscode-source/*` alias.

Use tabs, preserve Microsoft copyright/license headers on reused code, localize user-facing strings, and register disposables immediately. Keep the standalone runtime free of editor/workbench, extension host, sessions, and agent host modules. The companion adapter uses public VS Code extension APIs.

Use pnpm and the versions in `.nvmrc` and `package.json`. Run `pnpm check`, `pnpm test`, `pnpm companion:check`, and `pnpm companion:test` for relevant changes. GUI checks are `pnpm smoke` and `pnpm companion:smoke`; they use disposable profiles. Do not install or compile all of VS Code. Never share or symlink `node_modules` from another checkout. See `docs/UPSTREAM.md` for updating the submodule and dependency pins together.
