import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme();
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildDir } from "./test-build.mjs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { ReviewModal, newReviewView } = await import(
	pathToFileURL(join(buildDir, "review-modal.js")).href
);
const makeRecord = () => ({
	version: 1,
	id: "a".repeat(64),
	snapshot: {
		target: { repository: "a/b", number: 1, head: "abc123" },
		files: [
			{ path: "first.ts", status: "M" },
			{ path: "second.ts", status: "A" },
		],
		diff: "diff --git a/first.ts b/first.ts\n-first\n+changed\ndiff --git a/second.ts b/second.ts\n+second",
	},
	guide: {
		summary: "Purpose",
		topics: [
			{
				id: "topic-1",
				title: "Behavior",
				explanation: "Explanation",
				evidence: [{ path: "first.ts", side: "new", start: 1, end: 2, valid: true }],
			},
		],
	},
	turns: [],
	composer: "",
	view: "guide",
	topic: 0,
	offset: 0,
	focus: "",
});
const make = (record = makeRecord(), controls = {}) =>
	new ReviewModal(
		record,
		{ terminal: { rows: 32 }, requestRender() {} },
		{ fg: (_c, s) => s, bold: (s) => s },
		{ ask() {}, prepare() {}, stop() {}, close() {}, changed() {}, ...controls },
	);
const down = "\x1b[B",
	enter = "\r",
	esc = "\x1b";

test("every screen has bounded chrome, contextual actions only and pane-local composer", () => {
	const modal = make();
	for (const selected of ["overview", "topic-1", "files", "questions", "versions", "close"])
		for (const screen of ["reading", "file", "discussion"]) {
			Object.assign(modal.view, {
				selected,
				screen,
				file: "first.ts",
				target: "topic-1",
				pane: "detail",
			});
			for (const [width, rows] of [
				[103, 32],
				[56, 20],
				[80, 24],
				[35, 17],
				[10, 5],
			]) {
				modal.tui.terminal.rows = rows;
				const lines = modal.render(width);
				assert.ok(lines.length <= rows - 2, `${selected}/${screen}/${width}`);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				assert.doesNotMatch(
					lines.join("\n"),
					/Previous topic|Next topic|Start walkthrough|Browse changed files|\[Save and close\]/,
				);
			}
		}
	modal.tui.terminal.rows = 32;
	modal.view.selected = "overview";
	modal.view.screen = "reading";
	modal.render(103);
	modal.handleInput(enter);
	const right = modal
		.render(103)
		.map((line) => line.split(" │ ")[1] ?? "")
		.join("\n");
	assert.doesNotMatch(right, /Save and close/);
});

test("file rows open one diff, questions retain stable targets, Escape returns directly", () => {
	const sent = [];
	const modal = make(undefined, { ask: (target, q) => sent.push({ target, q }) });
	modal.render(103);
	modal.handleInput(down);
	modal.handleInput(down);
	modal.handleInput(enter);
	modal.handleInput(down);
	modal.handleInput(enter);
	assert.equal(modal.view.file, "second.ts");
	assert.equal(modal.view.screen, "file");
	assert.match(modal.render(103).join("\n"), /\+second/);
	assert.doesNotMatch(modal.render(103).join("\n"), /\+changed/);
	modal.handleInput(enter);
	modal.handleInput(enter);
	modal.handleInput("Why?");
	assert.equal(modal.view.drafts["file:second.ts"], "Why?");
	modal.handleInput(enter);
	assert.deepEqual(sent, [{ target: "file:second.ts", q: "Why?" }]);
	modal.handleInput(esc);
	assert.equal(modal.view.screen, "file");
	modal.handleInput(esc);
	assert.equal(modal.view.screen, "reading");
	assert.equal(modal.view.row, 1);
});

test("guide arrival preserves selection and drafts; untrusted titles cannot inject escapes", () => {
	const record = makeRecord();
	delete record.guide;
	record.ui = newReviewView();
	record.ui.selected = "files";
	const modal = make(record);
	modal.render(103);
	modal.handleInput(enter);
	modal.handleInput(enter);
	modal.handleInput(enter);
	modal.handleInput(enter);
	modal.handleInput("draft");
	record.guide = {
		summary: "New guide",
		topics: [{ id: "topic-1", title: "bad\x1b[2J title", explanation: "ok", evidence: [] }],
	};
	assert.equal(modal.view.selected, "files");
	assert.equal(modal.view.target, "file:first.ts");
	assert.equal(modal.view.drafts["file:first.ts"], "draft");
	assert.ok(!modal.render(103).join("\n").includes("\x1b[2J"));
	const restored = make(JSON.parse(JSON.stringify(record)));
	assert.equal(restored.view.target, "file:first.ts");
	assert.equal(restored.view.drafts["file:first.ts"], "draft");
});

