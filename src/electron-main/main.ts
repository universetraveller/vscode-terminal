/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, MessageChannelMain, shell, utilityProcess, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type UtilityProcess } from 'electron';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { localize } from '@vscode-source/nls.js';
import { defaultSettings, parseSettings } from '../common/settings.js';
import { terminalChannels, TerminalAction, TerminalConfiguration, TerminalSettings } from '../common/terminalApp.js';
import { getProfiles } from '../node/profiles.js';

const applicationName = 'Terminal OSS';
const windows = new Set<BrowserWindow>();
const sessions = new Map<number, Map<string, boolean>>();
const windowConfigurations = new Map<number, TerminalConfiguration>();
const indexUrl = pathToFileURL(join(__dirname, 'index.html')).href;
let configuration: TerminalConfiguration;
let host: UtilityProcess | undefined;
let quitting = false;
let confirmingQuit = false;

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1) || (index >= 0 ? process.argv[index + 1] : undefined);
}

app.setName(applicationName);
app.setPath('userData', argument('--user-data-dir') ? resolve(argument('--user-data-dir')!) : join(app.getPath('appData'), applicationName));
if (process.platform === 'win32') {
	app.setAppUserModelId('org.terminaloss.Terminal');
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => createWindow());
	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') {
			app.quit();
		} else {
			// Do not retain an idle PTY host after the last window closes on macOS.
			host?.kill();
			host = undefined;
		}
	});
	app.on('activate', () => {
		if (windows.size === 0 && configuration) {
			createWindow();
		}
	});
	app.on('before-quit', event => {
		if (quitting) {
			return;
		}
		if (configuration?.settings.confirmOnClose && [...sessions.values()].some(windowSessions => [...windowSessions.values()].some(Boolean))) {
			event.preventDefault();
			if (!confirmingQuit) {
				confirmingQuit = true;
				confirmClosing().then(confirmed => {
					confirmingQuit = false;
					if (confirmed) {
						quitting = true;
						app.quit();
					}
				});
			}
		} else {
			quitting = true;
		}
	});
	app.on('will-quit', () => host?.kill());
	app.whenReady().then(initialize).catch(error => {
		console.error(error);
		dialog.showErrorBox(applicationName, error instanceof Error ? error.message : String(error));
		app.quit();
	});
}

async function initialize(): Promise<void> {
	let settings: TerminalSettings = { ...defaultSettings, profiles: [] };
	try {
		settings = parseSettings(JSON.parse(await fs.readFile(join(app.getPath('userData'), 'settings.json'), 'utf8')));
	} catch (error) {
		if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
			dialog.showErrorBox(localize('terminalApp.settingsError', "Could Not Read Terminal Settings"), error instanceof Error ? error.message : String(error));
		}
	}
	configuration = {
		settings,
		profiles: await getProfiles(settings),
		platform: process.platform,
		cwd: argument('--cwd') ? resolve(argument('--cwd')!) : homedir(),
		profile: argument('--profile')
	};
	registerIpc();
	createMenu();
	createWindow();
}

function getHost(): UtilityProcess {
	if (host) {
		return host;
	}
	const processHost = utilityProcess.fork(join(__dirname, 'terminalHost.cjs'), [], { serviceName: 'Terminal PTY Host', stdio: 'pipe' });
	host = processHost;
	processHost.stderr?.on('data', data => console.error(String(data)));
	processHost.on('message', (message: { type: 'session' | 'closed'; windowId: number; id: string; busy?: boolean }) => {
		const windowSessions = sessions.get(message.windowId);
		if (message.type === 'closed') {
			windowSessions?.delete(message.id);
		} else if (windowSessions) {
			windowSessions.set(message.id, message.busy === true);
		}
	});
	processHost.once('exit', code => {
		if (host === processHost) {
			host = undefined;
			for (const window of windows) {
				for (const id of sessions.get(window.id)?.keys() || []) {
					window.webContents.send('terminal:hostExit', { type: 'error', id, message: localize('terminalApp.hostExit', "The terminal process host stopped (code {0}). Open a new window to start another host.", code) });
				}
			}
			sessions.clear();
		}
	});
	return processHost;
}

