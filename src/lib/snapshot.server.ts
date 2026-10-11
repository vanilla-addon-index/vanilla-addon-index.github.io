import { existsSync, readFileSync } from 'node:fs';
import type { Addon } from './types';

const FILE = 'static/addons.json';

/**
 * The addon list the site is being built with. The deploy puts it there, and so does
 * `npm run snapshot`; without one the build still works, with no addon pages of its own.
 */
export const readSnapshot = (): Addon[] => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []);
