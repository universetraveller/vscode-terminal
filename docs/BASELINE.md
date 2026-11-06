<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->

# Initial terminal baseline

Measured on macOS ARM64 on November 5, 2026, using the packaged Terminal OSS prototype, Electron 43.8.6, and VS Code base `2286dd4e76ac61e97c35bab7de66a9bf78d4c0de` (1.146.0). This is an initial regression reference, not a resource budget or a comparison with full VS Code.

| Measurement | Result |
| --- | ---: |
| Bundled JavaScript and CSS, including optional chunks | 1.18 MiB |
| Application payload, including native dependencies and notices | 2.18 MiB |
| Packaged files, including Electron | 486.57 MiB |
| Startup to first shell PID in a fresh profile | 2.63 s |
| One terminal: sum of Electron process working sets | 547.41 MiB |
| Ten terminals: sum of Electron process working sets | 588.44 MiB |
| One terminal: sampled idle Electron CPU | 0.29% |
| Ten terminals: sampled idle Electron CPU | 0.42% |
| 100,000 output lines in an inactive tab, through completion marker | 0.31 s |

The runtime sample used GPU acceleration, a 16-point font after the settings test, light theme, 2,000 scrollback lines, a disposable profile, and Playwright automation. The memory figures sum resident working sets across the main, renderer, GPU, network utility, and PTY host processes. They count shared pages in each process and exclude shells and user commands; they are not private-memory measurements. CPU samples also cover Electron processes only. Startup includes automation and a fresh profile. Logical file sizes can differ from allocated disk space.

Ten tabs used one terminal renderer and one shared PTY host. Adding nine tabs increased the measured working-set sum by about 41 MiB in this run. Electron accounts for almost all packaged size and much of the baseline working set. Further reductions should be guided by profiles of the packaged build rather than by removing upstream source files.

The packaged smoke/benchmark run passed keyboard input, Bash and zsh integration, Unicode and ANSI output, search, nested splits, tab switching, settings persistence, ownership isolation between windows, and sustained background output past scrollback limits. It verified with native PID checks that closed terminals terminate their shells, while closing another window preserves the surviving shell's PID and running command. Closing nine of ten tabs terminated their shells. No renderer errors were reported.

Focused adapter tests and the TypeScript check passed. The build rejected editor, workbench, sessions, and agent host modules from its runtime graph. Other operating systems have a validation workflow configured but were not executed locally.

Reproduce with the commands in [standalone usage](standalone.md). Generated raw reports and screenshots live under `.build/terminal/`; a new run replaces them. Re-measure after upstream updates before treating a change as an improvement or regression.

These measurements were recorded before the application was separated into its own repository. They remain a historical reference; run `pnpm benchmark` in the independent repository to record a fresh sample.