function createWindow(): void {
	if (!configuration || quitting) {
		return;
	}
	const window = new BrowserWindow({
		title: applicationName,
		width: 1080,
		height: 720,
		minWidth: 420,
		minHeight: 280,
		backgroundColor: configuration.settings.theme === 'light' ? '#ffffff' : '#1e1e1e',
		show: false,
		webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false }
	});
	const windowId = window.id;
	windows.add(window);
	sessions.set(windowId, new Map());
	windowConfigurations.set(windowId, { ...configuration });
	window.once('ready-to-show', () => window.show());
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('will-navigate', event => event.preventDefault());
	window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	let allowClose = false;
	let confirmingClose = false;
	window.on('close', event => {
		if (!quitting && !allowClose && configuration.settings.confirmOnClose && [...sessions.get(windowId)?.values() || []].some(Boolean)) {
			event.preventDefault();
			if (!confirmingClose) {
				confirmingClose = true;
				confirmClosing(window).then(confirmed => {
					confirmingClose = false;
					if (confirmed && !window.isDestroyed()) {
						allowClose = true;
						window.close();
					}
				});
			}
		}
	});
	window.once('closed', () => {
		windows.delete(window);
		sessions.delete(windowId);
		windowConfigurations.delete(windowId);
		host?.postMessage({ type: 'disconnect', windowId });
	});
	window.loadURL(indexUrl).catch(error => console.error(error));
}

async function confirmClosing(window?: BrowserWindow): Promise<boolean> {
	const options: Electron.MessageBoxOptions = {
		type: 'question',
		message: localize('terminalApp.closeRunning', "Close running terminal commands?"),
		detail: localize('terminalApp.closeRunningDetail', "Closing the terminal will stop its shell and running commands."),
		buttons: [localize('terminalApp.cancel', "Cancel"), localize('terminalApp.close', "Close")],
		defaultId: 0,
		cancelId: 0
	};
	return (await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))).response === 1;
}

/** Every privileged IPC call must originate in a top-level application window. */
function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
	const window = BrowserWindow.fromWebContents(event.sender);
	if (!window || !windows.has(window) || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== indexUrl) {
		throw new Error('Untrusted terminal IPC sender');
	}
	return window;
}

