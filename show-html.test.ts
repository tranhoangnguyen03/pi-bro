import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// @ts-ignore Shared JavaScript test harness.
import { bro, buildDir } from "./test-build.mjs";
const { default: registerBro, showHtmlDirectory, writeShowHtml } = bro;

test("Show reopen restores diagrams and retries Show; Explain still retries Explain", async () => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme();
	const bin = join(buildDir, "bin"); mkdirSync(bin);
	const calls = join(buildDir, "calls.jsonl");
	const fail = join(buildDir, "fail");
	writeFileSync(join(bin, "agy"), `#!/usr/bin/env node
const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+ '\\n');
if(fs.existsSync(${JSON.stringify(fail)})) process.exit(1);
console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'Diagram\\n\\n\`\`\`html\\n<div>layout</div>\\n\`\`\`'}}));
`, { mode: 0o755 });
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}:${originalPath}`;
	let modal: any, command: any;
	const ctx: any = {
		mode: "rpc", cwd: buildDir,
		sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "ORIGINAL_SOURCE" } }] },
		ui: { notify() {}, custom: async (factory: any) => {
			modal = factory({ mode: "fullscreen", terminal: { rows: 40 }, requestRender() {} },
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, () => {});
		} },
	};
	const prompts = () => readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line).at(-1));
	const rendered = () => modal.render(140).join("\n");
	const settled = async () => {
		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 5000;
			const poll = () => {
				if (modal.kind === "result" || modal.kind === "error") return resolve();
				if (Date.now() > deadline) return reject(new Error("modal did not settle"));
				setTimeout(poll, 10);
			}; poll();
		});
	};
	try {
		await registerBro({ on() {}, registerTool() {}, registerCommand(_name: string, def: any) { command = def; } });
		await command.handler("show 1 Keep My Steering", ctx);
		ctx.mode = "tui";
		await command.handler("open", ctx);
		assert.equal(prompts().length, 1, "reopening must not call the backend");
		assert.match(rendered(), /O open diagram/);
		assert.match(rendered(), /R show again/);
		modal.dispose();
		rmSync(showHtmlDirectory(), { recursive: true, force: true });
		await command.handler("open", ctx);
		assert.match(rendered(), /O open diagram/);
		assert.ok(readdirSync(showHtmlDirectory()).some((name: string) => name.endsWith(".html")));
		ctx.sessionManager.getBranch = () => [];
		modal.handleInput("r"); await settled();
		assert.match(prompts()[1], /Quoted session transcript as a JSON string/);
		assert.match(prompts()[1], /Keep My Steering/);
		assert.match(prompts()[1], /ORIGINAL_SOURCE/);
		writeFileSync(fail, "fail");
		modal.handleInput("r"); await settled();
		assert.match(rendered(), /Retry failed/);
		assert.ok(modal.htmlPath, "failed retry retains the diagram path");
		modal.dispose(); rmSync(fail);
		rmSync(showHtmlDirectory(), { recursive: true, force: true });
		writeFileSync(showHtmlDirectory(), "not a directory");
		await command.handler("open", ctx);
		assert.doesNotMatch(rendered(), /O open diagram/);
		assert.equal(prompts().length, 3, "artifact recovery does not call a backend");
		modal.dispose(); rmSync(showHtmlDirectory());
		ctx.mode = "rpc";
		await command.handler("text EXPLAIN_SOURCE", ctx);
		ctx.mode = "tui"; await command.handler("open", ctx);
		modal.handleInput("r"); await settled();
		assert.match(prompts().at(-1), /EXPLAIN_SOURCE/);
		assert.doesNotMatch(prompts().at(-1), /Quoted session transcript as a JSON string/);
	} finally {
		modal?.dispose();
		if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
		if (existsSync(fail)) rmSync(fail);
	}
});

test("Show results keep the preferences tag they were drawn with", async () => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme();
	const bin = join(buildDir, "bin-prefs"); mkdirSync(bin);
	const calls = join(buildDir, "calls-prefs.jsonl");
	const fail = join(buildDir, "fail-prefs");
	writeFileSync(join(bin, "agy"), `#!/usr/bin/env node
const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+ '\\n');
if(fs.existsSync(${JSON.stringify(fail)})) process.exit(1);
console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'Drawn'}}));
`, { mode: 0o755 });
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	mkdirSync(agentDir, { recursive: true });
	const preferences = join(agentDir, "bro-preferences.md");
	writeFileSync(preferences, "SHOW_PREFS_MARKER");
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}:${originalPath}`;
	let modal: any, command: any;
	const ctx: any = {
		mode: "tui", cwd: buildDir,
		sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "SHOW_SOURCE" } }] },
		ui: { notify() {}, custom: async (factory: any) => {
			modal = factory({ mode: "fullscreen", terminal: { rows: 40 }, requestRender() {} },
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, () => {});
		} },
	};
	const prompts = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line).at(-1)) : [];
	const header = () => modal.render(140)[1];
	const settled = async () => {
		const deadline = Date.now() + 5000;
		while (modal.kind !== "result" && modal.kind !== "error") {
			if (Date.now() > deadline) throw new Error("modal did not settle");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	try {
		await registerBro({ on() {}, registerTool() {}, registerCommand(_name: string, def: any) { command = def; } });
		await command.handler("show 1", ctx); await settled();
		assert.ok(prompts()[0].includes(JSON.stringify("SHOW_PREFS_MARKER")), "Show prompts carry preferences");
		assert.match(header(), / · prefs/, "the initial Show result carries the tag");
		assert.doesNotMatch(header(), /balanced|brief|faithful/, "Show has no mode");
		modal.dispose();

		rmSync(preferences);
		await command.handler("open", ctx);
		assert.match(header(), / · prefs/, "/bro open restores the stored tag");
		assert.equal(prompts().length, 1, "reopening makes no backend call");
		writeFileSync(fail, "fail");
		modal.handleInput("r"); await settled();
		assert.match(header(), / · prefs/, "a failed re-run keeps the previous result's tag");
		rmSync(fail);
		modal.handleInput("r"); await settled();
		assert.doesNotMatch(header(), /prefs/, "R re-reads preferences");
		assert.doesNotMatch(prompts().at(-1), /SHOW_PREFS_MARKER/);

		const callsBefore = prompts().length;
		writeFileSync(preferences, "x".repeat(4_001));
		modal.handleInput("r"); await settled();
		assert.match(modal.notice, /Retry failed: .*4,001 characters; keep it under 4,000/);
		assert.equal(prompts().length, callsBefore, "oversize preferences stop Show before any backend call");
	} finally {
		modal?.dispose();
		if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
		for (const path of [fail, preferences, calls, bin]) rmSync(path, { recursive: true, force: true });
	}
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