test("new answer follows the latest text until the reader scrolls away", () => {
	const record = makeRecord();
	let turn;
	const modal = make(record, {
		ask(target, question) {
			turn = { target, question, answer: "", status: "partial" };
			record.turns.push(turn);
		},
	});
	modal.handleInput(down);
	modal.handleInput(enter);
	modal.handleInput(enter);
	modal.handleInput(enter);
	modal.handleInput("Why");
	modal.handleInput(enter);
	turn.answer = Array.from({ length: 70 }, (_, i) => `line ${i}`).join("\n");
	assert.match(modal.render(103).join("\n"), /line 69/);
	modal.handleMouse({ type: "wheel", x: 70, y: 8, wheelDelta: -8 });
	const position = Object.values(modal.view.offsets).at(-1);
	turn.answer += "\nline 70";
	modal.render(103);
	assert.equal(Object.values(modal.view.offsets).at(-1), position);
});

test("wheel scrolling is pane-local, selection-neutral and pauses answer following", () => {
	const record = makeRecord();
	record.guide.topics = Array.from({ length: 40 }, (_, i) => ({
		id: `topic-${i + 1}`,
		title: `Topic ${i + 1}`,
		explanation: Array.from({ length: 70 }, (_, n) => `explanation ${n}`).join("\n"),
		evidence: [],
	}));
	const modal = make(record);
	modal.tui.terminal.columns = 110;
	modal.handleInput(down);
	modal.render(103);
	const selected = modal.view.selected,
		pane = modal.view.pane;
	modal.handleMouse({ type: "wheel", x: 5, y: 8, wheelDelta: 8 });
	const leftScrolled = modal.render(103).join("\n");
	assert.doesNotMatch(leftScrolled, / 1\. Topic 1 /);
	assert.equal(modal.view.selected, selected);
	assert.equal(modal.view.pane, pane);
	const key = `${selected}:reading:`;
	modal.handleMouse({ type: "wheel", x: 60, y: 8, wheelDelta: 4 });
	modal.render(103);
	assert.equal(modal.view.offsets[key], 4);
	assert.equal(modal.view.pane, pane);
	const snapshot = JSON.stringify(modal.view);
	modal.handleMouse({ type: "wheel", x: 60, y: 1, wheelDelta: 4 });
	assert.equal(JSON.stringify(modal.view), snapshot);
	modal.handleInput("\x1b[<65;64;10M");
	modal.render(103);
	assert.equal(modal.view.offsets[key], 7, "raw SGR coordinates translated from centered overlay");
	modal.handleInput("\x1b[<64;64;10M");
	modal.render(103);
	assert.equal(modal.view.offsets[key], 4);
	modal.handleInput(down);
	assert.equal(modal.view.selected, "topic-2");
	assert.match(modal.render(103).join("\n"), /› 2\. Topic 2/);
	modal.tui.terminal.rows = 20;
	modal.render(56);
	modal.handleMouse({ type: "wheel", x: 10, y: 7, wheelDelta: 5 });
	assert.equal(modal.view.selected, "topic-2");
	modal.handleInput(enter);
	modal.render(56);
	modal.handleMouse({ type: "wheel", x: 10, y: 7, wheelDelta: 5 });
	modal.render(56);
	assert.equal(modal.view.offsets["topic-2:reading:"], 5);
});

test("wheel scrolls file lists without moving their row or stealing input focus", () => {
	const record = makeRecord();
	record.snapshot.files = Array.from({ length: 60 }, (_, i) => ({
		path: `file-${i}`,
		status: "M",
	}));
	const modal = make(record);
	modal.handleInput(down);
	modal.handleInput(down);
	modal.handleInput(enter);
	modal.render(103);
	modal.handleMouse({ type: "wheel", x: 70, y: 8, wheelDelta: 10 });
	modal.render(103);
	assert.equal(modal.view.row, 0);
	assert.equal(modal.view.offsets["files:reading:"], 10);
	modal.handleInput(down);
	modal.render(103);
	assert.equal(modal.view.row, 1);
	assert.equal(modal.view.offsets["files:reading:"], 0);
});

