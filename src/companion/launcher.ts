/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { localize } from '@vscode-source/nls.js';
import { isCompanionProfile, profileEnvironmentKey, profileIdentity, profileMarker, WindowReady, WindowRequest, writeState } from './protocol.js';

export interface CodeInstallation {
	executable: string;
	cli: string;
	appRoot: string;
	version: string;
}

interface Product {
	applicationName: string;
	nameShort: string;
	portable?: string;
	target?: string;
}

export interface LaunchOptions {
	vscode?: string;
	profile: string;
	cwd: string;
	dryRun: boolean;
	json: boolean;
	wait: boolean;
	debugPort?: number;
	help: boolean;
}

/** Keep launcher settings separate from the editor, and seed them only once. */
export async function prepareProfile(profile: string, extensionDirectory: string): Promise<void> {
	await mkdir(profile, { recursive: true, mode: 0o700 });
	if (!(await isCompanionProfile(profile))) {
		if ((await readdir(profile)).length > 0 && !(await isCompanionProfile(profile))) {
			throw new Error(localize('companion.profileOwned', "Refusing to change a directory that is not a Terminal OSS companion profile: {0}", profile));
		}
		try {
			await writeFile(join(profile, profileMarker), JSON.stringify({ kind: profileIdentity }), { flag: 'wx', mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await isCompanionProfile(profile))) {
				throw error;
			}
		}
	}
	await mkdir(join(profile, 'User'), { recursive: true, mode: 0o700 });
	const settings = {
		'workbench.startupEditor': 'none',
		'workbench.activityBar.location': 'hidden',
		'workbench.statusBar.visible': false,
		'workbench.panel.opensMaximized': 'always',
		'workbench.panel.defaultLocation': 'bottom',
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
		'window.commandCenter': false,
		'window.title': 'Terminal OSS',
		'window.restoreWindows': 'none',
		'terminal.integrated.defaultLocation': 'view',
		'terminal.integrated.hideOnStartup': 'never',
		'terminal.integrated.tabs.enabled': true,
		'terminal.integrated.tabs.hideCondition': 'never',
		'terminal.integrated.scrollback': 2000,
		'chat.disableAIFeatures': true,
		'git.enabled': false,
		'git.autofetch': false,
		'extensions.ignoreRecommendations': true,
		'extensions.autoCheckUpdates': false,
		'extensions.autoUpdate': false,
		'update.mode': 'none',
		'telemetry.telemetryLevel': 'off'
	};
	try {
		await writeFile(join(profile, 'User/settings.json'), JSON.stringify(settings, null, '\t') + '\n', { flag: 'wx', mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw error;
		}
	}
	const extension = join(profile, 'extensions', 'terminal-oss.companion-0.1.0');
	await mkdir(extension, { recursive: true, mode: 0o700 });
	// Publish the manifest last. There are no dependencies, downloads, or installed Code files to copy.
	for (const name of ['extension.cjs', 'package.nls.json', 'LICENSE.txt', 'package.json']) {
		const temporary = join(extension, `${name}.${process.pid}.tmp`);
		await copyFile(join(extensionDirectory, name), temporary);
		await rename(temporary, join(extension, name));
	}
}

/** Discover an intact installed distribution; internal terminal modules are never loaded by the launcher. */
export async function resolveInstallation(candidate: string): Promise<CodeInstallation | undefined> {
	let location: string;
	try {
		location = await realpath(candidate);
		if (!(await stat(location)).isDirectory()) {
			location = dirname(location);
		}
	} catch {
		return undefined;
	}
	for (let level = 0; level < 6; level++, location = dirname(location)) {
		for (const appRoot of [join(location, 'Contents/Resources/app'), join(location, 'resources/app'), location]) {
			let product: Product;
			let version: string;
			try {
				product = JSON.parse(await readFile(join(appRoot, 'product.json'), 'utf8'));
				version = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')).version;
				await access(join(appRoot, 'out/cli.js'));
			} catch {
				continue;
			}
			const binaryRoot = resolve(appRoot, '../..');
			let executable: string;
			if (process.platform === 'darwin') {
				const name = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(binaryRoot, 'Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
				executable = join(binaryRoot, 'MacOS', name);
			} else {
				executable = join(binaryRoot, process.platform === 'win32' ? `${product.nameShort}.exe` : product.applicationName);
			}
			await access(executable);
			const [major, minor] = version.split('.').map(Number);
			if (major !== 1 || minor < 141) {
				throw new Error(localize('companion.version', "Terminal OSS companion requires VS Code 1.141 or later; found {0}.", version));
			}
			const portablePath = process.platform === 'darwin'
				? resolve(binaryRoot, '../..', product.portable || `${product.applicationName}-portable-data`)
				: join(binaryRoot, 'data');
			if (!product.target && await stat(portablePath).then(() => true, () => false)) {
				throw new Error(localize('companion.portable', "This VS Code installation uses portable data, which overrides profile isolation. Choose a regular installation: {0}", candidate));
			}
			return { executable, cli: join(appRoot, 'out/cli.js'), appRoot, version };
		}
	}
	return undefined;
}

/** An explicit installation wins; otherwise follow the OS install locations and PATH. */
export async function findInstallation(explicit?: string): Promise<CodeInstallation> {
	const candidates = explicit ? [explicit] : [
		process.env['TERMINAL_OSS_VSCODE'], process.execPath,
		...(process.platform === 'darwin' ? [
			'/Applications/Visual Studio Code.app', join(homedir(), 'Applications/Visual Studio Code.app'),
			'/Applications/Visual Studio Code - Insiders.app'
		] : process.platform === 'win32' ? [
			join(process.env['LOCALAPPDATA'] || homedir(), 'Programs/Microsoft VS Code'),
			join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft VS Code')
		] : ['/usr/share/code', '/usr/lib/code', '/opt/visual-studio-code']),
		...(process.env['PATH'] || '').split(delimiter).map(directory => join(directory, process.platform === 'win32' ? 'code.cmd' : 'code'))
	];
	for (const candidate of candidates) {
		if (candidate) {
			const installation = await resolveInstallation(candidate);
			if (installation) {
				return installation;
			}
		}
	}
	throw new Error(localize('companion.noCode', "VS Code was not found. Install it or pass --vscode with its application path."));
}

/** Remove inherited editor IPC and injected Node state before creating the separate instance. */
export function launchEnvironment(profile: string, original = process.env): NodeJS.ProcessEnv {
	const environment = { ...original };
	for (const key of Object.keys(environment)) {
		if (/^(?:VSCODE_|ELECTRON_|NODE_OPTIONS$|NODE_REPL_EXTERNAL_MODULE$|GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$)/i.test(key)) {
			delete environment[key];
		}
	}
	environment['ELECTRON_RUN_AS_NODE'] = '1';
	environment[profileEnvironmentKey] = profile;
	return environment;
}

/** All state directories belong to the companion, including VS Code's shared storage. */
export function codeArguments(code: CodeInstallation, options: LaunchOptions): string[] {
	return [code.cli, '--new-window', '--user-data-dir', options.profile,
		'--extensions-dir', join(options.profile, 'extensions'), '--shared-data-dir', join(options.profile, 'shared'),
		'--skip-welcome', '--skip-release-notes',
		...(options.debugPort ? [`--remote-debugging-port=${options.debugPort}`] : [])];
}

/** Parse launcher arguments before any profile is written. */
export function parseOptions(args: string[]): LaunchOptions {
	const dataRoot = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support')
		: process.platform === 'win32' ? process.env['APPDATA'] || homedir() : process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
	const options: LaunchOptions = { profile: join(dataRoot, 'Terminal OSS Companion'), cwd: homedir(), dryRun: false, json: false, wait: true, help: false };
	for (let index = 0; index < args.length; index++) {
		const [key, inline] = args[index].split(/=(.*)/s);
		const value = () => {
			const result = inline ?? args[++index];
			if (!result || result.startsWith('--')) {
				throw new Error(localize('companion.missingArgument', "Missing value for {0}.", key));
			}
			return result;
		};
		switch (key) {
			case '--vscode': options.vscode = resolve(value()); break;
			case '--user-data-dir': options.profile = resolve(value()); break;
			case '--cwd': options.cwd = resolve(value()); break;
			case '--dry-run': options.dryRun = true; break;
			case '--json': options.json = true; break;
			case '--no-wait': options.wait = false; break;
			case '--cdp-port': {
				options.debugPort = Number(value());
				if (!Number.isInteger(options.debugPort) || options.debugPort < 1024 || options.debugPort > 65535) {
					throw new Error(localize('companion.port', "The debugging port must be an integer between 1024 and 65535."));
				}
				break;
			}
			case '--help': case '-h': options.help = true; break;
			case '--': break;
			default: throw new Error(localize('companion.argument', "Unknown launcher argument: {0}", key));
		}
	}
	return options;
}

/** Invoke the installed distribution's own CLI and await the extension's terminal acknowledgement. */
export async function launchCompanion(args: string[], extensionDirectory: string): Promise<void> {
	const options = parseOptions(args);
	if (options.help) {
		console.log(localize('companion.help', "Terminal OSS companion\n  --vscode PATH          Installed VS Code application\n  --cwd PATH             Starting shell directory (default: home)\n  --user-data-dir PATH   Separate companion profile\n  --dry-run              Show the installation and launch plan\n  --json                 Print machine-readable results\n  --no-wait              Return before the terminal is ready"));
		return;
	}
	const code = await findInstallation(options.vscode);
	if (!(await stat(options.cwd)).isDirectory() || !isAbsolute(options.cwd)) {
		throw new Error(localize('companion.cwd', "The starting directory does not exist: {0}", options.cwd));
	}
	const plan = { ...code, profile: options.profile, cwd: options.cwd, arguments: codeArguments(code, options) };
	if (options.dryRun) {
		console.log(JSON.stringify(plan, null, '\t'));
		return;
	}
	await prepareProfile(options.profile, extensionDirectory);
	const request: WindowRequest = { version: 1, id: randomUUID(), cwd: options.cwd, createdAt: Date.now(), waitForReady: options.wait };
	const requests = join(options.profile, 'companion/requests');
	const readyPath = join(options.profile, 'companion/ready', `${request.id}.json`);
	await writeState(requests, request.id, request);
	try {
		await new Promise<void>((resolve, reject) => {
			execFile(code.executable, plan.arguments, { env: launchEnvironment(options.profile), cwd: options.cwd, timeout: 30_000, windowsHide: true }, (error, _stdout, stderr) => {
				if (error) {
					reject(new Error(localize('companion.launchFailed', "VS Code could not launch: {0}", stderr.trim() || error.message)));
				} else {
					resolve();
				}
			});
		});
		if (!options.wait) {
			if (options.json) { console.log(JSON.stringify(plan)); }
			return;
		}
		while (Date.now() - request.createdAt < 45_000) {
			const contents = await readFile(readyPath, 'utf8').catch(() => undefined);
			if (contents) {
				const ready: WindowReady = JSON.parse(contents);
				if (ready.error) { throw new Error(ready.error); }
				console.log(options.json ? JSON.stringify({ ...plan, ...ready }) : localize('companion.started', "Terminal OSS opened using VS Code {0}.", ready.vscodeVersion));
				return;
			}
			await setTimeout(100);
		}
		throw new Error(localize('companion.timeout', "VS Code opened but the companion terminal did not become ready. Check the companion profile's extension logs: {0}", options.profile));
	} finally {
		if (options.wait) {
			await Promise.all([unlink(join(requests, `${request.id}.json`)).catch(() => {}), unlink(readyPath).catch(() => {})]);
		}
	}
}
