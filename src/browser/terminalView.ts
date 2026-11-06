/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Terminal, type ITheme } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { SearchAddon } from '@xterm/addon-search';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '@vscode-source/base/common/lifecycle.js';
import { NullLogService } from '@vscode-source/platform/log/common/log.js';
import { TerminalCapability } from '@vscode-source/platform/terminal/common/capabilities/capabilities.js';
import { ShellIntegrationAddon } from '@vscode-source/platform/terminal/common/xterm/shellIntegrationAddon.js';
import type { IXtermCore } from '@vscode-source/workbench/contrib/terminal/browser/xterm-private.js';
import { localize } from '@vscode-source/nls.js';
import { TerminalBridge, TerminalEvent, TerminalSettings } from '../common/terminalApp.js';

/** The only frontend adapter to upstream xterm and VS Code shell integration APIs. */
export class TerminalView extends Disposable {
	readonly element = document.createElement('section');
	readonly content = document.createElement('div');
	readonly terminal: Terminal;
	readonly shellIntegration: ShellIntegrationAddon;
	private readonly titleElement = document.createElement('span');
	private readonly commandDecorations = this._register(new DisposableMap<number, DisposableStore>());
	private readonly capabilityListeners = this._register(new DisposableMap<TerminalCapability, DisposableStore>());
	private readonly webgl = this._register(new MutableDisposable<DisposableStore>());
	private readonly logService = this._register(new NullLogService());
	private searchPromise: Promise<SearchAddon> | undefined;
	private settings: TerminalSettings;
	private started = false;
	private visible = false;
	private gpuGeneration = 0;
	private layoutFrame: number | undefined;
	private readonly nonce = crypto.randomUUID();
	private title: string;
	cwd: string;
	exited = false;

