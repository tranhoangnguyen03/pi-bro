import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDir } from "./test-build.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdir, writeFile, chmod, readFile, rename, rm } from "node:fs/promises";
import { initTheme, getAgentDir } from "@earendil-works/pi-coding-agent";
const { openGuidedReview } = await import(pathToFileURL(join(buildDir, "review-ui.js")).href);
const { newReviewView } = await import(pathToFileURL(join(buildDir, "review-modal.js")).href);
const { saveReview, loadReview } = await import(pathToFileURL(join(buildDir, "review.js")).href);
initTheme();
test("saved review opens and closes without a backend call and preserves its composer", async () => {
	const id = "a".repeat(64);
	const root = join(getAgentDir(), "bro-reviews");
	const record = {
		version: 1,
		id,
		snapshot: {
			target: { repository: "a/b", number: 1, head: "abcdef", base: "base" },
			mergeBase: "merge",
			gitDir: root,
			checkout: root,
			files: [],
			diff: "",
		},
		turns: [],
		ui: { ...newReviewView(), drafts: { "whole review": "saved question" } },
	};
	await saveReview(root, record);
	let component;
	const ctx = {
		mode: "tui",
		ui: {
			select: async (_title, labels) => labels[0],
			custom: async (factory, options) =>
				new Promise((resolve) => {
					assert.equal(options.overlayOptions.width, "100%");
					component = factory(
						{ terminal: { rows: 20 }, requestRender() {} },
						{ fg: (_c, s) => s, bold: (s) => s },
						{},
						resolve,
					);
					component.handleInput("\x1b");
				}),
			notify(message) {
				assert.match(message, /Review saved privately/);
			},
		},
	};
	await openGuidedReview(ctx, "resume", "");
	assert.equal((await loadReview(root, id)).ui.drafts["whole review"], "saved question");
	component.dispose();
});

