import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters as strip } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildDir } from "./test-build.mjs";
initTheme();
const { ReviewModal, newReviewView } = await import(
	pathToFileURL(join(buildDir, "review-modal.js"))
);
const { replaceGuide } = await import(pathToFileURL(join(buildDir, "review.js")));
const enter = "\r",
	esc = "\x1b",
	down = "\x1b[B",
	page = "\x1b[6~";
const finding = (id, topicId) => ({
	id,
	topicId,
	title: `Finding ${id}`,
	kind: "risk",
	severity: "low",
	scenario: "Trigger ".repeat(70),
	impact: "Impact",
	reasoning: "Reason",
	uncertainty: "",
	fix: "Fix",
	check: "Check",
	evidence: [],
});
const record = () => ({
	version: 1,
	id: "a".repeat(64),
	snapshot: {
		target: { repository: "a/b", number: 1, head: "abcdef", title: "PR purpose" },
		files: Array.from({ length: 40 }, (_, i) => ({
			path: `src/same/very/long/directory/component-${i}.ts`,
			status: "M",
		})),
		diff: "",
	},
	guide: {
		summary: "Purpose",
		topics: [{ id: "t", title: "Topic", explanation: "Explained", evidence: [] }],
		assessment: {
			overview: "Assessment",
			inspected: [],
			notExamined: [],
			warnings: [],
			findings: [finding("f", "t"), finding("cross")],
		},
	},
	turns: [],
	ui: newReviewView(),
});
const make = (r = record(), controls = {}, rows = 20) =>
	new ReviewModal(
		r,
		{ terminal: { rows, columns: 60 }, requestRender() {} },
		{ fg: (_c, s) => s, bold: (s) => s },
		{
			ask() {},
			prepare() {},
			regenerate() {},
			retrySave() {},
			stop() {},
			close() {},
			changed() {},
			copy() {},
			...controls,
		},
	);
const output = (m, w = 56) => strip(m.render(w).join("\n"));
const location = (m, selected, screen = "reading", target = "whole review") => {
	Object.assign(m.view, { selected, screen, target, pane: "detail" });
	m.syncGuideView();
	m.render(56);
};

test("closing is ordinary navigation, with automatic saving rather than a separate save step", () => {
	const m = make();
	m.view.pane = "contents";
	m.view.selected = "close";
	m.syncGuideView();
	const text = output(m, 110);
	assert.match(text, /Close/);
	assert.doesNotMatch(text, /Save and close/);
});

test("Enter focuses a single action before activating; empty screens promise no dead controls", () => {
	let stopped = 0;
	const m = make(undefined, {
		stop() {
			stopped++;
		},
	});
	m.busy = true;
	m.operation = "guide";
	location(m, "coverage");
	m.handleInput(enter);
	assert.equal(stopped, 0);
	assert.match(output(m), /›\s*\[Stop preparation\]/);
	m.handleInput(enter);
	assert.equal(stopped, 1);
	m.busy = false;
	location(m, "coverage");
	assert.doesNotMatch(output(m), /Enter actions/);
	m.record.guide.assessment.findings = [];
	location(m, "findings");
	assert.doesNotMatch(output(m), /Enter open|Enter opens/);
	let closed = 0;
	const c = make(undefined, {
		close() {
			closed++;
		},
	});
	location(c, "close");
	c.handleInput(enter);
	assert.equal(closed, 1);
});

test("Back restores Questions and Across origins, including their selected row", () => {
	const r = record();
	r.turns = [{ target: "t", question: "Why", answer: "Because", status: "complete" }];
	const m = make(r);
	location(m, "questions");
	m.handleInput(enter);
	m.handleInput(esc);
	assert.equal(m.view.selected, "questions");
	assert.equal(m.view.screen, "reading");
	location(m, "across");
	m.handleInput(enter);
	m.handleInput(enter);
	m.handleInput(enter);
	assert.equal(m.view.screen, "discussion");
	m.handleInput(esc);
	assert.equal(m.view.selected, "across");
	assert.equal(m.view.screen, "finding");
	m.handleInput(esc);
	assert.equal(m.view.selected, "across");
	assert.equal(m.view.row, 0);
});

test("topic findings are filtered and Back returns to the originating topic", () => {
	const m = make();
	location(m, "t");
	m.handleInput(enter);
	m.handleInput(enter);
	assert.equal(m.view.selected, "findings");
	const text = output(m);
	assert.match(text, /Topic/);
	assert.doesNotMatch(text, /Finding cross/);
	m.handleInput(esc);
	assert.equal(m.view.selected, "t");
});

test("cleared draft clamps list cursor and regeneration clears obsolete navigation context", () => {
	const r = record();
	r.turns = [{ target: "t", question: "Saved", answer: "Done", status: "complete" }];
	r.ui.drafts.old = "Draft";
	r.targetContexts = { old: { title: "Old", text: "Context" } };
	const m = make(r);
	location(m, "questions");
	m.view.row = 1;
	m.handleInput(enter);
	m.input.setValue("");
	m.view.drafts.old = "";
	m.handleInput(esc);
	output(m);
	assert.equal(m.view.row, 0);
	m.handleInput(enter);
	assert.equal(m.view.screen, "discussion");
	m.view.scope = "t";
	replaceGuide(r, {
		summary: "New",
		topics: [{ id: "new", title: "New", explanation: "New", evidence: [] }],
	});
	assert.equal(m.view.scope, undefined);
	assert.equal(m.view.returnTo, undefined);
});

