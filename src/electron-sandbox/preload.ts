/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { contextBridge, ipcRenderer } from 'electron';
import { isTerminalRequest, terminalChannels, TerminalAction, TerminalBridge, TerminalConfiguration, TerminalEvent } from '../common/terminalApp.js';

let port: MessagePort | undefined;
let resolvePort: () => void;
const portReady = new Promise<void>(resolve => resolvePort = resolve);
const eventListeners = new Set<(event: TerminalEvent) => void>();
const actionListeners = new Set<(action: TerminalAction) => void>();
const configurationListeners = new Set<(configuration: TerminalConfiguration) => void>();

ipcRenderer.on(terminalChannels.port, event => {
	port?.close();
	port = event.ports[0];
	port.onmessage = event => {
		for (const listener of eventListeners) {
			listener(event.data);
		}
	};
	port.start();
	resolvePort();
});
ipcRenderer.on('terminal:hostExit', (_event, data: TerminalEvent) => {
	for (const listener of eventListeners) {
		listener(data);
	}
});
ipcRenderer.on(terminalChannels.action, (_event, action: TerminalAction) => {
	for (const listener of actionListeners) {
		listener(action);
	}
});
ipcRenderer.on(terminalChannels.configuration, (_event, configuration: TerminalConfiguration) => {
	for (const listener of configurationListeners) {
		listener(configuration);
	}
});

const bridge: TerminalBridge = {
	initialize: () => ipcRenderer.invoke(terminalChannels.initialize),
	send: async request => {
		if (!isTerminalRequest(request)) {
			throw new Error('Invalid terminal request');
		}
		await portReady;
		port?.postMessage(request);
	},
	onEvent: listener => {
		eventListeners.add(listener);
		return () => eventListeners.delete(listener);
	},
	onAction: listener => {
		actionListeners.add(listener);
		return () => actionListeners.delete(listener);
	},
	onConfiguration: listener => {
		configurationListeners.add(listener);
		return () => configurationListeners.delete(listener);
	},
	saveSettings: settings => ipcRenderer.invoke(terminalChannels.saveSettings, settings),
	newWindow: () => ipcRenderer.invoke(terminalChannels.newWindow),
	confirmClose: id => ipcRenderer.invoke(terminalChannels.confirmClose, id),
	openExternal: url => ipcRenderer.invoke(terminalChannels.openExternal, url),
	readClipboard: () => ipcRenderer.invoke(terminalChannels.readClipboard),
	writeClipboard: text => ipcRenderer.invoke(terminalChannels.writeClipboard, text)
};

contextBridge.exposeInMainWorld('terminalApp', bridge);