test("closing a review saves once; teardown without Esc still saves", async () => {
	const root = join(getAgentDir(), "bro-reviews");
	const id = "7".repeat(64);
	const path = join(root, `${id}.json`);
	const record = {
		version: 1,
		id,
		snapshot: {
			target: { repository: "a/b", number: 77, head: "abcdef", base: "base" },
			mergeBase: "merge",
			gitDir: root,
			checkout: root,
			files: [],
			diff: "",
		},
		turns: [],
		ui: newReviewView(),
	};
	const exists = () => readFile(path).then(() => true, () => false);
	const open = (onMount) =>
		openGuidedReview(
			{
				mode: "tui",
				ui: {
					select: async (_title, labels) => labels.find((label) => label.includes("#77")),
					notify() {},
					custom: (factory) =>
						new Promise((resolve) => {
							const component = factory({ terminal: { rows: 20 }, requestRender() {} }, { fg: (_c, s) => s, bold: (s) => s }, {}, resolve);
							onMount(component, resolve);
						}),
				},
			},
			"resume",
			"",
		);
	try {
		// Esc: close() saves before done(); the host then disposes, which must not save again.
		await saveReview(root, record);
		let closed;
		await open((component) => {
			closed = component;
			component.handleInput("\x1b");
		});
		assert.equal(await exists(), true);
		await rm(path);
		closed.dispose();
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(await exists(), false, "dispose after a successful close does not save again");

		// Teardown that skips close() (e.g. a session switch) still saves.
		await saveReview(root, record);
		await open(async (component, resolve) => {
			await rm(path);
			component.dispose();
			resolve();
		});
		for (let i = 0; i < 50 && !(await exists()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(await exists(), true, "dispose without close saves");
	} finally {
		await rm(path, { force: true });
	}
});

test("resume warns about unreadable reviews but still opens a healthy one", async () => {
	const root = join(getAgentDir(), "bro-reviews"),
		id = "f".repeat(64),
		bad = join(root, "0".repeat(64) + ".json");
	await saveReview(root, {
		version: 1,
		id,
		snapshot: {
			target: { repository: "a/b", number: 9, head: "head", base: "base" },
			mergeBase: "base",
			gitDir: root,
			checkout: root,
			files: [],
			diff: "",
		},
		turns: [],
		ui: { ...newReviewView(), drafts: { "whole review": "" } },
	});
	await writeFile(bad, "{bad");
	const notices = [];
	let panel;
	try {
		await openGuidedReview(
			{
				mode: "tui",
				ui: {
					notify: (message, kind) => notices.push({ message, kind }),
					select: async (_title, labels) => labels.find((label) => label.includes("#9")),
					custom: (factory) =>
						new Promise((resolve) => {
							panel = factory(
								{ terminal: { rows: 20 }, requestRender() {} },
								{ fg: (_c, s) => s, bold: (s) => s },
								{},
								resolve,
							);
							panel.handleInput("\x1b");
						}),
				},
			},
			"resume",
			"",
		);
		panel.dispose();
		assert.equal(notices.filter((notice) => notice.kind === "warning").length, 1);
		assert.equal(notices[0].kind, "warning");
		assert.match(notices[0].message, /Original file left untouched/);
		assert.equal(await readFile(bad, "utf8"), "{bad");
	} finally {
		await rm(bad, { force: true });
	}
});

test("guide and contextual answer save through a fake backend then reopen without regeneration", async () => {
	const root = join(getAgentDir(), "bro-reviews");
	const id = "b".repeat(64);
	const bin = join(buildDir, "review-bin");
	await mkdir(bin, { recursive: true });
	const calls = join(bin, "calls");
	await writeFile(
		join(bin, "claude"),
		`#!/usr/bin/env node
const fs=require('node:fs'); const prompt=fs.readFileSync(0,'utf8');
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({prompt,cwd:process.cwd()})+'\\n');
const response=prompt.includes('Return only JSON:')?JSON.stringify({summary:'Captured purpose',assessment:{overview:'Quality considered',inspected:[],notExamined:['Tests not run'],warnings:[],findings:[{title:'Failure recovery gap',kind:'test-gap',severity:'medium',topic:0,scenario:'Save fails',impact:'Recovery untested',reasoning:'No test supplied',uncertainty:'Static review',fix:'Add recovery test',check:'Assert state retained',evidence:[]}]},topics:[{title:'Behavior',explanation:'Captured explanation',evidence:[]}]}):'A contextual answer';
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:response,stop_reason:'end_turn'}));
`,
	);
	await chmod(join(bin, "claude"), 0o755);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	await writeFile(
		join(getAgentDir(), "bro-settings.json"),
		JSON.stringify({
			version: 2,
			default: { backend: "claude", model: "test", effort: "default" },
		}),
	);
	const record = {
		version: 1,
		id,
		snapshot: {
			target: { repository: "a/b", number: 2, head: "abcdef", base: "base" },
			mergeBase: "merge",
			gitDir: root,
			checkout: bin,
			files: [],
			diff: "captured diff",
		},
		turns: [],
		ui: { ...newReviewView(), drafts: { "whole review": "Why this behavior?" } },
	};
	await saveReview(root, record);
	let component;
	let resolveClosed;
	let capturedError;
	const waitFor = async (predicate) => {
		for (let i = 0; i < 1500; i++) {
			if (await predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw Error("Timed out waiting for saved review");
	};
	const ready = () => /✓ Review ready/.test(component.render(103).join("\n"));
	const ctx = {
		mode: "tui",
		ui: {
			select: async (_title, labels) => labels.find((label) => label.includes("#2")),
			notify() {},
			custom: async (factory) =>
				new Promise((resolve) => {
					resolveClosed = resolve;
					component = factory(
						{ terminal: { rows: 32 }, requestRender() {} },
						{ fg: (_c, s) => s, bold: (s) => s },
						{},
						resolve,
					);
					void (async () => {
						component.handleInput("\r");
						component.handleInput("\r");
						component.handleInput("\r");
						await waitFor(async () => Boolean((await loadReview(root, id)).guide));
						// The file is written before the run settles; keys sent while still busy hit busy-only actions.
						await waitFor(() => ready());
						component.handleInput("\x1b");
						component.handleInput("\x1b[B");
						component.handleInput("\x1b[B");
						component.handleInput("\r");
						component.handleInput("\r");
						assert.match(component.render(103).join("\n"), /Failure recovery gap/);
						component.handleInput("\x1b");
						component.handleInput("\x1b");
						component.handleInput("\x1b[A");
						component.handleInput("\r");
						component.handleInput("\r");
						component.handleInput("\x1b[B");
						component.handleInput("\r");
						component.handleInput("Why this behavior?");
						component.handleInput("\r");
						await waitFor(async () => (await loadReview(root, id)).turns[0]?.status === "complete");
						await waitFor(() => ready());
						component.handleInput("\x1b");
						component.handleInput("\x1b");
						component.handleInput("\x1b");
					})().catch((error) => {
						capturedError = error;
						resolve();
					});
				}),
		},
	};
	try {
		await openGuidedReview(ctx, "resume", "Reader prefs");
		if (capturedError) throw capturedError;
		const saved = await loadReview(root, id);
		assert.equal(saved.guide.summary, "Captured purpose");
		assert.equal(saved.turns[0].answer, "A contextual answer");
		assert.equal(saved.guide.assessment.findings[0].title, "Failure recovery gap");
		const requests = (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
		assert.equal(requests.length, 2);
		assert.match(requests[1].prompt, /topic-1/);
		assert.match(requests[1].prompt, /Captured explanation/);
		assert.match(requests[0].prompt, /Reader prefs/);
		saved.ui.selected = "findings";
		saved.ui.screen = "finding";
		saved.ui.target = saved.guide.assessment.findings[0].id;
		saved.ui.pane = "contents";
		await saveReview(root, saved);
		const reopen = {
			mode: "tui",
			ui: {
				...ctx.ui,
				custom: async (factory) =>
					new Promise((resolve) => {
						const restored = factory(
							{ terminal: { rows: 20 }, requestRender() {} },
							{ fg: (_c, s) => s, bold: (s) => s },
							{},
							resolve,
						);
						assert.ok(restored.render(60).join("\n").includes("Behavior"));
						assert.match(restored.render(103).join("\n"), /Failure recovery gap/);
						restored.handleInput("\x1b");
					}),
			},
		};
		await openGuidedReview(reopen, "resume", "Reader prefs");
		// dispose() saves without returning its promise; disposing earlier lets that write land over the edited view above.
		component.dispose();
		assert.equal(
			(await readFile(calls, "utf8")).trim().split("\n").length,
			2,
			"reopen does not invoke backend",
		);
	} finally {
		process.env.PATH = oldPath;
		resolveClosed?.();
	}
});

test("successful evidence reload clears a previous transient read error", async () => {
	const root = join(getAgentDir(), "bro-reviews"),
		id = "e".repeat(64),
		bin = join(buildDir, "evidence-bin"),
		counter = join(bin, "reads");
	await mkdir(bin, { recursive: true });
	await writeFile(
		join(bin, "git"),
		`#!/usr/bin/env node
const fs=require('node:fs');const path=${JSON.stringify(counter)};
const count=fs.existsSync(path)?Number(fs.readFileSync(path,'utf8')):0;fs.writeFileSync(path,String(count+1));
if(!count){console.error('transient read error');process.exit(1);}setTimeout(()=>console.log('recovered source'),150);
`,
	);
	await chmod(join(bin, "git"), 0o755);
	await saveReview(root, {
		version: 1,
		id,
		snapshot: {
			target: { repository: "a/b", number: 5, head: "head", base: "base" },
			mergeBase: "base",
			gitDir: bin,
			checkout: bin,
			files: [],
			diff: "",
		},
		turns: [],
		guide: {
			summary: "Ready",
			topics: [{ id: "topic-1", title: "Behavior", explanation: "Detail", evidence: [] }],
			assessment: {
				overview: "Risk",
				inspected: [],
				notExamined: [],
				warnings: [],
				findings: [
					{
						id: "finding-1",
						title: "Issue",
						kind: "risk",
						severity: "low",
						scenario: "Trigger",
						impact: "Impact",
						reasoning: "Reason",
						uncertainty: "Static",
						fix: "Fix",
						check: "Check",
						evidence: [{ path: "file.ts", side: "new", start: 1, end: 1, valid: true }],
					},
				],
			},
		},
		ui: { ...newReviewView(), drafts: { "whole review": "" } },
	});
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	let component, resolveOpen;
	const ctx = {
		mode: "tui",
		ui: {
			notify() {},
			select: async (_t, labels) => labels.find((label) => label.includes("#5")),
			custom: (factory) =>
				new Promise((resolve) => {
					resolveOpen = resolve;
					component = factory(
						{ terminal: { rows: 32 }, requestRender() {} },
						{ fg: (_c, s) => s, bold: (s) => s },
						{},
						resolve,
					);
				}),
		},
	};
	const waitFor = async (fn) => {
		for (let i = 0; i < 500; i++) {
			if (fn()) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw Error("evidence reload timed out: " + component.render(103).join("\n"));
	};
	try {
		const opened = openGuidedReview(ctx, "resume", "");
		await waitFor(() => component);
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		component.handleInput("\r");
		component.handleInput("\x1b[6~");
		component.handleInput("\x1b[6~");
		await waitFor(() => component.render(103).join("\n").includes("transient read error"));
		component.handleInput("\r");
		// A second entry while the retry is in flight shares that read.
		component.handleInput("\x1b");
		component.handleInput("\r");
		component.handleInput("\x1b[6~");
		component.handleInput("\x1b[6~");
		await waitFor(() => component.render(103).join("\n").includes("recovered source"));
		assert.doesNotMatch(
			component.render(103).join("\n"),
			/transient read error|Captured code unavailable/,
		);
		component.handleInput("\x1b");
		component.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.equal(
			await readFile(counter, "utf8"),
			"2",
			"cached or in-flight evidence is not reread",
		);
		component.handleInput("\x1b");
		component.handleInput("\x1b");
		component.handleInput("\x1b");
		await opened;
		component.dispose();
	} finally {
		process.env.PATH = oldPath;
		resolveOpen?.();
		component?.dispose();
	}
});

test("stop-and-close waits for real process cancellation; save failure keeps modal open", async () => {
	const root = join(getAgentDir(), "bro-reviews"),
		id = "c".repeat(64),
		bin = join(buildDir, "stop-bin");
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "claude"), "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n");
	await chmod(join(bin, "claude"), 0o755);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	const record = {
		version: 1,
		id,
		snapshot: {
			target: { repository: "a/b", number: 3, head: "abc", base: "base" },
			mergeBase: "merge",
			gitDir: root,
			checkout: bin,
			files: [],
			diff: "",
		},
		turns: [],
		guide: { summary: "Ready", topics: [] },
		ui: { ...newReviewView(), drafts: { "whole review": "" } },
	};
	await saveReview(root, record);
	let panel,
		closed = false,
		resolveOpen;
	const ctx = {
		mode: "tui",
		ui: {
			select: async (_t, labels) => labels.find((x) => x.includes("#3")),
			notify() {},
			custom: (factory) =>
				new Promise((resolve) => {
					resolveOpen = resolve;
					panel = factory(
						{ terminal: { rows: 32 }, requestRender() {} },
						{ fg: (_c, s) => s, bold: (s) => s },
						{},
						() => {
							closed = true;
							resolve();
						},
					);
				}),
		},
	};
	try {
		const opened = openGuidedReview(ctx, "resume", "");
		while (!panel) await new Promise((r) => setTimeout(r, 10));
		panel.handleInput("\r");
		panel.handleInput("\r");
		panel.handleInput("\r");
		panel.handleInput("Question");
		panel.handleInput("\r");
		await new Promise((r) => setTimeout(r, 100));
		await rename(root, root + "-held");
		await writeFile(root, "blocks saving");
		panel.handleInput("\t");
		panel.handleInput("\t");
		panel.handleInput("\x1b");
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(closed, false);
		assert.match(panel.render(103).join("\n"), /Not saved/);
		await rm(root);
		await rename(root + "-held", root);
		panel.handleInput("\x1b");
		await opened;
		const saved = await loadReview(root, id);
		assert.equal(saved.turns[0].status, "partial");
		assert.equal(saved.ui.screen, "discussion");
		panel.dispose();
	} finally {
		process.env.PATH = oldPath;
		resolveOpen?.();
		try {
			await readFile(root);
			await rm(root);
			await rename(root + "-held", root);
		} catch {}
	}
});

test("failed backend answer keeps model text separate and can be restored for explicit resend", async () => {
	const root = join(getAgentDir(), "bro-reviews"),
		id = "9".repeat(64),
		bin = join(buildDir, "failure-bin");
	await mkdir(bin, { recursive: true });
	await writeFile(
		join(bin, "claude"),
		'#!/usr/bin/env node\nconsole.error("backend unavailable");process.exit(1);\n',
	);
	await chmod(join(bin, "claude"), 0o755);
	await saveReview(root, {
		version: 1,
		id,
		snapshot: {
			target: {
				repository: "a/b",
				number: 19,
				title: "Failure fixture",
				head: "head",
				base: "base",
			},
			mergeBase: "base",
			gitDir: bin,
			checkout: bin,
			files: [],
			diff: "",
		},
		turns: [],
		guide: { summary: "Ready", topics: [] },
		ui: {
			selected: "overview",
			screen: "reading",
			file: "",
			target: "whole review",
			pane: "contents",
			row: 0,
			offsets: {},
			drafts: {},
		},
	});
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	let component, resolveOpen;
	const ctx = {
		mode: "tui",
		ui: {
			notify() {},
			select: async (_t, labels) => {
				const label = labels.find((l) => l.includes("#19"));
				assert.match(label, /Failure fixture.*guide ready/);
				return label;
			},
			custom: (factory) =>
				new Promise((resolve) => {
					resolveOpen = resolve;
					component = factory(
						{ terminal: { rows: 32 }, requestRender() {} },
						{ fg: (_c, s) => s, bold: (s) => s },
						{},
						resolve,
					);
				}),
		},
	};
	const wait = async (fn) => {
		for (let i = 0; i < 500; i++) {
			if (await fn()) return;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw Error("failed answer timed out");
	};
	try {
		const opened = openGuidedReview(ctx, "resume", "");
		await wait(() => component);
		component.render(103);
		component.handleInput("\r");
		component.handleInput("\r");
		component.handleInput("\r");
		component.handleInput("Retry this question");
		component.handleInput("\r");
		await wait(async () => (await loadReview(root, id)).turns[0]?.status === "failed" && !component.busy);
		let saved = await loadReview(root, id);
		assert.equal(saved.turns[0].answer, "");
		assert.match(saved.turns[0].error, /backend unavailable/);
		assert.match(component.render(103).join("\n"), /Edit and resend/);
		component.handleInput("\t");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		await new Promise((r) => setTimeout(r, 300));
		saved = await loadReview(root, id);
		assert.equal(saved.ui.drafts["whole review"], "Retry this question");
		component.handleInput("\x1b");
		component.handleInput("\x1b");
		component.handleInput("\x1b");
		await opened;
		component.dispose();
	} finally {
		process.env.PATH = oldPath;
		resolveOpen?.();
		component?.dispose();
	}
});

test("acquisition shows observable elapsed progress and readable retry errors without network calls", async () => {
	const bin = join(buildDir, "acquisition-bin");
	await mkdir(bin, { recursive: true });
	await writeFile(
		join(bin, "gh"),
		'#!/usr/bin/env node\nsetTimeout(()=>{console.error("fixture permission denied");process.exit(1);},200);\n',
	);
	await chmod(join(bin, "gh"), 0o755);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	let panel, resolveOpen;
	try {
		const opened = openGuidedReview(
			{
				mode: "tui",
				cwd: bin,
				ui: {
					notify() {},
					custom: (factory, options) =>
						new Promise((resolve) => {
							assert.equal(options.overlayOptions.width, "70%");
							resolveOpen = resolve;
							panel = factory(
								{ terminal: { rows: 20 }, requestRender() {} },
								{ fg: (_c, s) => s, bold: (s) => s },
								{},
								resolve,
							);
						}),
				},
			},
			"https://github.com/a/b/pull/99",
			"",
		);
		assert.match(panel.render(36).join("\n"), /Bro · Review · 0s/);
		for (let i = 0; i < 500 && !panel.render(36).join("\n").includes("permission denied"); i++)
			await new Promise((r) => setTimeout(r, 10));
		assert.match(panel.render(36).join("\n"), /permission denied/);
		assert.match(panel.render(36).join("\n"), /Enter retry · Esc close/);
		assert.doesNotMatch(panel.render(36).join("\n"), /Error: gh/);
		panel.handleInput("\x1b");
		await opened;
		panel.dispose();
	} finally {
		process.env.PATH = oldPath;
		resolveOpen?.();
		panel?.dispose();
	}
});

test("a shell-capable review backend shows a non-fatal advisory during acquisition", async () => {
	const bin = join(buildDir, "advisory-bin");
	await mkdir(bin, { recursive: true });
	// gh answers PR identity, then the fetch fails: the advisory must not replace the fetch error.
	await writeFile(
		join(bin, "gh"),
		`#!/usr/bin/env node
const args = process.argv.slice(2);
// Pull metadata answers; the compare call (merge base) deliberately fails, which is the
// first network step after identity and the one the test wants to see reported.
if (args[0] === "api" && !args.some((arg) => String(arg).includes("/compare/"))) {
	console.log(JSON.stringify({
		title: "Fixture",
		body: "",
		html_url: "https://github.com/a/b/pull/7",
		base: { sha: "a".repeat(40), ref: "main", repo: { id: 1, full_name: "a/b" } },
		head: { sha: "b".repeat(40), ref: "topic" },
	}));
	process.exit(0);
}
console.error("fixture fetch offline");
process.exit(1);
`,
	);
	await chmod(join(bin, "gh"), 0o755);
	await writeFile(
		join(getAgentDir(), "bro-settings.json"),
		JSON.stringify({
			version: 2,
			default: { backend: "codex", model: "test", effort: "default" },
			overrides: { review: { backend: "codex", model: "test", effort: "default" } },
		}),
	);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	let panel;
	try {
		const opened = openGuidedReview(
			{
				mode: "tui",
				cwd: bin,
				ui: {
					notify() {},
					custom: (factory, options) =>
						new Promise((resolve) => {
							panel = factory(
								{ terminal: { rows: 20 }, requestRender() {} },
								{ fg: (_c, s) => s, bold: (s) => s },
								{},
								resolve,
							);
						}),
				},
			},
			"https://github.com/a/b/pull/7",
			"",
		);
		for (let i = 0; i < 500 && !panel.render(70).join("\n").includes("fixture fetch offline"); i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		const text = panel.render(70).join("\n");
		assert.match(text, /fixture fetch offline/, "the fetch error is still the reported failure");
		assert.match(text, /sandboxed shell in a read-only sandbox/, "the advisory shows");
		assert.match(text, /Enter retry · Esc close/, "the advisory must not disable retry");
		assert.doesNotMatch(text, /requires Claude or Muse|Claude or Muse file-only inspection\. Set/);
		panel.handleInput("\x1b");
		await opened;
		panel.dispose();
	} finally {
		process.env.PATH = oldPath;
		panel?.dispose();
	}
});

test("reopening a saved review shows the backend advisory without any model call", async () => {
	const root = join(getAgentDir(), "bro-reviews");
	const id = "d".repeat(64);
	await writeFile(
		join(getAgentDir(), "bro-settings.json"),
		JSON.stringify({
			version: 2,
			default: { backend: "codex", model: "test", effort: "default" },
			overrides: { review: { backend: "codex", model: "test", effort: "default" } },
		}),
	);
	await saveReview(root, {
		version: 1,
		id,
		snapshot: {
			target: { repository: "a/b", number: 42, head: "abcdef", base: "base" },
			mergeBase: "merge",
			gitDir: root,
			checkout: root,
			files: [],
			diff: "",
		},
		turns: [],
		guide: { summary: "Ready", topics: [] },
		ui: newReviewView(),
	});
	let panel;
	try {
		const opened = openGuidedReview(
			{
				mode: "tui",
				ui: {
					notify() {},
					select: async (_title, labels) => labels.find((label) => label.includes("#42")),
					custom: (factory) =>
						new Promise((resolve) => {
							panel = factory(
								{ terminal: { rows: 32 }, requestRender() {} },
								{ fg: (_c, s) => s, bold: (s) => s },
								{},
								resolve,
							);
						}),
				},
			},
			"resume",
			"",
		);
		while (!panel) await new Promise((resolve) => setTimeout(resolve, 10));
		let text = "";
		for (let i = 0; i < 200; i++) {
			text = panel.render(110).join("\n");
			if (/read-only sandbox/.test(text)) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.match(text, /read-only sandbox/);
		assert.match(text, /Claude, Muse, or Pi is recommended for/);
		assert.match(text, /untrusted PRs\./);
		assert.doesNotMatch(text, /Request failed/);
		panel.handleInput("\x1b");
		await opened;
	} finally {
		panel?.dispose();
	}
});
