/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from 'node:path';
import { launchCompanion } from './launcher.js';

launchCompanion(process.argv.slice(2), join(__dirname, 'extension')).catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
