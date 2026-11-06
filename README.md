<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->

# Terminal OSS

An independent terminal application that reuses VS Code's terminal components from a pinned Git submodule. Application code, build tooling, dependency installation, tests and releases belong to this repository. Upstream VS Code stays unmodified under `vendor/vscode` and is a build-time source dependency; users do not install that source tree.

Two modes are available:

| Mode | Runtime | Updates |
| --- | --- | --- |
| Standalone application | Its own Electron, xterm and PTY host; no installed editor required | Build and release against a tested VS Code submodule revision |
| [Installed VS Code companion](docs/companion.md) | Small launcher and extension using a separate installed VS Code instance | Uses the installed terminal/runtime version after a full restart |

The standalone application supports local shells, tabs, nested resizable splits, profiles, search, themes, clipboard operations, and VS Code shell integration with working directory tracking and command navigation. It has its own settings and windows, with no dependency on an editor window. See [standalone usage and limitations](docs/standalone.md) and the [initial resource baseline](docs/BASELINE.md).

## Checkout and run

```sh
git clone --recurse-submodules https://github.com/universetraveller/vscode-terminal.git
cd vscode-terminal
# Use the Node version in .nvmrc.
corepack pnpm install --frozen-lockfile
corepack pnpm start
```

For an existing checkout, initialize the pinned source with `git submodule update --init --depth 1 vendor/vscode`. The submodule is shallow by default. Do not install VS Code's dependencies or compile the full product; only the terminal's focused dependencies are installed at this repository's root.

```sh
corepack pnpm start -- --cwd /path/to/project
corepack pnpm companion -- --cwd /path/to/project
```

The companion requires installed VS Code 1.141 or later. Standalone settings live in `Terminal OSS` under the OS configuration directory; the companion has a separate `Terminal OSS Companion` profile. Both accept `--user-data-dir` to select another private profile.

## Repository layout

```text
src/                    Terminal application and companion adapter
scripts/                Focused build, sync, package and GUI validation tools
test/                   Application, isolation and repository-boundary tests
companion/              Launcher and extension templates
docs/                   Usage, upstream update procedure and resource baseline
vendor/vscode/          Unmodified, pinned Git submodule
upstream.json           Reviewed VS Code revision and version
package.json            This application's dependencies and commands
pnpm-lock.yaml          This application's reproducible dependency lock
```

`@vscode-source/*` imports resolve into the submodule through the root TypeScript configuration. The build bundles the upstream modules it uses and copies the matching shell integration scripts and native dependencies into `.build/terminal/app`. It fails if editor/workbench, sessions, or agent host JavaScript enters the standalone runtime. The build also rejects tracked upstream modifications and source/dependency pin mismatches.

## Validate and package

```sh
corepack pnpm check
corepack pnpm test
corepack pnpm companion:check
corepack pnpm companion:test
corepack pnpm smoke
corepack pnpm package
corepack pnpm companion:package
```

The GUI checks use disposable profiles. `pnpm smoke -- --inspect-ui` pauses after the initial screenshot for inspection. Linux needs a display, such as `xvfb-run`. `pnpm benchmark` records the standalone resource sample; `pnpm companion:smoke` checks the installed VS Code mode. Build artifacts, reports and screenshots stay under `.build/terminal` and are ignored by Git. Packaged apps contain the runtime files they need, not the full source submodule.

The `Terminal` workflow runs cached, focused Linux checks for routine pushes and PRs, skipping the Electron binary download. Manual runs with **full platform validation** enabled and `v*` release tags additionally test real shells and package on macOS, Windows and Linux. macOS ARM64 is the locally validated GUI platform. Signing, notarization, installers and an application update feed remain release work; local packages are unsigned development artifacts.

## Updating VS Code

The **Upstream Sync** workflow checks VS Code `main` weekly and can be run manually for a branch, tag, or commit. It opens one update PR, synchronizes source/dependency pins and the lockfile, and dispatches focused checks. Unchanged revisions and pending update PRs exit after metadata checks; source history, VS Code development dependencies, and Electron binaries are not downloaded by the polling step. Updates are reviewed before merging.

Use the [upstream update procedure](docs/UPSTREAM.md) for automation details or to select an update locally. The application repository does not merge the VS Code repository's history. Builds use a fixed revision, never a moving branch tip.

Source separation reduces fork maintenance and makes releases independent. It does not remove Electron's baseline resource cost or guarantee compatibility with every future upstream internal API change. Existing source copyright and license notices are preserved; see `LICENSE.txt` and the upstream license in `vendor/vscode/LICENSE.txt`.
