/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, upstream } from './paths.mjs';
import { readUpstreamCheckout, verifyUpstream } from './upstream.mjs';

const check = process.argv.includes('--check');
const actual = check ? await verifyUpstream() : await readUpstreamCheckout();
// This upstream parser has no installed-package dependency. VS Code needs no pnpm install.
const { readLockfileImporter } = await import(pathToFileURL(join(upstream, 'build/lib/pnpmLock.ts')).href);
const manifestPath = join(root, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const upstreamManifest = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8'));
const upstreamBuild = JSON.parse(await readFile(join(upstream, 'build/package.json'), 'utf8'));
const before = JSON.stringify(manifest);
const importer = readLockfileImporter(await readFile(join(upstream, 'pnpm-lock.yaml'), 'utf8'), '.');

for (const group of ['dependencies', 'optionalDependencies']) {
	for (const name of Object.keys(manifest[group])) {
		if (!upstreamManifest.dependencies[name]) {
			throw new Error(`Upstream no longer declares ${name}; review the terminal adapter before syncing.`);
		}
		const locked = importer?.dependencies?.[name];
		if (!locked || locked.specifier !== upstreamManifest.dependencies[name]) {
			throw new Error(`Upstream manifest and lockfile disagree for ${name}; select a consistent upstream revision.`);
		}
		manifest[group][name] = locked.version.split('(')[0];
	}
}
for (const name of ['typescript', '@types/node', '@types/trusted-types']) {
	manifest.devDependencies[name] = upstreamManifest.devDependencies[name];
}
manifest.devDependencies.esbuild = upstreamBuild.devDependencies.esbuild;
manifest.devDependencies['playwright-core'] = upstreamManifest.dependencies['playwright-core'];
manifest.devDependencies.electron = upstreamManifest.nativeBuild.target;
manifest.packageManager = upstreamManifest.packageManager;
const nodeVersion = await readFile(join(upstream, '.nvmrc'), 'utf8');

if (check) {
	if (JSON.stringify(manifest) !== before || await readFile(join(root, '.nvmrc'), 'utf8') !== nodeVersion) {
		throw new Error('Terminal dependencies differ from the pinned upstream. Run pnpm sync-upstream, install, and validate.');
	}
	console.log(`Terminal dependencies match VS Code ${actual.version} (${actual.commit}).`);
} else {
	const repository = JSON.parse(await readFile(join(root, 'upstream.json'), 'utf8')).repository;
	await writeFile(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
	await writeFile(join(root, '.nvmrc'), nodeVersion);
	await writeFile(join(root, 'upstream.json'), JSON.stringify({ repository, commit: actual.commit, version: actual.version }, null, '\t') + '\n');
	console.log(`Pinned VS Code ${actual.version} at ${actual.commit}. Run pnpm install and validate before committing the gitlink and dependency changes.`);
}
