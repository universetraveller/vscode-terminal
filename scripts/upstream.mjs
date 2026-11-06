/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, upstream } from './paths.mjs';

/** Read a real submodule checkout, never fall back to a parent repository's source or metadata. */
export async function readUpstreamCheckout() {
	try {
		await access(join(upstream, '.git'));
		await access(join(upstream, 'src/vs/platform/terminal/node/terminalProcess.ts'));
	} catch {
		throw new Error('VS Code source is missing. Run git submodule update --init --depth 1 vendor/vscode.');
	}
	const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: upstream, encoding: 'utf8' }).trim();
	if (resolve(gitRoot) !== resolve(upstream)) {
		throw new Error('vendor/vscode must be its own Git checkout.');
	}
	const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: upstream, encoding: 'utf8' }).trim();
	if (dirty) {
		throw new Error('The VS Code submodule has tracked changes. Keep application code in src/ and commit any intentional upstream patch before pinning it.');
	}
	const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
	const manifest = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8'));
	return { commit, version: manifest.version };
}

/** The source pin and dependency lock must describe the same upstream revision. */
export async function verifyUpstream() {
	const actual = await readUpstreamCheckout();
	const pin = JSON.parse(await readFile(join(root, 'upstream.json'), 'utf8'));
	if (!/^[0-9a-f]{40}$/.test(pin.commit) || pin.commit !== actual.commit || pin.version !== actual.version) {
		throw new Error('The VS Code checkout differs from upstream.json. After selecting an intended revision, run pnpm sync-upstream, install, and validate.');
	}
	const repository = execFileSync('git', ['config', '--file', join(root, '.gitmodules'), '--get', 'submodule.vscode.url'], { encoding: 'utf8' }).trim();
	if (repository !== pin.repository) {
		throw new Error('The VS Code submodule URL differs from upstream.json. Keep both source declarations in sync.');
	}
	return pin;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const pin = await verifyUpstream();
	console.log(`VS Code ${pin.version} pinned at ${pin.commit}; upstream checkout is clean.`);
}