test("persistent preparation header becomes quiet completion without changing location", () => {
	const record = makeRecord();
	delete record.guide;
	const modal = make(record);
	modal.busy = true;
	modal.startedAt = Date.now() - 55000;
	for (const selected of ["overview", "files", "questions", "close"]) {
		modal.view.selected = selected;
		const lines = modal.render(103);
		assert.match(lines[2], /Preparing review guide · 55s/);
		assert.match(modal.render(56)[2], /Preparing review guide/);
	}
	modal.view.selected = "files";
	modal.view.screen = "file";
	modal.view.file = "first.ts";
	const before = { ...modal.view };
	record.guide = {
		summary: "Ready",
		topics: [{ id: "topic-1", title: "One", explanation: "ok", evidence: [] }],
	};
	modal.busy = false;
	assert.match(modal.render(103)[2], /✓ Guide ready · 1 topic/);
	assert.equal(modal.view.selected, before.selected);
	assert.equal(modal.view.screen, before.screen);
	assert.equal(modal.view.pane, before.pane);
});

test("Markdown explanation and answers are separated from numbered captured code and diff hunks", () => {
	const record = makeRecord();
	record.guide.topics[0].explanation = "A **bold change** with `inline code`.";
	record.guide.topics[0].evidence[0] = {
		path: "first.ts",
		side: "new",
		start: 9,
		end: 10,
		valid: true,
	};
	const modal = make(record);
	modal.evidence.set("first.ts:new:9:10", "const x = 1;\nconst y = 2;");
	modal.handleInput(down);
	const text = stripVTControlCharacters(modal.render(103).join("\n"));
	assert.doesNotMatch(text, /\*\*bold change\*\*|`inline code`/);
	assert.match(text, /CAPTURED CODE/);
	assert.match(text, /9 │ const x/);
	assert.match(text, /10 │ const y/);
	record.snapshot.diff =
		"diff --git a/first.ts b/first.ts\n--- a/first.ts\n+++ b/first.ts\n@@ -9,2 +9,2 @@\n context\n-old\n+new\n\\ No newline at end of file";
	record.snapshot.files = [{ path: "first.ts", status: "M" }];
	modal.view.selected = "files";
	modal.view.screen = "file";
	modal.view.file = "first.ts";
	const diff = stripVTControlCharacters(modal.render(103).join("\n"));
	assert.match(diff, /CHANGES/);
	assert.match(diff, /9\s+9 │ {2}context/);
	assert.match(diff, /10\s+│ -old/);
	assert.match(diff, /10 │ \+new/);
	modal.view.screen = "discussion";
	modal.view.target = "topic-1";
	record.turns.push({
		target: "topic-1",
		question: "Why?",
		answer: "Because **it matters**.",
		status: "complete",
	});
	assert.doesNotMatch(stripVTControlCharacters(modal.render(103).join("\n")), /\*\*it matters\*\*/);
});

test("only the active answer is working; failed regeneration retains the current guide", () => {
	const record = makeRecord();
	const interrupted = {
		target: "topic-1",
		question: "Stopped earlier",
		answer: "",
		status: "partial",
	};
	record.turns.push(interrupted);
	const modal = make(record);
	modal.openDiscussion("topic-1");
	modal.busy = true;
	modal.operation = "regenerate";
	modal.startedAt = Date.now();
	let text = stripVTControlCharacters(modal.render(103).join("\n"));
	assert.match(text, /Stopped · partial answer kept/);
	assert.doesNotMatch(text, /Working…|Answering…/);
	modal.operation = "answer";
	modal.activeTurn = {
		target: "whole review",
		question: "Another request",
		answer: "",
		status: "partial",
	};
	text = stripVTControlCharacters(modal.render(103).join("\n"));
	assert.match(text, /Stopped · partial answer kept/);
	assert.doesNotMatch(text, /Working…/);
	modal.activeTurn = interrupted;
	text = stripVTControlCharacters(modal.render(103).join("\n"));
	assert.match(text, /Working…|Answering…/);
	modal.busy = false;
	record.guideAttempt = { status: "failed", text: "", error: "Later regeneration failed" };
	modal.view.selected = "overview";
	modal.view.screen = "reading";
	text = stripVTControlCharacters(modal.render(103).join("\n"));
	assert.match(text.split("\n")[2], /current guide kept/);
	assert.match(text, /Later regeneration failed/);
	assert.doesNotMatch(text, /Open new guide|Guide versions/);
});

