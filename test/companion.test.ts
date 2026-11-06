/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { codeArguments, launchEnvironment, parseOptions, prepareProfile, resolveInstallation } from '../src/companion/launcher.js';
import { claimRequest, isWindowRequest, profileMarker, requestLifetime, WindowRequest, writeState } from '../src/companion/protocol.js';

describe('VS Code companion isolation', () => {
	test('refuses an editor profile without changing its contents', async () => {
		const profile = await mkdtemp(join(tmpdir(), 'terminal-companion-editor-'));
		try {
			await writeFile(join(profile, 'settings.json'), '{"editor.fontSize": 18}');
			await assert.rejects(prepareProfile(profile, 'missing'), /not a Terminal OSS companion profile/);
			assert.deepStrictEqual({ files: await readdir(profile), settings: await readFile(join(profile, 'settings.json'), 'utf8') }, { files: ['settings.json'], settings: '{"editor.fontSize": 18}' });
		} finally {
			await rm(profile, { recursive: true, force: true });
		}
	});

	test('seeds its own profile once and preserves user JSONC settings across extension updates', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'terminal-companion-profile-'));
		try {
			const extension = join(directory, 'adapter');
			const profile = join(directory, 'profile');
			await mkdir(extension);
			for (const name of ['extension.cjs', 'package.nls.json', 'LICENSE.txt', 'package.json']) {
				await writeFile(join(extension, name), '{}');
			}
			await prepareProfile(profile, extension);
			const settingsPath = join(profile, 'User/settings.json');
			const initial = JSON.parse(await readFile(settingsPath, 'utf8'));
			const settings = '// My preferences\n{"terminal.integrated.fontSize": 17}\n';
			await writeFile(settingsPath, settings);
			await writeFile(join(extension, 'extension.cjs'), 'updated adapter');
			await prepareProfile(profile, extension);
			assert.deepStrictEqual({
				maximized: initial['workbench.panel.opensMaximized'],
				settings: await readFile(settingsPath, 'utf8'),
				adapter: await readFile(join(profile, 'extensions/terminal-oss.companion-0.1.0/extension.cjs'), 'utf8'),
				marker: JSON.parse(await readFile(join(profile, profileMarker), 'utf8'))
			}, { maximized: 'always', settings, adapter: 'updated adapter', marker: { kind: 'terminal-oss-companion-v1' } });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('isolates IPC, extension directories and shared storage while retaining the shell environment', () => {
		const options = parseOptions(['--user-data-dir', join(tmpdir(), 'companion-test'), '--cwd', tmpdir()]);
		const environment = launchEnvironment(options.profile, {
			HOME: '/user', PATH: '/bin', PROJECT: 'retained', NODE_OPTIONS: '--inspect=9999',
			VSCODE_IPC_HOOK_CLI: 'editor-socket', VSCODE_PORTABLE: '/editor-data', ELECTRON_ENABLE_LOGGING: '1',
			GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/injected'
		});
		assert.deepStrictEqual({ environment, arguments: codeArguments({ executable: '/code', cli: '/code/out/cli.js', appRoot: '/code', version: '1.141.0' }, options) }, {
			environment: { HOME: '/user', PATH: '/bin', PROJECT: 'retained', ELECTRON_RUN_AS_NODE: '1', TERMINAL_OSS_COMPANION_PROFILE: options.profile },
			arguments: ['/code/out/cli.js', '--new-window', '--user-data-dir', options.profile, '--extensions-dir', join(options.profile, 'extensions'), '--shared-data-dir', join(options.profile, 'shared'), '--skip-welcome', '--skip-release-notes']
		});
	});

	test('rejects malformed launch arguments before writing profiles', async () => {
		const results = [['--cwd'], ['--cdp-port', 'NaN'], ['--cdp-port', '0'], ['--unknown']].map(args => {
			try { parseOptions(args); return false; } catch { return true; }
		});
		assert.deepStrictEqual({ results, absent: await resolveInstallation(join(tmpdir(), randomUUID())) }, { results: [true, true, true, true], absent: undefined });
	});
});

describe('VS Code companion window requests', () => {
	test('concurrent windows claim each request exactly once and skip corrupt or stale requests', async () => {
		const profile = await mkdtemp(join(tmpdir(), 'terminal-companion-queue-'));
		try {
			const directory = join(profile, 'companion/requests');
			const requests: WindowRequest[] = Array.from({ length: 4 }, () => ({ version: 1, id: randomUUID(), cwd: tmpdir(), createdAt: Date.now() }));
			await Promise.all(requests.map(request => writeState(directory, request.id, request)));
			await writeFile(join(directory, '000-corrupt.json'), '{broken');
			const expired = { ...requests[0], id: randomUUID(), createdAt: Date.now() - requestLifetime - 1 };
			await writeState(directory, expired.id, expired);
			const claimed = await Promise.all(Array.from({ length: 6 }, () => claimRequest(profile)));
			assert.deepStrictEqual({ ids: claimed.filter(request => !!request).map(request => request.id).sort(), remaining: await readdir(directory) }, { ids: requests.map(request => request.id).sort(), remaining: [] });
		} finally {
			await rm(profile, { recursive: true, force: true });
		}
	});

	test('validates filesystem requests before they can select a shell directory', () => {
		const request: WindowRequest = { version: 1, id: randomUUID(), cwd: tmpdir(), createdAt: Date.now() };
		assert.deepStrictEqual([
			request, null, { ...request, id: '../other-window' }, { ...request, cwd: 'relative' },
			{ ...request, cwd: '/bad\0directory' }, { ...request, createdAt: Date.now() + requestLifetime }
		].map(value => isWindowRequest(value)), [true, false, false, false, false, false]);
	});
});
