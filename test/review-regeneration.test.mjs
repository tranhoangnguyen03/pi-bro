import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, chmod, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initTheme, getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildDir } from "./test-build.mjs";
const { openGuidedReview } = await import(pathToFileURL(join(buildDir, "review-ui.js")).href);
const { saveReview, loadReview } = await import(pathToFileURL(join(buildDir, "review.js")).href);
const { newReviewView } = await import(pathToFileURL(join(buildDir, "review-modal.js")).href);
initTheme();
const root = join(getAgentDir(), "bro-reviews");
const wait = async (fn) => {
	for (let i = 0; i < 1000; i++) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw Error("wait timed out");
};
const enter = "\r",
	esc = "\x1b",
	down = "\x1b[B";

test("single-guide regeneration confirms, retains discussions and aborts invalid or cancelled replacement", async () => {
	const bin = join(buildDir, "regenerate-bin"),
		mode = join(bin, "mode"),
		calls = join(bin, "calls"),
		validating = join(bin, "validating");
	await mkdir(bin, { recursive: true });
	await mkdir(getAgentDir(), { recursive: true });
	await writeFile(
		join(bin, "claude"),
		`#!/usr/bin/env node
const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},'call\\n');
const mode=fs.readFileSync(${JSON.stringify(mode)},'utf8');
const response=mode==='bad'?'not JSON':JSON.stringify({summary:'Fresh guide',assessment:{overview:'Quality considered',inspected:[],notExamined:['Tests not run'],warnings:[],findings:[]},topics:[{title:'New topic',explanation:'Fresh explanation',evidence:mode==='slow'?[{path:'file.ts',side:'new',start:1,end:1}]:[]}]});
setTimeout(()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:response,stop_reason:'end_turn'})),100);
`,
	);
	await writeFile(
		join(bin, "git"),
		`#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(validating)},'yes');setTimeout(()=>console.log('source'),1500);
`,
	);
	await chmod(join(bin, "claude"), 0o755);
	await chmod(join(bin, "git"), 0o755);
	await writeFile(mode, "good");
	await writeFile(
		join(getAgentDir(), "bro-settings.json"),
		JSON.stringify({
			version: 2,
			default: { backend: "claude", model: "test", effort: "default" },
		}),
	);
	const id = "d".repeat(64),
		original = {
			version: 1,
			id,
			snapshot: {
				target: { repository: "a/b", number: 4, head: "captured", base: "base" },
				mergeBase: "merge",
				gitDir: bin,
				checkout: bin,
				files: [],
				diff: "same captured diff",
				capturedAt: "before",
			},
			guide: {
				summary: "Original",
				topics: [
					{ id: "topic-1", title: "Old topic", explanation: "Original explanation", evidence: [] },
				],
			},
			turns: [
				{ target: "topic-1", question: "Old question", answer: "Old answer", status: "complete" },
			],
			ui: { ...newReviewView(), drafts: { "topic-1": "draft" } },
		};
	await saveReview(root, original);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	let panel,
		resolveOpen,
		approved = false,
		confirmations = 0,
		hidden = false;
	const stages = [];
	const ctx = {
		mode: "tui",
		ui: {
			select: async (_t, labels) => labels[0],
			confirm: async (_title, message) => {
				assert.equal(hidden, true, "review overlay must not cover the confirmation");
				assert.match(message, /captured revision captured/);
				confirmations++;
				return approved;
			},
			notify() {},
			custom: (factory, options) =>
				new Promise((resolve) => {
					options.onHandle?.({
						setHidden(value) {
							hidden = value;
						},
					});
					resolveOpen = resolve;
					panel = factory(
						{
							terminal: { rows: 32 },
							requestRender() {
								if (panel) stages.push(panel.render(103)[2]);
							},
						},
						{ fg: (_c, s) => s, bold: (s) => s },
						{},
						resolve,
					);
				}),
		},
	};
	const open = () => {
		panel = undefined;
		return openGuidedReview(ctx, "resume", "preferences");
	};
	const regenerate = () => {
		panel.handleInput(enter);
		panel.handleInput(enter);
		panel.handleInput(down);
		panel.handleInput(enter);
	};
	const close = async (opened) => {
		panel.handleInput(esc);
		panel.handleInput(esc);
		await opened;
		panel.dispose();
	};
	try {
		let opened = open();
		await wait(() => panel);
		regenerate();
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(confirmations, 1);
		assert.equal(await readFile(calls, "utf8").catch(() => ""), "");
		approved = true;
		panel.handleInput(esc);
		regenerate();
		await wait(async () => (await loadReview(root, id)).guide.summary === "Fresh guide");
		let saved = await loadReview(root, id);
		assert.equal(saved.guideVersions, undefined);
		assert.equal(saved.turns[0].target, "topic-1");
		assert.equal(saved.ui.drafts["topic-1"], "draft");
		assert.match(saved.targetContexts["topic-1"].text, /Original explanation/);
		assert.match(panel.render(103)[2], /Review ready/);
		assert.notEqual(saved.guide.topics[0].id, "topic-1");
		panel.handleInput(esc);
		for (let i = 0; i < 5; i++) panel.handleInput(down);
		panel.handleInput(enter);
		assert.match(panel.render(103).join("\n"), /Earlier.*Old topic/);
		panel.handleInput(enter);
		assert.match(panel.render(103).join("\n"), /Old answer/);
		panel.handleInput(esc);
		panel.handleInput(esc);
		panel.handleInput(esc);
		await opened;
		panel.dispose();
		// Malformed regeneration leaves both good versions untouched.
		saved = await loadReview(root, id);
		saved.ui.selected = "overview";
		saved.ui.screen = "reading";
		saved.ui.pane = "contents";
		await saveReview(root, saved);
		await writeFile(mode, "bad");
		opened = open();
		await wait(() => panel);
		regenerate();
		await wait(async () => (await loadReview(root, id)).guideAttempt?.status === "failed");
		assert.equal((await loadReview(root, id)).guideVersions, undefined);
		assert.equal((await loadReview(root, id)).guideAttempt.text, "not JSON");
		assert.match(panel.render(103)[2], /Regeneration failed/);
		await close(opened);
		// Cancellation while parseGuide is checking references must not install a version.
		await writeFile(mode, "slow");
		opened = open();
		await wait(() => panel);
		regenerate();
		await wait(async () => Boolean(await readFile(validating, "utf8").catch(() => "")));
		await close(opened);
		saved = await loadReview(root, id);
		assert.equal(saved.guideVersions, undefined);
		assert.equal(saved.guide.summary, "Fresh guide");
		assert.equal(saved.snapshot.diff, "same captured diff");
		// A generated result survives a failed disk save, but is not offered as ready yet.
		await rm(validating, { force: true });
		opened = open();
		await wait(() => panel);
		regenerate();
		await wait(async () => Boolean(await readFile(validating, "utf8").catch(() => "")));
		await rename(root, root + "-held");
		await writeFile(root, "blocks saving");
		await wait(() => panel.render(103).join("\n").includes("Review not saved"));
		assert.doesNotMatch(panel.render(103).join("\n"), /\[Open new guide\]/);
		await rm(root);
		await rename(root + "-held", root);
		panel.handleInput(enter); // Retry saving is the first contextual action.
		await wait(async () => Boolean((await loadReview(root, id)).guide.topics[0].evidence.length));
		saved = await loadReview(root, id);
		assert.equal(saved.guide.summary, "Fresh guide");
		assert.equal(saved.guideVersions, undefined);
		await close(opened);
		assert.ok(stages.some((line) => line.includes("Checking references")));
		assert.ok(stages.some((line) => line.includes("Saving review")));
		assert.ok(stages.some((line) => line.includes("Inspecting captured changes")));
		assert.ok(!panel.render(103)[2].includes("Checking references"));
		assert.equal(
			(await readFile(calls, "utf8")).trim().split("\n").length,
			4,
			"switching/reopening/saving do not regenerate",
		);
	} finally {
		process.env.PATH = oldPath;
		resolveOpen?.();
		panel?.dispose();
		try {
			await readFile(root);
			await rm(root);
			await rename(root + "-held", root);
		} catch {}
	}
});