test("type-change diff sections stay with their file and the index is reused", async () => {
	const { captureReview } = await import(pathToFileURL(join(buildDir, "review-source.js")).href);
	const repo = join(buildDir, "type-change");
	await mkdir(repo);
	execFileSync("git", ["init", "-q", repo]);
	const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
	git("config", "user.email", "fixture@invalid");
	git("config", "user.name", "Fixture");
	await writeFile(join(repo, "b"), "regular file\n");
	await writeFile(join(repo, "z"), "old z\n");
	git("add", ".");
	git("commit", "-qm", "initial");
	const initial = git("rev-parse", "HEAD");
	git("update-index", "--add", "--cacheinfo", `160000,${initial},zz`);
	git("commit", "-qm", "base");
	const base = git("rev-parse", "HEAD");
	await rm(join(repo, "b"));
	await symlink("z", join(repo, "b"));
	await writeFile(join(repo, "z"), "new z\n");
	git("add", ".");
	git("update-index", "--add", "--cacheinfo", `160000,${base},zz`);
	git("commit", "-qm", "head");
	const head = git("rev-parse", "HEAD");
	let snapshot = await captureReview(
		{ host: "github.com", repositoryId: 1, repository: "a/b", number: 1, base, head },
		join(buildDir, "type-store"),
		new AbortController().signal,
		repo,
	);
	// Managed stores still read user config; capture must pin the submodule output format.
	execFileSync("git", ["--git-dir", snapshot.gitDir, "config", "diff.submodule", "log"]);
	snapshot = await captureReview(
		snapshot.target,
		join(buildDir, "type-store"),
		new AbortController().signal,
		repo,
	);
	assert.match(snapshot.diff, /diff --git a\/zz b\/zz/);
	const record = makeRecord();
	record.snapshot = snapshot;
	const modal = make(record);
	modal.view.selected = "files";
	modal.view.screen = "file";
	modal.view.file = "z";
	assert.match(stripVTControlCharacters(modal.render(103).join("\n")), /\+new z/);
	assert.doesNotMatch(stripVTControlCharacters(modal.render(103).join("\n")), /regular file/);
	// After initial indexing, unchanged snapshot.diff need not be accessed again.
	Object.defineProperty(snapshot, "diff", {
		get() {
			throw Error("diff reparsed during render");
		},
	});
	modal.render(103);
	modal.view.file = "b";
	const changed = stripVTControlCharacters(modal.render(103).join("\n"));
	assert.match(changed, /-regular file/);
	assert.match(changed, /\+z/);
	const damaged = makeRecord();
	damaged.snapshot = {
		...damaged.snapshot,
		diff: "diff --git a/b.ts b/b.ts\n@@ -1 +1 @@\n-wrong file\n+wrong file\n",
		files: [
			{ path: "a.ts", status: "M" },
			{ path: "b.ts", status: "M" },
		],
	};
	const guarded = make(damaged);
	guarded.view.screen = "file";
	guarded.view.file = "a.ts";
	assert.match(guarded.render(103).join("\n"), /Diff inventory mismatch/);
	assert.doesNotMatch(guarded.render(103).join("\n"), /wrong file/);
});

