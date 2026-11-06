<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->

# Installed VS Code companion

This mode reuses an installed VS Code distribution instead of shipping another Electron, xterm, node-pty, or terminal implementation. A small launcher opens a separate VS Code application instance in a private profile. A bundled extension uses public APIs to open and focus the terminal in a maximized panel. Each window is a normal top-level VS Code window. Closing the regular editor or another terminal window does not terminate its shell.

The launcher and adapter payload is about 18 KiB. The installed application provides the runtime files, terminal features, shell integration and terminal fixes. VS Code also generates its own caches and profile data; those are additional disk usage. A full VS Code workbench, extension host, and supporting processes still run, so sharing files does not imply lower RAM or CPU than the standalone build. Empty workspaces, no user extensions, disabled Git/AI features, and 2,000 lines of scrollback keep avoidable work limited. This mode prioritizes disk savings and staying with the installed version. Use the standalone build when removing workbench processes matters more.

## Build and run

Use the focused development dependencies from the root README; no full VS Code source build is needed:

```sh
corepack pnpm install
corepack pnpm companion -- --cwd /path/to/project
```

Requires VS Code 1.141 or later. The default starting directory is your home directory. The launcher discovers the usual stable installation and accepts a custom application or executable path:

```sh
corepack pnpm companion -- --vscode "/Applications/Visual Studio Code.app" --cwd /path/to/project
```

`TERMINAL_OSS_VSCODE` selects a nonstandard installation for both the bootstrap and JavaScript launcher. On Windows, set it to `Code.exe` or its containing installation directory. The Windows bootstrap finds the usual per-user and system installations before its JavaScript launcher processes `--vscode`. On Linux, the bootstrap discovers `code` on `PATH` or accepts an installation directory or executable through this variable.

The generated `.build/terminal/companion/terminal-oss` script (or `terminal-oss.cmd` on Windows) uses VS Code's embedded Node to execute the launcher. End users need no separate Node install. Keep it beside `launcher.cjs` and `extension/`. Use `--dry-run` for a read-only installation/launch plan and `--json` for an acknowledgement containing the installed version and shell PID. `--no-wait` returns once the CLI has opened the window. Developer-only `--cdp-port` enables renderer debugging on a selected port.

```sh
corepack pnpm companion:package
```

On macOS this additionally creates `.build/terminal/companion/Terminal OSS (VS Code).app`, which can be opened from Finder or moved elsewhere. It contains shell/JavaScript launchers and the extension, with no application runtime. Other platforms use the portable launcher directory. macOS ARM64 is the locally validated GUI platform; Linux and Windows launchers have focused build/type/test coverage in CI. Packages are unsigned development artifacts.

## Windows, settings, and isolation

Run the launcher again to open another terminal window in the same companion instance. In a terminal, Command+T (Control+Shift+T elsewhere) opens a new tab, Command+D (Control+Shift+D) splits the terminal, and Command+Shift+N (Control+Shift+N) opens a normal terminal window. Other terminal commands, profiles, preferences, selection, search, and shell integration come directly from installed VS Code. The companion commands appear in the Command Palette under Terminal OSS.

The default private user-data directory is `Terminal OSS Companion` under the OS configuration directory: `~/Library/Application Support` on macOS, `%APPDATA%` on Windows, or `$XDG_CONFIG_HOME`/`~/.config` on Linux. Its `extensions/` and `shared/` directories also belong exclusively to the companion. There is no sharing of your editor's settings, extensions, workspaces or authentication. The launcher refuses a nonempty directory without its ownership marker. `--user-data-dir /path/to/new/profile` creates an alternative isolated companion instance. Portable VS Code distributions whose portable data overrides this isolation are rejected.

Use VS Code's Settings command to change the companion profile. Defaults are seeded once; later launches preserve your changes, including JSONC comments. The launcher refreshes only its own bundled extension files. It never edits the installed VS Code application. Reloading the extension host preserves workbench-owned terminals. Quitting the companion or closing its own terminal window ends the associated shells according to VS Code's normal behavior. It does not promise sessions that survive application exit.

The visible application menu, Dock identity and title bar remain those of installed VS Code. Other workbench commands and panels remain accessible. This mode does not provide a separately branded terminal process or strip editor code out of memory.

## Updates

Update VS Code using its regular installation/update mechanism, then fully quit and relaunch the companion to use the new runtime and terminal version. Its isolated profile disables a second updater so the regular installation manages the shared application. The terminal, Electron, native PTY modules and shell scripts always run together from that installed distribution. No internal modules from this repository are mixed into another version.

The adapter uses `vscode.window.createTerminal`, shell integration's working directory, commands and normal extension storage. It depends on public APIs and documented settings rather than private terminal internals. Future VS Code changes can still require an adapter or default-layout update. This package does not automatically update its own launcher or extension; rebuild it from this repository when those files change. The standalone application's separate upstream-source synchronization process remains available in [the upstream guide](UPSTREAM.md).

## Validate

```sh
corepack pnpm companion:check
corepack pnpm companion:test
corepack pnpm companion:smoke
```

The focused tests check profile ownership, preserving settings, environment/IPC and shared-storage isolation, argument validation, and concurrent request claiming. The GUI harness requires an installed VS Code, uses disposable profiles and unique debug ports, and runs the actual bootstrap using VS Code's Node runtime. It checks shell input and starting directories, splits/tabs, independent normal windows, closing a separate editor instance, extension host restart, and shell cleanup. `--inspect-ui` pauses after its initial screenshot for inspection. Linux requires a display, such as `xvfb-run`; the GUI harness currently supports macOS and Linux.

Build and smoke reports are `.build/terminal/companion-build-report.json` and `companion-smoke-report.json`; screenshots are under `.build/terminal/evidence/companion-*.png`. CI checks the adapter and portable packaging on all three OSes. Installed-VS-Code GUI validation is a separate local check; CI does not download another VS Code distribution for it.