test("paging uses visible rows and affects the focused list or contents pane", () => {
	const m = make();
	location(m, "findings", "finding", "f");
	output(m);
	const rows = m.layout.bodyRows;
	m.handleInput(page);
	assert.equal(m.view.offsets[m.key], Math.max(1, rows - 1));
	location(m, "files");
	m.handleInput(page);
	assert.ok(m.view.row > 0);
	assert.match(output(m), new RegExp(`component-${m.view.row}\\.ts`));
	m.view.pane = "contents";
	m.syncGuideView();
	m.view.selected = "overview";
	m.handleInput(page);
	assert.notEqual(m.view.selected, "overview");
});

test("narrow composer follows conversation, precedes actions and essential hints fit at minimum size", () => {
	const m = make(undefined, {}, 18);
	location(m, "t");
	m.openDiscussion("t");
	const text = output(m, 36);
	assert.ok(text.indexOf("> ") < text.indexOf("[Send"));
	assert.doesNotMatch(text, /Ask about:|BODY ·|INPUT ·/);
	assert.match(text, /Esc back/);
	assert.ok(m.render(36).length <= 16);
	assert.ok(m.render(36).every((l) => visibleWidth(l) <= 36));
	m.tui.terminal.rows = 20;
	location(m, "files");
	const list = output(m);
	assert.match(list, /component-0\.ts/);
	assert.match(list, /more|▼/);
});

test("save recovery is reachable on every screen and full error remains readable", () => {
	const m = make();
	m.saveError = "Not saved: " + "disk error ".repeat(25);
	for (const [selected, screen] of [
		["coverage", "reading"],
		["files", "reading"],
		["questions", "reading"],
		["findings", "finding"],
		["files", "file"],
		["t", "discussion"],
	]) {
		location(m, selected, screen, "f");
		assert.match(output(m), /\[Retry saving\]/);
	}
	location(m, "coverage");
	assert.match(output(m), /disk error/);
});

test("failed question can be edited without overwriting a newer draft or answer", () => {
	const r = record();
	r.turns = [
		{
			target: "t",
			question: "Retry me",
			answer: "Partial model answer",
			status: "failed",
			error: "Backend unavailable",
		},
	];
	const m = make(r);
	location(m, "t");
	m.openDiscussion("t");
	assert.match(output(m), /Edit and resend/);
	m.handleInput("\t");
	m.handleInput(down);
	m.handleInput(enter);
	assert.equal(m.view.drafts.t, "Retry me");
	assert.equal(r.turns[0].answer, "Partial model answer");
	m.view.drafts.t = "New draft";
	m.input.setValue("New draft");
	m.handleInput("\t");
	m.handleInput(down);
	m.handleInput(enter);
	assert.equal(m.view.drafts.t, "New draft");
	assert.match(m.notice, /draft/);
});

test("wheel over pinned title scrolls reading without stealing focus", () => {
	const m = make();
	location(m, "findings", "finding", "f");
	const pane = m.view.pane;
	m.handleMouse({ type: "wheel", x: 20, y: 4, wheelDelta: 3 });
	assert.equal(m.view.offsets[m.key], 3);
	assert.equal(m.view.pane, pane);
});

test("scrolling back to bottom resumes following only the active answer", () => {
	const r = record();
	const turn = {
		target: "t",
		question: "Why",
		answer: Array.from({ length: 70 }, (_, i) => `line ${i}`).join("\n"),
		status: "partial",
	};
	r.turns.push(turn);
	const m = make(r);
	location(m, "t");
	m.openDiscussion("t");
	m.busy = true;
	m.activeTurn = turn;
	m.followAnswer = true;
	output(m);
	m.handleMouse({ type: "wheel", x: 20, y: 6, wheelDelta: -8 });
	output(m);
	assert.equal(m.followAnswer, false);
	m.handleMouse({ type: "wheel", x: 20, y: 6, wheelDelta: 1000 });
	output(m);
	assert.equal(m.followAnswer, true);
	turn.answer += "\nnewest line";
	assert.match(output(m), /newest line/);
});

test("list recovery actions can be focused, and error notices stay readable on narrow screens", () => {
	const m = make();
	location(m, "files");
	m.saveError = "Not saved: disk full";
	m.handleInput("\t");
	assert.match(output(m), /Retry saving/);
	assert.equal(m.focus, "actions");
	m.notice = "Your current draft is kept.";
	location(m, "t");
	m.notice = "Your current draft is kept.";
	assert.match(output(m), /current draft/);
});

test("saved navigation conveniences are validated on construction and topic scopes isolate offsets", () => {
	const r = record();
	r.ui.returnTo = { selected: "missing", screen: "finding", row: -1 };
	r.ui.scope = "missing";
	const m = make(r);
	assert.equal(m.view.scope, undefined);
	assert.equal(m.view.returnTo, undefined);
	location(m, "findings");
	m.view.offsets["findings:reading:"] = 30;
	m.view.scope = "t";
	assert.notEqual(m.key, "findings:reading:");
});