function registerIpc(): void {
	ipcMain.handle(terminalChannels.readClipboard, event => {
		senderWindow(event);
		return clipboard.readText();
	});
	ipcMain.handle(terminalChannels.writeClipboard, (event, text: unknown) => {
		senderWindow(event);
		if (typeof text !== 'string' || text.length > 1024 * 1024) {
			throw new Error('Invalid clipboard text');
		}
		clipboard.writeText(text);
	});
	ipcMain.handle(terminalChannels.initialize, event => {
		const window = senderWindow(event);
		const windowConfiguration = windowConfigurations.get(window.id)!;
		const { port1, port2 } = new MessageChannelMain();
		getHost().postMessage({ type: 'connect', windowId: window.id, configuration: windowConfiguration, nativeWindowHandle: process.platform === 'win32' ? window.getNativeWindowHandle() : undefined }, [port1]);
		window.webContents.postMessage(terminalChannels.port, undefined, [port2]);
		return windowConfiguration;
	});
	ipcMain.handle(terminalChannels.newWindow, event => {
		senderWindow(event);
		createWindow();
	});
	ipcMain.handle(terminalChannels.confirmClose, async (event, id: string) => {
		const window = senderWindow(event);
		const confirmed = !configuration.settings.confirmOnClose || !sessions.get(window.id)?.get(id) || await confirmClosing(window);
		if (confirmed && sessions.get(window.id)?.has(id)) {
			// The caller immediately closes this session; avoid a second prompt for its last window.
			sessions.get(window.id)!.set(id, false);
		}
		return confirmed;
	});
	ipcMain.handle(terminalChannels.saveSettings, async (event, input: unknown) => {
		senderWindow(event);
		const settings = parseSettings(input);
		const profiles = await getProfiles(settings);
		await fs.mkdir(app.getPath('userData'), { recursive: true });
		const settingsPath = join(app.getPath('userData'), 'settings.json');
		const temporaryPath = `${settingsPath}.${crypto.randomUUID()}.tmp`;
		await fs.writeFile(temporaryPath, JSON.stringify(settings, null, '\t') + '\n', { mode: 0o600 });
		await fs.rename(temporaryPath, settingsPath);
		configuration = { ...configuration, settings, profiles };
		for (const window of windows) {
			const next = { ...windowConfigurations.get(window.id)!, settings, profiles };
			windowConfigurations.set(window.id, next);
			window.webContents.send(terminalChannels.configuration, next);
		}
		host?.postMessage({ type: 'configuration', configuration });
		return configuration;
	});
	ipcMain.handle(terminalChannels.openExternal, async (event, url: unknown) => {
		senderWindow(event);
		if (typeof url !== 'string' || url.length > 8192 || !['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)) {
			throw new Error('Unsupported external link');
		}
		await shell.openExternal(url);
	});
}

function createMenu(): void {
	const action = (label: string, command: TerminalAction, accelerator?: string): MenuItemConstructorOptions => ({ label, accelerator, click: () => BrowserWindow.getFocusedWindow()?.webContents.send(terminalChannels.action, command) });
	const template: MenuItemConstructorOptions[] = [];
	if (process.platform === 'darwin') {
		template.push({ label: applicationName, submenu: [{ role: 'about' }, { type: 'separator' }, action(localize('terminalApp.settings', "Settings…"), 'settings', 'CmdOrCtrl+,'), { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] });
	}
	template.push(
		{ label: localize('terminalApp.file', "File"), submenu: [
			{ label: localize('terminalApp.newWindow', "New Window"), accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
			action(localize('terminalApp.newTab', "New Terminal"), 'newTab', process.platform === 'darwin' ? 'Cmd+T' : 'Ctrl+Shift+T'),
			action(localize('terminalApp.splitRight', "Split Right"), 'splitRight', process.platform === 'darwin' ? 'Cmd+D' : 'Ctrl+Shift+D'),
			action(localize('terminalApp.splitDown', "Split Down"), 'splitDown', process.platform === 'darwin' ? 'Cmd+Shift+D' : 'Ctrl+Shift+Alt+D'),
			{ type: 'separator' },
			action(localize('terminalApp.closeTerminal', "Close Terminal"), 'closeTerminal', process.platform === 'darwin' ? 'Cmd+W' : 'Ctrl+Shift+W'),
			{ role: 'close', accelerator: process.platform === 'darwin' ? 'Cmd+Shift+W' : 'Alt+F4' },
			...(process.platform === 'darwin' ? [] : [action(localize('terminalApp.settings', "Settings…"), 'settings', 'Ctrl+,')])
		] },
		{ label: localize('terminalApp.edit', "Edit"), submenu: [
			{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
			action(localize('terminalApp.copy', "Copy"), 'copy', process.platform === 'darwin' ? 'Cmd+C' : 'Ctrl+Shift+C'),
			action(localize('terminalApp.paste', "Paste"), 'paste', process.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+Shift+V'),
			action(localize('terminalApp.find', "Find"), 'find', 'CmdOrCtrl+F'),
			action(localize('terminalApp.clear', "Clear Terminal"), 'clear', process.platform === 'darwin' ? 'Cmd+K' : undefined)
		] },
		{ label: localize('terminalApp.view', "View"), submenu: [
			action(localize('terminalApp.nextTab', "Next Terminal"), 'nextTab', 'Ctrl+Tab'),
			action(localize('terminalApp.previousTab', "Previous Terminal"), 'previousTab', 'Ctrl+Shift+Tab'),
			{ type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }
		] },
		{ role: 'windowMenu' }
	);
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