test("combined review exposes ranked findings, evidence, suggestions and truthful coverage without Ask", () => {
	const record = makeRecord();
	const copied = [];
	record.guide.assessment = {
		overview: "Writes risk losing data",
		inspected: ["first.ts"],
		notExamined: ["Integration not checked"],
		warnings: [],
		findings: [
			{
				id: "finding-1",
				topicId: "topic-1",
				title: "Lost write",
				kind: "defect",
				severity: "high",
				scenario: "Writes overlap",
				impact: "Data loss",
				reasoning: "Both overwrite",
				uncertainty: "Static assessment",
				fix: "Serialize writes",
				check: "Assert both survive",
				evidence: [{ path: "first.ts", side: "new", start: 1, end: 2, valid: true }],
			},
			{
				id: "finding-2",
				title: "Caller contract",
				kind: "test-gap",
				severity: "medium",
				scenario: "Caller fails",
				impact: "Broken API",
				reasoning: "Mismatch",
				uncertainty: "Not run",
				fix: "Update callers",
				check: "Test caller",
				evidence: [],
			},
		],
	};
	const modal = make(record, { copy: (text) => copied.push(text) });
	modal.evidence.set("first.ts:new:1:2", "captured source");
	let text = stripVTControlCharacters(modal.render(103).join("\n"));
	assert.match(text, /QUALITY ASSESSMENT/);
	assert.match(text, /Lost write/);
	modal.view.selected = "findings";
	modal.view.pane = "detail";
	modal.syncGuideView();
	modal.render(103);
	modal.handleInput(enter);
	assert.equal(modal.view.screen, "finding");
	text = stripVTControlCharacters(modal.render(103).join("\n"));
	assert.match(text, /Writes overlap/);
	assert.match(text, /Suggested fix|SUGGESTED FIX/);
	assert.match(text, /Serialize writes/);
	modal.handleInput(enter);
	modal.handleInput(down);
	modal.handleInput(enter);
	assert.equal(copied.length, 1);
	assert.match(copied[0], /Lost write|Serialize writes/);
	assert.match(copied[0], /not applied/);
	modal.handleInput(esc);
	assert.equal(modal.view.selected, "findings");
	assert.equal(modal.view.screen, "reading");
	modal.view.selected = "topic-1";
	text = stripVTControlCharacters(modal.render(103).join("\n"));
	assert.match(text, /Lost write/);
	for (const [width, rows] of [
		[103, 32],
		[56, 20],
	]) {
		modal.tui.terminal.rows = rows;
		modal.view.screen = "finding";
		modal.view.target = "finding-1";
		const lines = modal.render(width);
		assert.ok(lines.length <= rows - 2);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	const legacy = make();
	assert.match(legacy.render(103).join("\n"), /Quality assessment not performed/);
});

test("earlier finding questions retain compact context without guide switching", () => {
	const record = makeRecord();
	const finding = {
		id: "old-finding",
		title: "Old issue",
		kind: "risk",
		severity: "low",
		scenario: "Old trigger",
		impact: "Old impact",
		reasoning: "Old reasoning",
		uncertainty: "Static",
		fix: "Old fix",
		check: "Old check",
		evidence: [],
	};
	record.guide.assessment = {
		overview: "Old assessment",
		inspected: [],
		notExamined: [],
		warnings: [],
		findings: [{ ...finding, id: "earlier", severity: "high" }, finding],
	};
	record.guide = { summary: "New", topics: [] };
	record.targetContexts = {
		"old-finding": { title: "Old issue", text: "Old trigger and reasoning" },
	};
	record.turns = [
		{
			target: "old-finding",
			question: "Challenge",
			answer: "Original reasoning retained",
			status: "complete",
		},
	];
	const modal = make(record);
	modal.view.selected = "questions";
	modal.view.pane = "detail";
	modal.syncGuideView();
	modal.render(103);
	modal.handleInput(enter);
	assert.match(modal.render(103).join("\n"), /Original reasoning retained/);
	assert.match(modal.render(103).join("\n"), /Old trigger/);
	modal.handleInput(esc);
	assert.equal(modal.view.screen, "reading");
	assert.equal(modal.view.selected, "questions");
	assert.doesNotMatch(modal.render(103).join("\n"), /Guide versions/);
});

test("findings have distinct severity rails and stages expose actual work without percentages", () => {
	const record = makeRecord();
	record.guide.assessment = {
		overview: "Dense assessment ".repeat(60),
		inspected: [],
		notExamined: [],
		warnings: [],
		findings: [
			{
				id: "f",
				title: "Losing a saved write",
				kind: "defect",
				severity: "high",
				scenario: "Two writes overlap",
				impact: "Data loss",
				reasoning: "Overwrites",
				uncertainty: "Static",
				fix: "Serialize",
				check: "Test two writes",
				evidence: [],
			},
		],
	};
	const calls = [];
	const modal = new ReviewModal(
		record,
		{ terminal: { rows: 32 }, requestRender() {} },
		{
			fg: (color, text) => {
				calls.push({ color, text });
				return text;
			},
			bold: (text) => text,
		},
		{
			ask() {},
			prepare() {},
			regenerate() {},
			retrySave() {},
			openGuide() {},
			stop() {},
			copy() {},
			close() {},
			changed() {},
		},
	);
	let lines = modal.render(103),
		text = lines.join("\n");
	assert.match(text, /FINDINGS TO EXAMINE/);
	assert.match(text, /▌ HIGH · defect/);
	assert.ok(text.indexOf("Losing a saved write") < text.indexOf("Dense assessment"));
	assert.ok(calls.some((call) => call.color === "error" && call.text.includes("HIGH")));
	modal.view.selected = "findings";
	modal.view.pane = "detail";
	modal.syncGuideView();
	modal.handleInput(enter);
	assert.match(modal.render(103).join("\n"), /HIGH · defect.*Losing a saved write/);
	modal.busy = true;
	modal.operation = "regenerate";
	modal.startedAt = Date.now() - 20000;
	for (const [step, detail] of [
		["investigate", "Inspecting captured changes"],
		["receive", "Receiving response · 4k chars"],
		["check", "Checking references · 3 checked"],
		["save", "Saving review"],
	]) {
		modal.stage = { step, detail };
		for (const [width, rows] of [
			[103, 32],
			[56, 20],
		]) {
			modal.tui.terminal.rows = rows;
			lines = modal.render(width);
			assert.match(lines[2], new RegExp(detail.split(" · ")[0]));
			assert.match(lines[2], /20s/);
			assert.doesNotMatch(lines[2], /\d+%/);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines.length <= rows - 2);
		}
	}
});

