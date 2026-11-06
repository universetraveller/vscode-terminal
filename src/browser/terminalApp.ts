/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, toDisposable } from '@vscode-source/base/common/lifecycle.js';
import { localize } from '@vscode-source/nls.js';
import { paneIds, PaneLayout, removePane, splitPane } from '../common/layout.js';
import { TerminalAction, TerminalBridge, TerminalConfiguration } from '../common/terminalApp.js';
import { TerminalView } from './terminalView.js';
import { themes } from './themes.generated.js';
import '@xterm/xterm/css/xterm.css';
import './terminalApp.css';

interface TerminalGroup {
	id: string;
	layout: PaneLayout;
	activeId: string;
	element: HTMLElement;
	tab: HTMLButtonElement;
	title: HTMLElement;
	tabContainer: HTMLElement;
	disposables: DisposableStore;
	layoutDisposables: DisposableStore;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
	const result = document.createElement(tag);
	result.className = className;
	if (text !== undefined) {
		result.textContent = text;
	}
	return result;
}

class TerminalApplication extends Disposable {
	private readonly tabs = element('div', 'tabs');
	private readonly workspace = element('main', 'workspace');
	private readonly profilePicker = element('select', 'profile-picker');
	private readonly status = element('span', 'status-location');
	private readonly message = element('span', 'status-message');
	private readonly findBar = element('div', 'find-bar');
	private readonly findInput = element('input', 'find-input');
	private readonly groups: TerminalGroup[] = [];
	private readonly views = new Map<string, TerminalView>();
	private readonly systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
	private activeGroup: TerminalGroup | undefined;
	private settingsDialog: HTMLDialogElement | undefined;
	private configuration: TerminalConfiguration;
	private lastError = false;

