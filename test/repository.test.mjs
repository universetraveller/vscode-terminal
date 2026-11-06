/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, upstream } from '../scripts/paths.mjs';
import { verifyUpstream } from '../scripts/upstream.mjs';

describe('Independent repository boundaries', () => {
	test('uses a pinned, clean submodule with independent Git object storage', async () => {
		const pin = await verifyUpstream();
		const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
		const gitDirectory = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: upstream, encoding: 'utf8' }).trim();
		const hasAlternates = await access(join(gitDirectory, 'objects/info/alternates')).then(() => true, () => false);
		assert.deepStrictEqual({ root: resolve(gitRoot), hasAlternates, pin: pin.commit.length }, { root: resolve(root), hasAlternates: false, pin: 40 });
	});

	test('packages only terminal dependencies and records the submodule provenance', async () => {
		const pin = await verifyUpstream();
		const report = JSON.parse(await readFile(join(root, '.build/terminal/build-report.json'), 'utf8'));
		const application = JSON.parse(await readFile(join(root, '.build/terminal/app/package.json'), 'utf8'));
		assert.deepStrictEqual({
			commit: report.vscodeCommit,
			applicationCommit: application.vscodeCommit,
			coreIncluded: report.upstreamInputs.includes('vendor/vscode/src/vs/platform/terminal/node/terminalProcess.ts'),
			shellIntegrationIncluded: report.upstreamInputs.includes('vendor/vscode/src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts'),
			escapedInputs: report.upstreamInputs.filter(input => input.startsWith('../') || input.startsWith('/')),
			forbidden: report.forbiddenInputs
		}, { commit: pin.commit, applicationCommit: pin.commit, coreIncluded: true, shellIntegrationIncluded: true, escapedInputs: [], forbidden: [] });
	});

	test('rejects missing checkouts, an unrecorded revision, and edits to upstream source', async () => {
		const fixture = await mkdtemp(join(tmpdir(), 'terminal-repository-'));
		const checkout = join(fixture, 'vendor/vscode');
		const runGit = args => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(fixture, 'no-hooks')}`, ...args], { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
		try {
			await mkdir(join(fixture, 'scripts'));
			for (const name of ['paths.mjs', 'upstream.mjs']) {
				await cp(join(root, 'scripts', name), join(fixture, 'scripts', name));
			}
			const adapter = await import(pathToFileURL(join(fixture, 'scripts/upstream.mjs')).href);
			await assert.rejects(adapter.verifyUpstream(), /source is missing/);
			await mkdir(join(checkout, 'src/vs/platform/terminal/node'), { recursive: true });
			await writeFile(join(checkout, 'src/vs/platform/terminal/node/terminalProcess.ts'), 'export {};\n');
			await writeFile(join(checkout, 'package.json'), '{"version":"1.146.0"}\n');
			runGit(['init', '-b', 'main', checkout]);
			runGit(['-C', checkout, 'add', '.']);
			runGit(['-C', checkout, '-c', 'user.name=Terminal OSS Test', '-c', 'user.email=terminal-test@example.invalid', 'commit', '-m', 'Fixture']);
			const pin = { repository: 'https://github.com/microsoft/vscode.git', commit: runGit(['-C', checkout, 'rev-parse', 'HEAD']), version: '1.146.0' };
			await writeFile(join(fixture, '.gitmodules'), `[submodule "vscode"]\n\tpath = vendor/vscode\n\turl = ${pin.repository}\n`);
			await writeFile(join(fixture, 'upstream.json'), JSON.stringify(pin));
			assert.deepStrictEqual(await adapter.verifyUpstream(), pin);
			await writeFile(join(fixture, 'upstream.json'), JSON.stringify({ ...pin, commit: '0'.repeat(40) }));
			await assert.rejects(adapter.verifyUpstream(), /differs from upstream.json/);
			await writeFile(join(fixture, 'upstream.json'), JSON.stringify(pin));
			await writeFile(join(checkout, 'src/vs/platform/terminal/node/terminalProcess.ts'), 'export const changed = true;\n');
			await assert.rejects(adapter.verifyUpstream(), /tracked changes/);
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});
});
