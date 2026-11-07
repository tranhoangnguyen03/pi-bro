import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { buildDir } from "./test-build.mjs";

const { CopyModal, latestCompletedMarkdown } = await import(pathToFileURL(join(buildDir, "copy.js")).href);
initTheme();
const theme = { fg: (_color, text) => text, bold: text => text };
const mk = (markdown, copied = [], rows = 40, columns = 100, copier) => {
  const tui = { mode: "fullscreen", terminal: { rows, columns, write() {} }, requestRender() {} };
  let closed = 0;
  const copy = copier ?? (async text => { copied.push(text); });
  const modal = new CopyModal(tui, theme, markdown, () => { closed++; }, copy);
  const view = () => stripVTControlCharacters(modal.render(columns - 8).join("\n"));
  return { modal, tui, view, copied, closeCount: () => closed };
};
const flush = async () => new Promise(resolve => setImmediate(resolve));

test("Copy source chooses the last completed assistant text, not terminal output", () => {
  const fence = String.fromCharCode(96).repeat(3);
  const markdown = "\n### Matches\n\n| A | B |\n|---|---|\n| x | [link](https://example.test) |\n\n" +
    fence + "ts\nconst x = 1;\n" + fence + "\n";
  const assistant = (text, stopReason = "stop") => ({
    type: "message", message: { role: "assistant", stopReason, content: [{ type: "text", text }] },
  });
  const branch = [
    assistant("older"),
    { type: "message", message: { role: "user", content: [{ type: "text", text: "question" }] } },
    assistant(markdown),
    assistant("ignored in-progress", "toolUse"),
  ];
  assert.equal(latestCompletedMarkdown(branch), markdown);
  assert.equal(latestCompletedMarkdown([assistant("not completed", "aborted")]), undefined);
  assert.equal(latestCompletedMarkdown([assistant("  ")]), undefined);
  assert.equal(latestCompletedMarkdown([{
    type: "message", message: { role: "assistant", stopReason: "stop", content: [
      { type: "thinking", thinking: "not copyable" },
      { type: "text", text: "part one" }, { type: "image", data: "not text" }, { type: "text", text: "part two" },
    ] },
  }]), "part one\npart two");
});

test("Untouched source copies verbatim even when Pi Editor normalizes its display", async () => {
  const source = "\t| A | B |\r\n\t|---|---|\r\n\r\n";
  const m = mk(source);
  m.view();
  m.modal.handleInput("\x03");
  await flush();
  assert.deepEqual(m.copied, [source]);
  m.modal.handleInput("\x04"); // preview from untouched source
  m.modal.handleInput("\x03");
  await flush();
  assert.deepEqual(m.copied, [source, source], "preview must never become the copied text");
  m.modal.handleInput("\x1b");
  assert.equal(m.closeCount(), 1);
});

test("Editing, previewing and copying share one draft; '?' is editable in Edit", async () => {
  const m = mk("### Heading\n\nStart");
  assert.match(m.view(), /Bro · Copy · Edit/);
  m.modal.handleInput("?"); // must not open help in Edit
  assert.match(m.view(), /Start\?/);
  m.modal.handleInput("\r"); // newline, never submits a prompt
  m.modal.handleInput("Changed");
  assert.match(m.view(), /Changed/);
  const draft = m.modal.editor.getExpandedText();
  m.modal.handleInput("\x04"); // Ctrl+D Preview
  const preview = m.view();
  assert.match(preview, /Bro · Copy · Preview/);
  assert.match(preview, /Changed/);
  m.modal.handleInput("\x03"); // Ctrl+C in Preview
  await flush();
  assert.deepEqual(m.copied, [draft]);
  m.modal.handleInput("\x04");
  assert.match(m.view(), /Bro · Copy · Edit/);
  m.modal.handleInput("\x03");
  await flush();
  assert.deepEqual(m.copied, [draft, draft]);
  m.modal.handleInput("\x1b");
  assert.equal(m.closeCount(), 0, "dirty draft must warn before closing");
  assert.match(m.view(), /discard/);
  m.modal.handleInput("\x1b");
  assert.equal(m.closeCount(), 1);
});

test("Help works in both modes without stealing '?' from ordinary editing", () => {
  const m = mk("Hello");
  m.view();
  m.modal.handleInput("\x07"); // Ctrl+G opens Help
  assert.match(m.view(), /Bro · Copy · Help/);
  m.modal.handleInput("\x1b"); // Esc returns
  assert.match(m.view(), /Bro · Copy · Edit/);
  m.modal.handleInput("\x04"); // preview
  m.modal.handleInput("?"); // ? opens Help in Preview
  assert.match(m.view(), /Bro · Copy · Help/);
  m.modal.handleInput("\x1b");
  assert.match(m.view(), /Bro · Copy · Preview/);
  m.modal.handleInput("\x1b");
  assert.equal(m.closeCount(), 1);
});

test("Long Markdown previews scroll, and preview keys cannot modify the raw text", async () => {
  const source = Array.from({ length: 80 }, (_, i) => "Paragraph " + i + ": **substantial** Markdown text.").join("\n\n");
  const m = mk(source, [], 30, 90);
  m.view();
  m.modal.handleInput("\x04");
  const first = m.view();
  m.modal.handleInput("\x1b[B"); // Down
  const after = m.view();
  assert.notEqual(after, first);
  m.modal.handleMouse({ type: "wheel", wheelDelta: 4 });
  assert.notEqual(m.view(), first);
  m.modal.handleInput("X"); // no editing in preview
  m.modal.handleInput("\x03");
  await flush();
  assert.deepEqual(m.copied, [source]);
});

test("Tiny windows refuse invisible edits but still permit copy and close", async () => {
  const m = mk("Don't lose this draft", [], 8, 40);
  assert.match(m.view(), /Esc/);
  m.modal.handleInput("X");
  m.modal.handleInput("\x03");
  await flush();
  assert.deepEqual(m.copied, ["Don't lose this draft"]);
  m.modal.handleInput("\x04"); // Preview still works
  m.modal.handleInput("\x1b");
  assert.equal(m.closeCount(), 1);
});

test("Clipboard errors do not claim successful copy", async () => {
  const m = mk("Important", [], 40, 100, async () => { throw Error("clipboard unavailable"); });
  m.view();
  m.modal.handleInput("\x03");
  await flush();
  assert.match(m.view(), /Copy failed: clipboard unavailable/);
  assert.doesNotMatch(m.view(), /Copied edited Markdown/);
  m.modal.handleInput("\x1b");
  assert.equal(m.closeCount(), 1);
});

test("Resize to a tiny terminal blocks blind edits; enlarging re-enables edits", async () => {
  const m = mk("Source", [], 40, 100);
  m.view();
  m.tui.terminal.rows = 8;
  m.tui.terminal.columns = 40;
  m.modal.render(32);
  m.modal.handleInput("X"); // invisible editor cannot edit
  m.tui.terminal.rows = 40;
  m.tui.terminal.columns = 100;
  m.view();
  m.modal.handleInput("Y");
  m.modal.handleInput("\x03");
  await flush();
  assert.deepEqual(m.copied, ["SourceY"]);
});
