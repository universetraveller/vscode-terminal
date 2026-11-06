/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ITheme } from '@xterm/xterm';

/** Generated from VS Code's default themes and ANSI color registry by the terminal build. */
export const themes: Record<'dark' | 'light', { colors: Record<string, string>; terminal: ITheme }>;