test("replacement drafts remain reachable in Questions without a sent turn", () => {
	const record = makeRecord();
	record.guide = { summary: "New", topics: [] };
	record.ui = newReviewView();
	record.ui.drafts["old-topic"] = "half typed";
	record.targetContexts = { "old-topic": { title: "Old topic", text: "Original explanation" } };
	const modal = make(record);
	modal.view.selected = "questions";
	modal.view.pane = "detail";
	modal.syncGuideView();
	assert.match(modal.render(103).join("\n"), /Draft.*Earlier.*Old topic/);
	modal.handleInput(enter);
	assert.equal(modal.view.target, "old-topic");
	assert.equal(modal.view.screen, "discussion");
	assert.match(stripVTControlCharacters(modal.render(103).join("\n")), /half typed/);
});

test("finding detail keeps its title while scrolling and coverage uses spaced lists", () => {
	const record = makeRecord();
	record.guide.assessment = {
		overview: "Risk",
		inspected: ["first.ts", "second.ts"],
		notExamined: ["Runtime not checked", "Backend not checked"],
		warnings: [],
		findings: [
			{
				id: "f",
				title: "Keep this finding visible",
				kind: "risk",
				severity: "low",
				scenario: "trigger ".repeat(80),
				impact: "impact",
				reasoning: "reason",
				uncertainty: "uncertain",
				fix: "fix suggestion",
				check: "check suggestion",
				evidence: [],
			},
		],
	};
	const modal = make(record);
	modal.view.selected = "findings";
	modal.view.screen = "finding";
	modal.view.target = "f";
	modal.view.pane = "detail";
	modal.syncGuideView();
	for (const [width, rows] of [
		[103, 32],
		[56, 20],
		[36, 18],
	]) {
		modal.tui.terminal.rows = rows;
		modal.view.offsets["findings:finding:f"] = 999;
		let lines = modal.render(width);
		assert.ok(lines.length <= rows - 2);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines[4], /Keep this|LOW/);
		assert.doesNotMatch(lines.join("\n"), /SUGGESTED FIX · NOT APPLIED OR VERIFIED/);
	}
	modal.tui.terminal.rows = 32;
	modal.view.offsets["findings:finding:f"] = 0;
	modal.render(103);
	modal.handleMouse({ type: "wheel", x: 60, y: 4, wheelDelta: 3 });
	assert.equal(
		modal.view.offsets["findings:finding:f"],
		3,
		"title is part of the reading scroll area",
	);
	modal.handleMouse({ type: "wheel", x: 60, y: 5, wheelDelta: 3 });
	assert.equal(modal.view.offsets["findings:finding:f"], 6);
	modal.view.screen = "reading";
	modal.view.selected = "coverage";
	const text = stripVTControlCharacters(modal.render(103).join("\n"));
	assert.match(text, /• first.ts/);
	assert.match(text, /• second.ts/);
	assert.match(text, /• Runtime not checked/);
	assert.doesNotMatch(text, /first.ts, second.ts/);
});

test("tiny viewport ignores hidden actions but permits closing", () => {
	let asked = 0,
		closed = 0;
	const modal = make(undefined, {
		ask() {
			asked++;
		},
		close() {
			closed++;
		},
	});
	modal.render(35);
	modal.handleInput(enter);
	modal.handleInput(down);
	assert.equal(modal.view.selected, "overview");
	assert.equal(asked, 0);
	modal.handleInput(esc);
	assert.equal(closed, 1);
});