	constructor(
		readonly id: string,
		readonly profile: string,
		cwd: string,
		settings: TerminalSettings,
		private readonly bridge: TerminalBridge,
		private readonly onFocus: () => void,
		private readonly onTitle: (title: string) => void,
		onClose: () => void,
		private readonly onError: (message: string) => void
	) {
		super();
		this.settings = settings;
		this.cwd = cwd;
		this.title = profile;
		this.element.className = 'terminal-pane';
		this.element.dataset.sessionId = id;
		this.element.setAttribute('role', 'group');
		this.element.setAttribute('aria-label', localize('terminalApp.terminalLabel', "Terminal: {0}", profile));
		const header = document.createElement('header');
		header.className = 'pane-header';
		this.titleElement.textContent = profile;
		const close = document.createElement('button');
		close.className = 'pane-close';
		close.textContent = '×';
		close.setAttribute('aria-label', localize('terminalApp.closePane', "Close Terminal"));
		close.addEventListener('click', onClose);
		this._register(toDisposable(() => close.removeEventListener('click', onClose)));
		header.append(this.titleElement, close);
		this.content.className = 'terminal-content';
		this.element.append(header, this.content);
		this.element.addEventListener('pointerdown', onFocus);
		this._register(toDisposable(() => this.element.removeEventListener('pointerdown', onFocus)));
		this.terminal = this._register(new Terminal({
			allowProposedApi: true,
			fontFamily: settings.fontFamily,
			fontSize: settings.fontSize,
			scrollback: settings.scrollback,
			cursorBlink: false,
			disableStdin: true,
			macOptionIsMeta: true,
			minimumContrastRatio: 4.5,
			cols: 80,
			rows: 24
		}));
		this.shellIntegration = new ShellIntegrationAddon(this.nonce, true, undefined, undefined, this.logService);
		this.terminal.loadAddon(this.shellIntegration);
		this.terminal.loadAddon(new Unicode11Addon());
		this.terminal.unicode.activeVersion = '11';
		this._register(this.terminal.onData(data => {
			if (!this.exited) {
				for (let offset = 0; offset < data.length;) {
					let end = Math.min(offset + 65536, data.length);
					if (end < data.length && data.charCodeAt(end - 1) >= 0xD800 && data.charCodeAt(end - 1) <= 0xDBFF) {
						end--; // Keep a UTF-16 surrogate pair together when native writes encode each chunk.
					}
					this.send({ type: 'input', id: this.id, data: data.slice(offset, end) });
					offset = end;
				}
			}
		}));
		this._register(this.terminal.onTitleChange(title => this.setTitle(title)));
		this._register(this.shellIntegration.onDidChangeStatus(status => this.element.dataset.shellIntegration = String(status)));
		this._register(this.shellIntegration.capabilities.onDidAddCapability(event => {
			const listeners = new DisposableStore();
			this.capabilityListeners.set(event.id, listeners);
			if (event.id === TerminalCapability.CwdDetection) {
				listeners.add(event.capability.onDidChangeCwd(cwd => {
					if (event.capability.isTrusted) {
						this.cwd = cwd;
						this.element.dataset.cwd = cwd;
						this.titleElement.title = cwd;
						this.onTitle(this.title);
					}
				}));
			} else if (event.id === TerminalCapability.CommandDetection) {
				listeners.add(event.capability.onCommandFinished(command => {
					if (!command.marker || command.marker.isDisposed) {
						return;
					}
					const decoration = this.terminal.registerDecoration({ marker: command.marker, x: 0, width: 1 });
					if (decoration) {
						const store = new DisposableStore();
						this.commandDecorations.set(command.marker.id, store);
						store.add(decoration);
						store.add(decoration.onRender(element => {
							element.className = command.exitCode ? 'command-mark failed' : 'command-mark';
						}));
						store.add(decoration.onDispose(() => {
							// xterm owns this disposal. Do not reenter it while its emitter is firing.
							store.deleteAndLeak(decoration);
							this.commandDecorations.deleteAndDispose(command.marker!.id);
						}));
					}
				}));
			}
		}));
		this._register(this.shellIntegration.capabilities.onDidRemoveCapability(event => this.capabilityListeners.deleteAndDispose(event.id)));
		const observer = new ResizeObserver(() => this.scheduleLayout());
		this._register(toDisposable(() => observer.disconnect()));
		observer.observe(this.content);
		this._register(toDisposable(() => {
			if (this.layoutFrame !== undefined) {
				cancelAnimationFrame(this.layoutFrame);
			}
			this.gpuGeneration++;
			this.element.remove();
		}));
	}

	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.terminal.open(this.content);
		const textarea = this.terminal.textarea;
		if (textarea) {
			const onFocus = () => this.onFocus();
			textarea.addEventListener('focus', onFocus);
			this._register(toDisposable(() => textarea.removeEventListener('focus', onFocus)));
		}
		this.fit();
		this.send({ type: 'create', id: this.id, profile: this.profile, cwd: this.cwd, cols: this.terminal.cols, rows: this.terminal.rows, nonce: this.nonce });
	}

	private send(request: Parameters<TerminalBridge['send']>[0]): void {
		this.bridge.send(request).catch(error => this.onError(error instanceof Error ? error.message : String(error)));
	}

	private setTitle(title: string): void {
		this.title = title || this.profile;
		this.titleElement.textContent = this.title;
		this.element.setAttribute('aria-label', localize('terminalApp.terminalLabel', "Terminal: {0}", this.title));
		this.onTitle(this.title);
	}

	handleEvent(event: TerminalEvent): void {
		if (event.type === 'data') {
			// Acknowledge only after xterm parses the data. This preserves upstream PTY backpressure.
			this.terminal.write(event.data, () => {
				if (!this._store.isDisposed) {
					this.send({ type: 'acknowledge', id: this.id, count: event.data.length });
				}
			});
		} else if (event.type === 'ready') {
			this.terminal.options.disableStdin = false;
			if (event.windowsPty) {
				this.terminal.options.windowsPty = event.windowsPty;
			}
			this.element.dataset.pid = String(event.pid);
			this.element.dataset.cwd = event.cwd;
		} else if (event.type === 'title') {
			this.setTitle(event.title);
		} else if (event.type === 'exit' || event.type === 'error') {
			this.exited = true;
			this.element.dataset.exited = 'true';
			this.terminal.options.disableStdin = true;
			this.terminal.writeln('\r\n' + (event.type === 'exit' ? localize('terminalApp.processExited', "Process exited with code {0}.", event.code) : event.message));
			if (event.type === 'error') {
				this.onError(event.message);
			}
		}
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) {
			return;
		}
		this.visible = visible;
		this.updateGpuRenderer();
		if (visible) {
			this.scheduleLayout();
		}
	}

	applySettings(settings: TerminalSettings, theme: ITheme): void {
		this.settings = settings;
		this.terminal.options.fontFamily = settings.fontFamily;
		this.terminal.options.fontSize = settings.fontSize;
		this.terminal.options.scrollback = settings.scrollback;
		this.terminal.options.theme = theme;
		const viewport = this.content.querySelector<HTMLElement>('.xterm-viewport');
		if (viewport && theme.background) {
			viewport.style.backgroundColor = theme.background;
		}
		this.updateGpuRenderer();
		this.scheduleLayout();
	}

	private updateGpuRenderer(): void {
		const generation = ++this.gpuGeneration;
		if (!this.visible || !this.settings.gpuAcceleration) {
			this.webgl.clear();
			return;
		}
		if (this.webgl.value || !this.started) {
			return;
		}
		import('@xterm/addon-webgl').then(({ WebglAddon }) => {
			if (this._store.isDisposed || generation !== this.gpuGeneration) {
				return;
			}
			const resources = new DisposableStore();
			try {
				const addon = resources.add(new WebglAddon());
				this.terminal.loadAddon(addon);
				resources.add(addon.onContextLoss(() => this.webgl.clear()));
				this.webgl.value = resources;
			} catch {
				resources.dispose(); // The DOM renderer remains usable on systems without WebGL.
			}
		}).catch(() => { /* Keep the DOM renderer when an optional GPU module cannot load. */ });
	}

	private scheduleLayout(): void {
		if (this.layoutFrame === undefined && !this._store.isDisposed) {
			this.layoutFrame = requestAnimationFrame(() => {
				this.layoutFrame = undefined;
				this.fit();
			});
		}
	}

	private fit(): void {
		if (!this.started || !this.content.clientWidth || !this.content.clientHeight) {
			return;
		}
		const core = (this.terminal as Terminal & { _core: IXtermCore })._core;
		const cell = core._renderService.dimensions.css.cell;
		if (!cell.width || !cell.height) {
			return;
		}
		const cols = Math.max(2, Math.min(1000, Math.floor((this.content.clientWidth - (core.viewport?.scrollBarWidth || 14)) / cell.width)));
		const rows = Math.max(1, Math.min(1000, Math.floor(this.content.clientHeight / cell.height)));
		if (cols !== this.terminal.cols || rows !== this.terminal.rows) {
			this.terminal.resize(cols, rows);
			this.send({ type: 'resize', id: this.id, cols, rows });
		}
	}

	async find(value: string, previous = false): Promise<boolean> {
		if (!this.searchPromise) {
			this.searchPromise = import('@xterm/addon-search').then(({ SearchAddon }) => {
				if (this._store.isDisposed) {
					throw new Error('Terminal was closed');
				}
				const addon = new SearchAddon();
				this.terminal.loadAddon(addon);
				return addon;
			});
		}
		const addon = await this.searchPromise;
		if (!value) {
			addon.clearDecorations();
			return false;
		}
		return previous ? addon.findPrevious(value) : addon.findNext(value);
	}

	navigateCommand(previous: boolean): void {
		const commands = this.shellIntegration.capabilities.get(TerminalCapability.CommandDetection)?.commands || [];
		const lines = commands.map(command => command.promptStartMarker?.line ?? command.marker?.line).filter((line): line is number => line !== undefined && line >= 0);
		const viewport = this.terminal.buffer.active.viewportY;
		const target = previous ? lines.reverse().find(line => line < viewport) : lines.find(line => line > viewport);
		this.terminal.scrollToLine(target ?? (previous ? 0 : this.terminal.buffer.active.baseY));
	}

	focus(): void {
		this.terminal.focus();
	}
}
