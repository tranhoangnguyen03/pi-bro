import test from "node:test";
import assert from "node:assert/strict";
import { buildDir } from "./test-build.mjs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const review = await import(pathToFileURL(join(buildDir, "review.js")).href);
const ui = await import(pathToFileURL(join(buildDir, "review-modal.js")).href);
const old = {
	summary: "Old",
	topics: [{ id: "topic-1", title: "Same title", explanation: "Old explanation", evidence: [] }],
};
test("replacement keeps one guide and private target context without inheriting old identities", () => {
	const record = {
		guide: structuredClone(old),
		snapshot: { capturedAt: "then", diff: "captured", files: [], target: {} },
		turns: [{ target: "topic-1", question: "old question" }],
		ui: ui.newReviewView(),
	};
	record.ui.selected = "topic-1";
	record.ui.screen = "discussion";
	record.ui.target = "topic-1";
	record.ui.drafts["topic-1"] = "old draft";
	record.ui.offsets["overview:reading:"] = 8;
	review.replaceGuide(record, structuredClone(old));
	const first = record.guide.topics[0].id;
	assert.notEqual(first, "topic-1");
	assert.equal(record.ui.selected, "questions");
	assert.equal(record.ui.screen, "discussion");
	assert.equal(record.ui.offsets["overview:reading:"], 0);
	assert.equal(record.ui.drafts["topic-1"], "old draft");
	assert.match(record.targetContexts["topic-1"].text, /Old explanation/);
	review.replaceGuide(record, structuredClone(old));
	assert.notEqual(record.guide.topics[0].id, first);
	assert.equal(record.guideVersions, undefined);
	assert.equal(record.pendingGuideId, undefined);
	const across = { guide: old, turns: [], ui: { ...ui.newReviewView(), selected: "across" } };
	review.replaceGuide(across, old);
	assert.equal(across.ui.selected, "overview");
	assert.equal(record.turns[0].target, "topic-1");
	assert.match(
		review.buildReviewPrompt(record, "Question", "topic-1"),
		/old question|Old explanation/,
	);
});
test("pre-release records are rejected untouched while current private records validate", async () => {
	const root = join(buildDir, "records");
	await mkdir(root);
	const record = {
		version: 1,
		id: "e".repeat(64),
		snapshot: {
			target: { head: "head", base: "base", repository: "a/b" },
			mergeBase: "base",
			gitDir: root,
			checkout: root,
			files: [],
			diff: "immutable diff",
		},
		guide: structuredClone(old),
		turns: [{ target: "topic-1", question: "private", answer: "answer", status: "complete" }],
		ui: ui.newReviewView(),
	};
	record.ui.drafts["topic-1"] = "private draft";
	await review.saveReview(root, record);
	const path = join(root, record.id + ".json");
	const loaded = await review.loadReview(root, record.id);
	assert.deepEqual(loaded.turns, record.turns);
	assert.deepEqual(loaded.ui.drafts, record.ui.drafts);
	for (const bad of [
		{ ...record, guideVersions: [] },
		{ ...record, ui: undefined, composer: "draft", topic: 0, offset: 0, view: "guide" },
	]) {
		const raw = JSON.stringify(bad);
		await writeFile(path, raw);
		await assert.rejects(review.loadReview(root, record.id), /Unsupported pre-release/);
		assert.equal(await readFile(path, "utf8"), raw);
	}
	const invalidTopic = structuredClone(record);
	invalidTopic.guide.topics[0].evidence = [
		{ path: "a", side: "new", start: 0, end: 1, valid: true },
	];
	await writeFile(path, JSON.stringify(invalidTopic));
	await assert.rejects(review.loadReview(root, record.id), /evidence/);
	const corrupt = { ...record, targetContexts: { bad: { title: 1, text: "bad" } } };
	await writeFile(path, JSON.stringify(corrupt));
	await assert.rejects(review.loadReview(root, record.id), /context/);
});
