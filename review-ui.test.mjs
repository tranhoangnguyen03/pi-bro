import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme();
import { buildDir } from "./test-build.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { ReviewModal } = await import(pathToFileURL(join(buildDir, "review-modal.js")).href);
test("topic displays cited captured lines, unresolved evidence and persistent save errors", () => {
	const record = {
		snapshot: { target: { repository: "a/b", number: 1, head: "abcdef" }, files: [], diff: "" },
		turns: [],
		guide: {
			summary: "Summary",
			topics: [
				{
					id: "topic-1",
					title: "Behavior",
					explanation: "Detail",
					evidence: [
						{ path: "a.ts", side: "new", start: 4, end: 5, valid: true },
						{ path: "missing", side: "old", start: 1, end: 3, valid: false },
					],
				},
			],
		},
	};
	const panel = new ReviewModal(
		record,
		{ terminal: { rows: 32 }, requestRender() {} },
		{ fg: (_c, s) => s, bold: (s) => s },
		{ ask() {}, prepare() {}, stop() {}, close() {}, changed() {} },
	);
	panel.evidence.set("a.ts:new:4:5", "captured line\nsecond line");
	panel.handleInput("\x1b[B");
	panel.saveError = "Not saved: disk full";
	panel.notice = "Answer complete";
	const output = panel.render(110).join("\n");
	assert.match(output, /4.*│ captured line/);
	assert.match(output, /unresolved reference/);
	assert.match(output, /Not saved: disk full/);
});
