import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

// Compiles bro.ts into a scratch directory the same way settings.test.ts does
// (strip-only mode rejects its TypeScript parameter properties).
const repoDir = dirname(fileURLToPath(import.meta.url));
const buildDir = mkdtempSync(join(tmpdir(), "pi-bro-show-html-test-"));
const tscBin = join(repoDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
execFileSync(
	tscBin,
	[
		"--ignoreConfig",
		join(repoDir, "bro.ts"),
		"--target",
		"ES2022",
		"--module",
		"NodeNext",
		"--moduleResolution",
		"NodeNext",
		"--strict",
		"--allowImportingTsExtensions",
		"--rewriteRelativeImportExtensions",
		"--skipLibCheck",
		"--types",
		"node",
		"--outDir",
		buildDir,
	],
	{ stdio: "pipe" },
);
symlinkSync(join(repoDir, "node_modules"), join(buildDir, "node_modules"));

process.env.PI_CODING_AGENT_DIR = join(buildDir, "agent");
const { showHtmlDirectory, writeShowHtml } = await import(pathToFileURL(join(buildDir, "bro.js")).href);

// showHtmlDirectory() derives from os.tmpdir(), which reads TMPDIR on each
// call; point it at the scratch directory so writes never touch the real /tmp.
const originalTmpdir = process.env.TMPDIR;
process.env.TMPDIR = join(buildDir, "tmp");
after(() => {
	if (originalTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdir;
	rmSync(buildDir, { recursive: true, force: true });
});

const BRO_CSP =
	'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:;">';

async function saved(html: string): Promise<string> {
	const path = await writeShowHtml(html);
	assert.ok(path.startsWith(join(buildDir, "tmp")), `wrote outside the isolated TMPDIR: ${path}`);
	assert.ok(path.startsWith(showHtmlDirectory()));
	return readFileSync(path, "utf8");
}

test("Bro CSP goes directly after the doctype and the rest is untouched", async () => {
	const body = '<html lang="en"><head><meta charset="utf-8"><title>d</title></head><body><svg></svg></body></html>';
	assert.equal(await saved(`<!DOCTYPE html>\n${body}`), `<!DOCTYPE html>\n\n${BRO_CSP}\n${body}\n`);
});

test("Bro CSP is prepended to fragments without a doctype", async () => {
	assert.equal(await saved("<svg><rect/></svg>"), `\n${BRO_CSP}\n<svg><rect/></svg>\n`);
});

test("a CSP-looking comment does not suppress the Bro CSP", async () => {
	const body = '<html><head><!-- http-equiv="Content-Security-Policy" --></head><body>x</body></html>';
	assert.equal(await saved(`<!doctype html>\n${body}`), `<!doctype html>\n\n${BRO_CSP}\n${body}\n`);
});

test("a permissive model CSP is kept but the Bro CSP is still enforced ahead of it", async () => {
	const permissive = '<meta http-equiv="Content-Security-Policy" content="default-src *; script-src * \'unsafe-inline\'">';
	const body = `<html><head>${permissive}<script src="https://evil.example/x.js"></script></head><body>x</body></html>`;
	const out = await saved(`<!doctype html>\n${body}`);
	assert.equal(out, `<!doctype html>\n\n${BRO_CSP}\n${body}\n`);
	assert.ok(out.indexOf(BRO_CSP) < out.indexOf(permissive));
	assert.ok(out.indexOf(BRO_CSP) < out.indexOf("<script"));
});

for (const comment of ["<!-->", "<!--->", "<!-- a --!>"]) {
	test(`browser-terminated comment ${comment} cannot put a script before Bro CSP`, async () => {
		const out = await saved(`${comment}<script src="https://evil.example/x.js"></script><!-- -->`);
		assert.ok(out.indexOf(BRO_CSP) < out.indexOf("<script"));
	});
}

test("leading comments stay ahead of the doctype so the page keeps standards mode", async () => {
	const body = "<html><head></head><body>x</body></html>";
	const out = await saved(`<!-- generated -->\n<!DOCTYPE html>\n${body}`);
	assert.equal(out, `<!-- generated -->\n<!DOCTYPE html>\n\n${BRO_CSP}\n${body}\n`);
});
