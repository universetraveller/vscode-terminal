/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const profileEnvironmentKey = 'TERMINAL_OSS_COMPANION_PROFILE';
export const profileMarker = 'terminal-oss-companion.json';
export const profileIdentity = 'terminal-oss-companion-v1';
export const requestLifetime = 120_000;

export interface WindowRequest {
	version: 1;
	id: string;
	cwd: string;
	createdAt: number;
	waitForReady?: boolean;
}

export interface WindowReady {
	id: string;
	vscodeVersion: string;
	terminalPid?: number;
	error?: string;
}

/** Validate the file boundary before a request can start a shell. */
export function isWindowRequest(value: unknown, now = Date.now()): value is WindowRequest {
	const request = value as Partial<WindowRequest> | null;
	return !!request && request.version === 1 && typeof request.id === 'string' && /^[a-f0-9-]{36}$/.test(request.id)
		&& typeof request.cwd === 'string' && isAbsolute(request.cwd) && !request.cwd.includes('\0')
		&& typeof request.createdAt === 'number' && request.createdAt <= now + 5000 && now - request.createdAt < requestLifetime;
}

/** Verify the explicit marker before touching this application's private state. */
export async function isCompanionProfile(profile: string): Promise<boolean> {
	try {
		return JSON.parse(await readFile(join(profile, profileMarker), 'utf8')).kind === profileIdentity;
	} catch {
		return false;
	}
}

/** Publish complete JSON files; readers never see a partially written launch request. */
export async function writeState(directory: string, name: string, value: WindowRequest | WindowReady): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `${name}.${process.pid}.tmp`);
	await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
	await rename(temporary, join(directory, `${name}.json`));
}

/** Atomic renaming lets concurrently opening windows claim different requests. No watcher stays alive. */
export async function claimRequest(profile: string): Promise<WindowRequest | undefined> {
	const directory = join(profile, 'companion', 'requests');
	await mkdir(directory, { recursive: true, mode: 0o700 });
	for (const name of (await readdir(directory)).filter(name => name.endsWith('.json')).sort()) {
		const original = join(directory, name);
		const claimed = `${original}.${process.pid}.claimed`;
		try {
			await rename(original, claimed);
		} catch {
			continue;
		}
		try {
			const request: unknown = JSON.parse(await readFile(claimed, 'utf8'));
			if (isWindowRequest(request) && name === `${request.id}.json`) {
				return request;
			}
		} catch {
			// Malformed or expired requests must not prevent another window from opening.
		} finally {
			await unlink(claimed);
		}
	}
	return undefined;
}