	constructor(private readonly bridge: TerminalBridge, configuration: TerminalConfiguration) {
		super();
		this.configuration = configuration;
		const toolbar = element('header', 'toolbar');
		this.tabs.setAttribute('role', 'tablist');
		this.tabs.setAttribute('aria-label', localize('terminalApp.tabs', "Terminals"));
		this.profilePicker.setAttribute('aria-label', localize('terminalApp.profile', "Shell Profile"));
		const actions = element('div', 'toolbar-actions');
		actions.append(
			this.profilePicker,
			this.button(localize('terminalApp.new', "New"), () => this.newTab()),
			this.button(localize('terminalApp.splitRight', "Split Right"), () => this.split('horizontal')),
			this.button(localize('terminalApp.splitDown', "Split Down"), () => this.split('vertical')),
			this.button(localize('terminalApp.find', "Find"), () => this.showFind()),
			this.button(localize('terminalApp.settings', "Settings"), () => this.showSettings())
		);
		toolbar.append(this.tabs, actions);
		this.findInput.type = 'search';
		this.findInput.placeholder = localize('terminalApp.findPlaceholder', "Find in Terminal");
		this.findInput.setAttribute('aria-label', this.findInput.placeholder);
		this.findBar.hidden = true;
		this.findBar.append(this.findInput, this.button(localize('terminalApp.previous', "Previous"), () => this.search(true)), this.button(localize('terminalApp.next', "Next"), () => this.search(false)), this.button(localize('terminalApp.closeFind', "Close"), () => this.hideFind()));
		this.listen(this.findInput, 'input', () => this.search(false));
		this.listen(this.findInput, 'keydown', event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this.search(event.shiftKey);
			} else if (event.key === 'Escape') {
				this.hideFind();
			}
		});
		const footer = element('footer', 'status-bar');
		this.message.setAttribute('role', 'status');
		this.message.setAttribute('aria-live', 'polite');
		footer.append(this.status, this.message);
		document.body.append(toolbar, this.findBar, this.workspace, footer);
		this._register(toDisposable(bridge.onEvent(event => this.views.get(event.id)?.handleEvent(event))));
		this._register(toDisposable(bridge.onAction(action => this.handleAction(action))));
		this._register(toDisposable(bridge.onConfiguration(configuration => {
			this.configuration = configuration;
			this.updateProfiles();
			this.applyTheme();
		})));
		const themeListener = () => this.applyTheme();
		this.systemTheme.addEventListener('change', themeListener);
		this._register(toDisposable(() => this.systemTheme.removeEventListener('change', themeListener)));
		this.listen(document, 'keydown', event => this.handleKeydown(event), this._store, true);
		this._register(toDisposable(() => {
			for (const view of this.views.values()) {
				view.dispose();
			}
			for (const group of this.groups) {
				group.disposables.dispose();
			}
		}));
		this.updateProfiles();
		this.applyTheme();
		this.newTab(configuration.profile);
	}

	private listen<K extends keyof HTMLElementEventMap>(target: HTMLElement | Document, type: K, listener: (event: HTMLElementEventMap[K]) => void, store: DisposableStore = this._store, capture = false): void {
		target.addEventListener(type, listener as EventListener, capture);
		store.add(toDisposable(() => target.removeEventListener(type, listener as EventListener, capture)));
	}

	private button(label: string, onClick: () => void, store: DisposableStore = this._store): HTMLButtonElement {
		const button = element('button', 'action', label);
		button.type = 'button';
		this.listen(button, 'click', onClick, store);
		return button;
	}

	private get activeView(): TerminalView | undefined {
		return this.activeGroup ? this.views.get(this.activeGroup.activeId) : undefined;
	}

	private updateProfiles(): void {
		const previous = this.profilePicker.value;
		this.profilePicker.replaceChildren(...this.configuration.profiles.map(profile => {
			const option = element('option', '', profile.name);
			option.value = profile.name;
			return option;
		}));
		this.profilePicker.value = this.configuration.profiles.some(profile => profile.name === previous) ? previous : this.configuration.settings.defaultProfile || this.configuration.profiles[0]?.name || '';
	}

	private newTab(profile?: string): void {
		const id = crypto.randomUUID();
		const disposables = new DisposableStore();
		const group: TerminalGroup = {
			id,
			layout: { type: 'terminal', id },
			activeId: id,
			element: element('div', 'terminal-group'),
			tab: element('button', 'tab'),
			title: element('span', 'tab-title'),
			tabContainer: element('div', 'tab-container'),
			disposables,
			layoutDisposables: disposables.add(new DisposableStore())
		};
		group.tab.setAttribute('role', 'tab');
		group.tab.id = `tab-${id}`;
		group.element.id = `group-${id}`;
		group.element.setAttribute('role', 'tabpanel');
		group.element.setAttribute('aria-labelledby', group.tab.id);
		group.tab.setAttribute('aria-controls', group.element.id);
		group.tab.append(group.title);
		this.listen(group.tab, 'click', () => this.selectGroup(group), disposables);
		this.listen(group.tab, 'keydown', event => {
			if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
				event.preventDefault();
				this.cycleTab(event.key === 'ArrowLeft' ? -1 : 1);
				this.activeGroup?.tab.focus();
			}
		}, disposables);
		const close = this.button('×', () => this.closeGroup(group), disposables);
		close.className = 'tab-close';
		close.setAttribute('aria-label', localize('terminalApp.closeTab', "Close Terminal Tab"));
		group.tabContainer.append(group.tab, close);
		this.tabs.append(group.tabContainer);
		this.workspace.append(group.element);
		this.groups.push(group);
		const cwd = this.activeView?.cwd || this.configuration.cwd;
		this.createView(group, id, profile || this.profilePicker.value, cwd);
		this.renderLayout(group);
		this.selectGroup(group);
	}

	private createView(group: TerminalGroup, id: string, profile: string, cwd: string): void {
		group.title.textContent = profile;
		const view = new TerminalView(id, profile, cwd, this.configuration.settings, this.bridge,
			() => {
				group.activeId = id;
				this.updateFocus();
			},
			title => {
				if (group.activeId === id) {
					group.title.textContent = title;
					this.updateFocus();
				}
			},
			() => this.closeView(group, id),
			message => this.showMessage(message, true)
		);
		this.views.set(id, view);
	}

	private split(direction: 'horizontal' | 'vertical'): void {
		const group = this.activeGroup;
		if (!group) {
			return;
		}
		const id = crypto.randomUUID();
		this.createView(group, id, this.profilePicker.value, this.activeView?.cwd || this.configuration.cwd);
		group.layout = splitPane(group.layout, group.activeId, id, direction);
		group.activeId = id;
		this.renderLayout(group);
		this.selectGroup(group);
	}

	private renderLayout(group: TerminalGroup): void {
		group.layoutDisposables.clear();
		const render = (layout: PaneLayout): HTMLElement => {
			if (layout.type === 'terminal') {
				return this.views.get(layout.id)!.element;
			}
			const container = element('div', `split ${layout.direction}`);
			const first = element('div', 'split-child');
			const second = element('div', 'split-child');
			const separator = element('div', 'split-separator');
			separator.setAttribute('role', 'separator');
			separator.setAttribute('aria-label', localize('terminalApp.resizePanes', "Resize Terminal Panes"));
			separator.setAttribute('aria-orientation', layout.direction === 'horizontal' ? 'vertical' : 'horizontal');
			separator.setAttribute('aria-valuemin', '10');
			separator.setAttribute('aria-valuemax', '90');
			separator.tabIndex = 0;
			const resize = (ratio: number) => {
				layout.ratio = Math.max(0.1, Math.min(0.9, ratio));
				first.style.flex = `${layout.ratio} 1 0`;
				second.style.flex = `${1 - layout.ratio} 1 0`;
				separator.setAttribute('aria-valuenow', String(Math.round(layout.ratio * 100)));
			};
			resize(layout.ratio);
			this.listen(separator, 'pointerdown', event => {
				separator.setPointerCapture(event.pointerId);
				event.preventDefault();
			}, group.layoutDisposables);
			this.listen(separator, 'pointermove', event => {
				if (separator.hasPointerCapture(event.pointerId)) {
					const bounds = container.getBoundingClientRect();
					resize(layout.direction === 'horizontal' ? (event.clientX - bounds.left) / bounds.width : (event.clientY - bounds.top) / bounds.height);
				}
			}, group.layoutDisposables);
			this.listen(separator, 'pointerup', event => separator.releasePointerCapture(event.pointerId), group.layoutDisposables);
			this.listen(separator, 'keydown', event => {
				if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
					event.preventDefault();
					resize(layout.ratio + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -0.05 : 0.05));
				}
			}, group.layoutDisposables);
			first.append(render(layout.first));
			second.append(render(layout.second));
			container.append(first, separator, second);
			return container;
		};
		group.element.replaceChildren(render(group.layout));
		for (const id of paneIds(group.layout)) {
			this.views.get(id)!.start();
		}
		this.applyTheme();
	}

	private selectGroup(group: TerminalGroup): void {
		this.activeGroup = group;
		for (const candidate of this.groups) {
			const active = candidate === group;
			candidate.element.hidden = !active;
			candidate.tab.setAttribute('aria-selected', String(active));
			candidate.tab.tabIndex = active ? 0 : -1;
			candidate.tabContainer.classList.toggle('active', active);
			for (const id of paneIds(candidate.layout)) {
				this.views.get(id)?.setVisible(active);
			}
		}
		this.updateFocus();
		this.activeView?.focus();
	}

	private updateFocus(): void {
		for (const [id, view] of this.views) {
			view.element.classList.toggle('focused', id === this.activeGroup?.activeId);
		}
		this.status.textContent = this.activeView?.cwd || this.configuration.cwd;
		this.status.title = this.status.textContent;
		document.title = this.activeGroup ? localize('terminalApp.windowTitle', "{0} — Terminal OSS", this.activeGroup.title.textContent || this.activeView?.profile) : 'Terminal OSS';
	}

	private async closeView(group: TerminalGroup, id: string): Promise<boolean> {
		if (!await this.bridge.confirmClose(id)) {
			return false;
		}
		const layout = removePane(group.layout, id);
		await this.bridge.send({ type: 'close', id });
		this.views.get(id)?.dispose();
		this.views.delete(id);
		if (!layout) {
			const index = this.groups.indexOf(group);
			if (index < 0) {
				return false;
			}
			this.groups.splice(index, 1);
			group.disposables.dispose();
			group.element.remove();
			group.tabContainer.remove();
			if (this.groups.length === 0) {
				window.close();
			} else {
				this.selectGroup(this.groups[Math.min(index, this.groups.length - 1)]);
			}
		} else {
			group.layout = layout;
			if (group.activeId === id) {
				group.activeId = paneIds(layout)[0];
			}
			this.renderLayout(group);
			if (group === this.activeGroup) {
				this.selectGroup(group);
			}
		}
		return true;
	}

	private async closeGroup(group: TerminalGroup): Promise<void> {
		for (const id of paneIds(group.layout)) {
			if (!await this.closeView(group, id)) {
				break;
			}
		}
	}

	private cycleTab(direction: number): void {
		if (this.activeGroup) {
			this.selectGroup(this.groups[(this.groups.indexOf(this.activeGroup) + direction + this.groups.length) % this.groups.length]);
		}
	}

	private applyTheme(): void {
		const name = this.configuration.settings.theme === 'system' ? this.systemTheme.matches ? 'dark' : 'light' : this.configuration.settings.theme;
		document.documentElement.dataset.theme = name;
		const theme = themes[name];
		for (const [id, color] of Object.entries(theme.colors)) {
			document.documentElement.style.setProperty(`--vscode-${id.replaceAll('.', '-')}`, color);
		}
		for (const view of this.views.values()) {
			view.applySettings(this.configuration.settings, theme.terminal);
		}
	}

	private showMessage(message: string, error = false): void {
		this.lastError = error;
		this.message.textContent = message;
		this.message.classList.toggle('error', error);
	}

	private showFind(): void {
		this.findBar.hidden = false;
		this.findInput.focus();
		this.findInput.select();
	}

	private hideFind(): void {
		this.findBar.hidden = true;
		this.findInput.value = '';
		this.activeView?.find('').catch(() => {});
		if (!this.lastError) {
			this.showMessage('');
		}
		this.activeView?.focus();
	}

	private async search(previous: boolean): Promise<void> {
		try {
			const found = await this.activeView?.find(this.findInput.value, previous);
			this.showMessage(this.findInput.value && !found ? localize('terminalApp.noMatches', "No matches") : '');
		} catch (error) {
			this.showMessage(String(error), true);
		}
	}

	private handleAction(action: TerminalAction): void {
		switch (action) {
			case 'newTab': this.newTab(); break;
			case 'splitRight': this.split('horizontal'); break;
			case 'splitDown': this.split('vertical'); break;
			case 'closeTerminal': if (this.activeGroup) { this.closeView(this.activeGroup, this.activeGroup.activeId); } break;
			case 'find': this.showFind(); break;
			case 'settings': this.showSettings(); break;
			case 'nextTab': this.cycleTab(1); break;
			case 'previousTab': this.cycleTab(-1); break;
			case 'clear': this.activeView?.terminal.clear(); break;
			case 'copy': {
				const editingControl = document.activeElement?.closest('dialog') || document.activeElement === this.findInput;
				const selection = editingControl ? undefined : this.activeView?.terminal.getSelection();
				if (selection) {
					this.bridge.writeClipboard(selection).catch(error => this.showMessage(String(error), true));
				} else {
					document.execCommand('copy');
				}
				break;
			}
			case 'paste': this.bridge.readClipboard().then(text => {
				if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement && document.activeElement.closest('dialog')) {
					document.execCommand('insertText', false, text);
				} else {
					this.activeView?.terminal.paste(text);
				}
			}).catch(error => this.showMessage(String(error), true)); break;
		}
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (this.settingsDialog?.open) {
			return;
		}
		const modifier = this.configuration.platform === 'darwin' ? event.metaKey : event.ctrlKey && event.altKey;
		if (modifier && /^[1-9]$/.test(event.key)) {
			const group = this.groups[Number(event.key) - 1];
			if (group) {
				event.preventDefault();
				event.stopPropagation();
				this.selectGroup(group);
			}
		} else if (modifier && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
			event.preventDefault();
			event.stopPropagation();
			this.activeView?.navigateCommand(event.key === 'ArrowUp');
		} else if (event.ctrlKey && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && this.activeGroup) {
			event.preventDefault();
			event.stopPropagation();
			const ids = paneIds(this.activeGroup.layout);
			this.activeGroup.activeId = ids[(ids.indexOf(this.activeGroup.activeId) + (event.key === 'ArrowLeft' ? -1 : 1) + ids.length) % ids.length];
			this.updateFocus();
			this.activeView?.focus();
		}
	}

	private showSettings(): void {
		if (this.settingsDialog?.open) {
			return;
		}
		const store = new DisposableStore();
		const dialog = element('dialog', 'settings-dialog');
		this.settingsDialog = dialog;
		const heading = element('h2', '', localize('terminalApp.settings', "Settings"));
		heading.id = 'settings-heading';
		dialog.setAttribute('aria-labelledby', heading.id);
		const form = element('form', 'settings-form');
		const controls = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
		const settings = this.configuration.settings;
		const field = (key: keyof typeof settings, label: string, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
			control.setAttribute('aria-label', label);
			const row = element('label', 'settings-field', label);
			row.append(control);
			form.append(row);
			controls.set(key, control);
		};
		for (const [key, label, min, max] of [
			['fontSize', localize('terminalApp.fontSize', "Font Size"), 8, 40],
			['scrollback', localize('terminalApp.scrollback', "Scrollback Lines"), 0, 50000]
		] as const) {
			const input = element('input', '');
			input.type = 'number';
			input.min = String(min);
			input.max = String(max);
			input.required = true;
			input.value = String(settings[key]);
			field(key, label, input);
		}
		const font = element('input', '');
		font.value = settings.fontFamily;
		font.required = true;
		field('fontFamily', localize('terminalApp.fontFamily', "Font Family"), font);
		const theme = element('select', '');
		for (const [name, label] of [['system', localize('terminalApp.systemTheme', "System")], ['dark', localize('terminalApp.darkTheme', "Dark")], ['light', localize('terminalApp.lightTheme', "Light")]]) {
			const option = element('option', '', label);
			option.value = name;
			theme.append(option);
		}
		theme.value = settings.theme;
		field('theme', localize('terminalApp.theme', "Theme"), theme);
		const defaultProfile = element('select', '');
		for (const profile of this.configuration.profiles) {
			const option = element('option', '', profile.name);
			option.value = profile.name;
			defaultProfile.append(option);
		}
		defaultProfile.value = settings.defaultProfile || this.configuration.profiles[0]?.name;
		field('defaultProfile', localize('terminalApp.defaultProfile', "Default Shell Profile"), defaultProfile);
		for (const [key, label] of [
			['gpuAcceleration', localize('terminalApp.gpuAcceleration', "GPU Acceleration")],
			['shellIntegration', localize('terminalApp.shellIntegration', "Shell Integration for New Terminals")],
			['confirmOnClose', localize('terminalApp.confirmOnClose', "Confirm Before Closing Running Commands")]
		] as const) {
			const input = element('input', '');
			input.type = 'checkbox';
			input.checked = settings[key];
			field(key, label, input);
		}
		const profiles = element('textarea', 'profile-settings');
		profiles.value = JSON.stringify(settings.profiles, null, 2);
		profiles.rows = 4;
		profiles.spellcheck = false;
		field('profiles', localize('terminalApp.customProfiles', "Custom Shell Profiles (JSON)"), profiles);
		const error = element('p', 'settings-error');
		error.setAttribute('role', 'alert');
		const buttons = element('div', 'dialog-actions');
		buttons.append(this.button(localize('terminalApp.cancel', "Cancel"), () => dialog.close(), store));
		const save = element('button', 'action primary', localize('terminalApp.save', "Save"));
		save.type = 'submit';
		buttons.append(save);
		form.append(error, buttons);
		this.listen(form, 'submit', event => {
			event.preventDefault();
			try {
				const input = (key: string) => controls.get(key) as HTMLInputElement;
				const next = {
					fontFamily: input('fontFamily').value,
					fontSize: Number(input('fontSize').value),
					scrollback: Number(input('scrollback').value),
					theme: theme.value as typeof settings.theme,
					defaultProfile: defaultProfile.value,
					gpuAcceleration: input('gpuAcceleration').checked,
					shellIntegration: input('shellIntegration').checked,
					confirmOnClose: input('confirmOnClose').checked,
					profiles: JSON.parse(profiles.value)
				};
				save.disabled = true;
				this.bridge.saveSettings(next).then(() => dialog.close()).catch(reason => {
					error.textContent = String(reason);
					save.disabled = false;
				});
			} catch (reason) {
				error.textContent = String(reason);
			}
		}, store);
		this.listen(dialog, 'close', () => {
			store.dispose();
			dialog.remove();
			this.settingsDialog = undefined;
			this.activeView?.focus();
		}, store);
		dialog.append(heading, form);
		document.body.append(dialog);
		dialog.showModal();
	}
}

declare const terminalApp: TerminalBridge;
const bridge = terminalApp;
bridge.initialize().then(configuration => {
	const application = new TerminalApplication(bridge, configuration);
	window.addEventListener('beforeunload', () => application.dispose(), { once: true });
}).catch(error => {
	const message = element('p', 'startup-error', localize('terminalApp.startupError', "Could not start the terminal: {0}", String(error)));
	message.setAttribute('role', 'alert');
	document.body.append(message);
});
