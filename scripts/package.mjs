/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { packager } from '@electron/packager';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appDirectory, buildApp, output } from './build.mjs';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

export async function directoryBytes(directory) {
	let bytes = 0;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		bytes += entry.isDirectory() ? await directoryBytes(file) : (await stat(file)).size;
	}
	return bytes;
}

if (process.argv[1]?.endsWith('package.mjs')) {
	await buildApp();
	const packages = await packager({
		dir: appDirectory,
		out: join(output, 'packages'),
		name: 'Terminal OSS',
		executableName: 'terminal-oss',
		appBundleId: 'org.terminaloss.Terminal',
		appCategoryType: 'public.app-category.developer-tools',
		platform: process.platform,
		arch: process.arch,
		electronVersion: manifest.devDependencies.electron,
		// Shells and PTY helpers must access these files through the OS, outside Electron's ASAR API.
		asar: false,
		prune: false,
		overwrite: true
	});
	const report = {
		platform: process.platform,
		arch: process.arch,
		applicationPayloadBytes: await directoryBytes(appDirectory),
		packages: await Promise.all(packages.map(async path => ({ path, bytes: await directoryBytes(path) }))),
		signed: false,
		notarized: false
	};
	await writeFile(join(output, 'package-report.json'), JSON.stringify(report, null, '\t') + '\n');
	console.log(JSON.stringify(report, null, 2));
}
