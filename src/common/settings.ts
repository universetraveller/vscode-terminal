/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@vscode-source/nls.js';
import { TerminalProfile, TerminalSettings } from './terminalApp.js';

export const defaultSettings: Readonly<TerminalSettings> = Object.freeze({
	fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
	fontSize: 14,
	scrollback: 2000,
	theme: 'system',
	gpuAcceleration: true,
	shellIntegration: true,
	confirmOnClose: true,
	defaultProfile: '',
	profiles: []
});

/** Validate persisted settings and IPC values without silently accepting invalid shell profiles. */
export function parseSettings(value: unknown): TerminalSettings {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(localize('terminalApp.settingsObject', "Settings must be a JSON object."));
	}
	const settings = { ...defaultSettings, ...value };
	if (typeof settings.fontFamily !== 'string' || !settings.fontFamily.trim() || settings.fontFamily.length > 512 || !Number.isInteger(settings.fontSize) || settings.fontSize < 8 || settings.fontSize > 40 || !Number.isInteger(settings.scrollback) || settings.scrollback < 0 || settings.scrollback > 50000 || !['dark', 'light', 'system'].includes(settings.theme) || typeof settings.defaultProfile !== 'string' || settings.defaultProfile.length > 256 || typeof settings.gpuAcceleration !== 'boolean' || typeof settings.shellIntegration !== 'boolean' || typeof settings.confirmOnClose !== 'boolean' || !Array.isArray(settings.profiles) || settings.profiles.length > 100 || !settings.profiles.every(isTerminalProfile)) {
		throw new Error(localize('terminalApp.invalidSettings', "Invalid terminal settings. Check the font, scrollback, theme, and shell profiles."));
	}
	if (new Set(settings.profiles.map(profile => profile.name)).size !== settings.profiles.length) {
		throw new Error(localize('terminalApp.duplicateProfiles', "Shell profile names must be unique."));
	}
	// Only persist this application's settings, even if other keys were present in the input.
	return {
		fontFamily: settings.fontFamily,
		fontSize: settings.fontSize,
		scrollback: settings.scrollback,
		theme: settings.theme,
		gpuAcceleration: settings.gpuAcceleration,
		shellIntegration: settings.shellIntegration,
		confirmOnClose: settings.confirmOnClose,
		defaultProfile: settings.defaultProfile,
		profiles: settings.profiles.map(profile => ({ name: profile.name, path: profile.path, args: profile.args?.slice(), env: profile.env ? { ...profile.env } : undefined, cwd: profile.cwd }))
	};
}

function isTerminalProfile(value: unknown): value is TerminalProfile {
	if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 256 || !('path' in value) || typeof value.path !== 'string' || !value.path.trim() || value.path.includes('\0')) {
		return false;
	}
	return (!('args' in value) || value.args === undefined || Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) &&
		(!('cwd' in value) || value.cwd === undefined || typeof value.cwd === 'string' && !value.cwd.includes('\0')) &&
		(!('env' in value) || value.env === undefined || !!value.env && typeof value.env === 'object' && !Array.isArray(value.env) && Object.entries(value.env).every(([key, entry]) => !key.includes('=') && !key.includes('\0') && (entry === null || typeof entry === 'string' && !entry.includes('\0'))));
}
