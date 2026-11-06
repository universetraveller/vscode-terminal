<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->

# Terminal OSS

Terminal OSS offers a standalone application and a small companion launcher that reuses installed VS Code. The [companion guide](companion.md) covers the runtime-sharing option: a separate VS Code instance with terminal-focused normal windows, an isolated profile, and no bundled Electron or terminal runtime. Closing your regular editor does not close that instance.

The standalone application described below is an independent desktop terminal built from this VS Code checkout. It starts its own Electron application, renderer, settings directory, and shared PTY host. No editor window or installed VS Code application is required.

This first version supports local shells, tabs, nested resizable splits, profiles, terminal search, dark/light/system themes, font and scrollback settings, clipboard operations, and VS Code shell integration with working directory tracking and command navigation. It reuses upstream `TerminalProcess`, `TerminalDataBufferer`, `ShellIntegrationAddon`, terminal capabilities, shell injection scripts, and the same xterm.js versions as the checkout.

## Run

Use the repository's Node version and pinned pnpm through Corepack. The terminal has a separate dependency install; the full VS Code development install and compile are unnecessary.

```sh
corepack pnpm install
corepack pnpm start
```

Pass a starting directory, profile, or separate settings directory after `--`:

```sh
corepack pnpm start -- --cwd /path/to/project
```

The application stores its own `settings.json` in `Terminal OSS` under the OS application data directory. `--user-data-dir=/path/to/profile` overrides that location and also isolates single-instance behavior. It never loads VS Code settings, extensions, or workspaces. The Settings dialog edits the terminal's own preferences and custom shell profiles. Font, theme, and scrollback changes apply immediately; shell integration changes apply to new terminals.

Custom profile example:

```json
{
	"name": "Project Shell",
	"path": "/bin/zsh",
	"args": ["-l"],
	"cwd": "/path/to/project",
	"env": { "PROJECT_ENV": "development", "REMOVE_THIS_VARIABLE": null }
}
```

On macOS, use Command+T for a new terminal, Command+D to split right, Command+Shift+D to split down, and Command+W to close a terminal. Windows/Linux use Control+Shift+T, Control+Shift+D, Control+Shift+Alt+D, and Control+Shift+W. Control+Tab cycles tabs. Control+Shift+Left/Right moves between split panes. Command+1–9 on macOS or Control+Alt+1–9 on Windows/Linux selects a tab. Command+Up/Down on macOS or Control+Alt+Up/Down on Windows/Linux navigates detected commands. The native File menu opens independent terminal windows.

## Validate and package

```sh
corepack pnpm check
corepack pnpm test
corepack pnpm smoke
corepack pnpm package
```

The smoke test launches a real application in a disposable profile. It checks keyboard input, Bash and system-shell integration, search, nested splits, settings persistence, ownership restrictions between windows, that closed terminals terminate their shell processes, and that closing one window preserves the other window's existing shell PID. It also streams output past the scrollback limit in an inactive tab. `--inspect-ui` pauses after taking the initial screenshot; press Enter to continue. Linux GUI tests require a display, such as `xvfb-run` in CI.

Build output lives under `.build/terminal/`. `app/` contains the focused application payload. `packages/` contains a platform-specific distributable, including Electron. The initial packaging target builds for the current OS and architecture. Signing, notarization, installers, and a hosted application update feed are release work; locally generated packages are unsigned development artifacts.

The build writes `build-report.json` with the upstream commit, dependency versions, output sizes, and included upstream source modules. It fails if editor, workbench, sessions, or agent host JavaScript enters the runtime bundles. Theme values are extracted from upstream files at build time, so the theme registries and editor services are not shipped. Only the target platform's node-pty prebuild is copied into the application. The small, already-bundled application payload is packaged as real files so shells can source integration scripts and native helpers can run without relying on Electron's virtual archive filesystem.

`smoke-report.json` and screenshots under `evidence/` describe the latest GUI validation. For a repeatable resource sample with one and ten terminals and sustained output in a background tab:

```sh
corepack pnpm benchmark
```

To measure the packaged application, run the same harness against its executable. On macOS:

```sh
node scripts/smoke.mjs --benchmark --packaged ".build/terminal/packages/Terminal OSS-darwin-arm64/Terminal OSS.app/Contents/MacOS/terminal-oss"
```

`benchmark-report.json` records the conditions, startup time, idle CPU, process working sets, and background output completion time. Working set sums include shared resident pages counted by multiple processes and exclude the shells and their commands. The harness adds automation overhead. These are regression samples, not private-memory measurements or guarantees for every machine. Electron/Chromium accounts for most installed size and baseline memory even when the terminal payload is small. The same shared PTY host and renderer serve every tab in a window; inactive tabs release their WebGL renderer while continuing to parse and acknowledge terminal output. Scrollback defaults to 2,000 lines and is configurable.

## Receive upstream updates

VS Code is pinned as an unmodified Git submodule in `vendor/vscode`. Follow [the upstream update procedure](UPSTREAM.md) to select a revision, synchronize dependency pins, validate and release. Application source lives in `src/`, build tools in `scripts/`, and tests in `test/`. No full VS Code development install or build is required. Installing a new VS Code binary does not update this standalone application.

## Initial scope

The first version intentionally hosts local terminal sessions. VS Code extension-provided terminals, editor/file links, Remote SSH/WSL integration services, tasks/debugging, and session restoration after application exit are not part of this build. Ordinary shell commands such as `ssh`, `tmux`, and `wsl.exe` can still run when available. These features can be added explicitly, with their runtime and dependency costs measured. macOS ARM64 is the first locally validated platform; the workflow provides validation coverage for the other platform builds.
