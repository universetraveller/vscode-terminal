/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const upstream = join(root, 'vendor/vscode');
export const output = join(root, '.build/terminal');
export const source = join(root, 'src');
export const tooling = join(root, 'node_modules');
export const tsconfig = join(root, 'tsconfig.json');
