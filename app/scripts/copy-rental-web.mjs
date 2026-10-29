// Copies the rental phone screen (plain files, no bundling) next to the built client: dist/rental-web.
import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, 'dist', 'rental-web');
rmSync(target, { recursive: true, force: true });
cpSync(path.join(root, 'src', 'rental-web'), target, { recursive: true });
