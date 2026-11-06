<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->

# Updating the VS Code source dependency

`vendor/vscode` is a Git submodule whose URL is recorded in `.gitmodules`. Its gitlink pins the source revision when this application repository is committed. `upstream.json` records the reviewed commit and version for builds and diagnostics. The application owns its own `package.json`, pnpm lockfile, Node version and release process. Neither an installed VS Code update nor a fetch changes this source pin automatically.

## Initialize the reviewed revision

```sh
git submodule update --init --depth 1 vendor/vscode
corepack pnpm install --frozen-lockfile
corepack pnpm upstream:check
```

The first two commands also work after cloning the application without `--recurse-submodules`. No dependency installation or full build is required inside the submodule.

## Weekly automation and costs

The **Upstream Sync** workflow runs Mondays at 09:17 UTC. Its default source is VS Code `main`, matching the original development snapshot. Use **Actions → Upstream Sync → Run workflow** to select another branch, tag, or commit. Its initial step reads GitHub metadata before checking out VS Code or installing packages. It stops if the selected SHA is already pinned, an update PR is awaiting review, or that exact revision was already offered and closed.

When a candidate is needed, the workflow fetches shallow source snapshots, synchronizes the source and dependency pins, and refreshes only the application lockfile with `pnpm install --lockfile-only --ignore-scripts`. It does not compile all of VS Code, install its dependencies, or download an Electron binary. A unique `automation/vscode-<sha>` branch is pushed without force, and one PR is opened. A branch left by an interrupted run is reused; maintainer commits are preserved. The workflow does not merge or approve PRs.

Routine `Terminal` validation uses one Linux runner with a cached pnpm store, type checks, focused tests, and builds; `ELECTRON_SKIP_BINARY_DOWNLOAD=1` avoids Electron's binary download. Full macOS/Windows/Linux GUI and package validation runs on `v*` tags or a manual `Terminal` run with **full platform validation** enabled. Run the full checks before releasing an upstream update. This keeps routine synchronization inexpensive while preserving an explicit path to platform validation.

Automation uses the repository-scoped `GITHUB_TOKEN`; no personal token secret is required. The repository's **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests** setting must be enabled for PR creation. Default permissions can remain read-only; only the sync job requests contents, PR, and workflow-dispatch write permissions. The job explicitly dispatches the candidate's focused checks because [GitHub treats workflow-generated events differently from manual dispatch](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs).

If a candidate is incompatible, add adapter fixes to its PR or close it. Future runs leave an open candidate alone and do not recreate a closed candidate for the same SHA. The next upstream revision can be proposed after that PR is resolved. GitHub may disable schedules on public repositories after 60 days without repository activity; see [scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Select and validate an update

Work on an application integration branch, and choose an explicit upstream tag or commit:

```sh
git switch -c update-vscode
git -C vendor/vscode fetch --depth 1 origin <tag-or-commit>
git -C vendor/vscode checkout --detach FETCH_HEAD
corepack pnpm sync-upstream
# Switch to .nvmrc's Node version if the update changed it.
corepack pnpm install
corepack pnpm check
corepack pnpm test
corepack pnpm companion:check
corepack pnpm companion:test
corepack pnpm smoke
corepack pnpm package
corepack pnpm companion:package
corepack pnpm benchmark
```

`sync-upstream` records the selected commit/version in `upstream.json` and synchronizes Electron, xterm and its addons, node-pty, Windows native helpers, and shared build/type dependencies from upstream manifests and exact locked versions. It also synchronizes `.nvmrc`. It does not fetch, choose a revision, resolve compatibility failures, or publish a release. `pnpm install` updates this application's lockfile when dependency versions change.

Review adapter changes and resource reports before recording the update:

```sh
git diff --submodule=short
git add vendor/vscode upstream.json package.json pnpm-lock.yaml .nvmrc
# Include reviewed adapter or tooling fixes as appropriate.
git commit -m "Update VS Code terminal source dependency"
```

Keep the source gitlink, recorded revision, shell scripts, native dependencies and JavaScript package versions together. Ordinary application changes happen outside `vendor/vscode`, so no upstream merge conflict is needed for those files. Internal API changes may still require fixes in `src/browser/terminalView.ts`, `src/node/terminalHost.ts`, or the build-time theme extractor. VS Code terminal UI features are not automatically ported into the application's custom UI.

## Working with patches or reverting

The build rejects tracked modifications inside the source dependency. Prefer adapting the application through `@vscode-source/*` imports. If an upstream patch is necessary, commit it to an intentional VS Code fork, make that commit available from the submodule URL, update `.gitmodules` and `upstream.json` if the repository changes, and rerun synchronization and validation. Do not leave required patches as uncommitted edits in a submodule: other developers and CI would not receive them.

To return the source checkout to the revision recorded by the application, first make sure any intentional submodule work is saved, then run `git submodule update --init vendor/vscode`. To undo a committed update, revert its application commit and run the same command, then install the corresponding locked dependencies. The independent repository can be moved as a whole; its submodule Git metadata lives under its own `.git/modules/` and has no Git object-store dependency on the original fork.
