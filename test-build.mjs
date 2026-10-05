// Shared scratch compilation for tests that need Bro's runtime TypeScript features.
import './test-cli-guard.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after } from 'node:test';
const repoDir = dirname(fileURLToPath(import.meta.url));
export const buildDir = mkdtempSync(join(tmpdir(), 'pi-bro-test-build-'));
const previousTmp = process.env.TMPDIR;
process.env.TMPDIR = join(buildDir, 'tmp');
mkdirSync(process.env.TMPDIR);
process.env.PI_CODING_AGENT_DIR = join(buildDir, 'agent');
after(() => {
 if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
 rmSync(buildDir, { recursive: true, force: true });
});
execFileSync(process.execPath, [join(repoDir, 'node_modules', 'typescript', 'bin', 'tsc'),
 '--ignoreConfig', join(repoDir, 'bro.ts'), '--target', 'ES2022', '--module', 'NodeNext',
 '--moduleResolution', 'NodeNext', '--strict', '--allowImportingTsExtensions',
 '--rewriteRelativeImportExtensions', '--skipLibCheck', '--types', 'node', '--outDir', buildDir,
], { stdio: 'pipe' });
symlinkSync(join(repoDir, 'node_modules'), join(buildDir, 'node_modules'));
export const bro = await import(pathToFileURL(join(buildDir, 'bro.js')).href);
export const backend = await import(pathToFileURL(join(buildDir, 'backend.js')).href);
export const settings = await import(pathToFileURL(join(buildDir, 'settings.js')).href);
export const sources = await import(pathToFileURL(join(buildDir, 'sources.js')).href);
export const configUi = await import(pathToFileURL(join(buildDir, 'config-ui.js')).href);
export const util = await import(pathToFileURL(join(buildDir, 'util.js')).href);
