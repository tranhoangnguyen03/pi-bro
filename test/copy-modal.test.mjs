import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { buildDir } from "./test-build.mjs";

const { CopyModal } = await import(pathToFileURL(join(buildDir, "copy.js")).href);
const { latestCompletedAssistantText } = await import(pathToFileURL(join(buildDir, "last-assistant.js")).href);
const { RawMarkdownDraft, normalizeEditorMarkdown } = await import(pathToFileURL(join(buildDir, "copy-draft.js")).href);
const { latestAssistant } = await import(pathToFileURL(join(buildDir, "explain-modal.js")).href);
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
  assert.equal(latestCompletedAssistantText(branch), markdown);
  assert.equal(latestCompletedAssistantText([assistant("not completed", "aborted")]), undefined);
  assert.equal(latestCompletedAssistantText([assistant("  ")]), undefined);
  assert.equal(latestCompletedAssistantText([{
    type: "message", message: { role: "assistant", stopReason: "stop", content: [
      { type: "thinking", thinking: "not copyable" },
      { type: "text", text: "part one" }, { type: "image", data: "not text" }, { type: "text", text: "part two" },
    ] },
  }]), "part one\npart two");
});

test("Explain and Copy share one completed-reply selection rule, with different trim policies", () => {
  const branch = [
    {type:"message",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:" older " }]}},
    {type:"message",message:{role:"assistant",stopReason:"stop",content:[
      {type:"text",text:" \nFirst "},{type:"thinking",thinking:"secret"},{type:"text",text:"Second\n "},
    ]}},
  ];
  const raw = latestCompletedAssistantText(branch);
  assert.equal(raw, " \nFirst \nSecond\n ", "multiple text blocks use one synthesized LF separator");
  const ctx = {sessionManager:{getBranch:()=>branch}};
  assert.equal(latestAssistant(ctx)?.text, raw.trim(), "Explain keeps its historical trimming behavior");
});

test("Raw draft preserves untouched CRLF and tabs through edits and undo", () => {
  const source = "\tfirst\r\n\tsecond\r\nthird\r\n";
  const original = normalizeEditorMarkdown(source);
  const draft = new RawMarkdownDraft(source);
  assert.equal(original, "    first\n    second\nthird\n");
  const before = original.indexOf("third") + "third".length;
  const next = "    first\n    second\nthird changed\n";
  draft.update(next, { kind: "insert", beforeCursor: before, afterCursor: before + " changed".length });
  assert.equal(draft.text, "\tfirst\r\n\tsecond\r\nthird changed\r\n");
  const next2 = next + "new last line";
  draft.update(next2, { kind: "insert", beforeCursor: next.length, afterCursor: next2.length });
  assert.equal(draft.text, "\tfirst\r\n\tsecond\r\nthird changed\r\nnew last line");
  draft.update(original, { kind: "undo" }); // Pi may undo several typed characters at once
  assert.equal(draft.text, source);

  const tabOriginal = "one\t\ttwo";
  const tab = new RawMarkdownDraft(tabOriginal);
  const normalized = normalizeEditorMarkdown(tabOriginal);
  const inserted = normalized.slice(0, 5) + "X" + normalized.slice(5);
  tab.update(inserted, { kind: "insert", beforeCursor: 5, afterCursor: 6 });
  assert.equal(normalizeEditorMarkdown(tab.text), inserted);
  assert.equal(tab.text.endsWith("\ttwo"), true, "untouched second tab remains raw");
});

test("The exact cursor, not repeated text, chooses which line ending is deleted", () => {
  const source = "a\r\n\nb"; // CRLF then LF: both appear as identical newlines in Pi Editor
  const next = "a\nb";
  const first = new RawMarkdownDraft(source);
  first.update(next, { kind: "backward", beforeCursor: 2, afterCursor: 1 });
  assert.equal(first.text, "a\nb", "backspace deleted the CRLF, preserving the second LF");
  first.update(normalizeEditorMarkdown(source), { kind: "undo" });
  assert.equal(first.text, source, "undo restores exact old CRLF/LF provenance");

  const second = new RawMarkdownDraft(source);
  second.update(next, { kind: "backward", beforeCursor: 3, afterCursor: 2 });
  assert.equal(second.text, "a\r\nb", "backspace deleted the LF, preserving the first CRLF");

  const forward = new RawMarkdownDraft(source);
  forward.update(next, { kind: "forward", beforeCursor: 1, afterCursor: 1 });
  assert.equal(forward.text, "a\nb", "forward delete removed the CRLF at the cursor");

  const ambiguous = new RawMarkdownDraft(source);
  assert.throws(() => ambiguous.update(next, { kind: "unknown", beforeCursor: 2 }),
    /Ambiguous edit position/, "unknown deletion must refuse ambiguous provenance");
});

test("Deleting repeated spaces uses cursor to preserve unaffected tab indentation", () => {
  const source = "x\t y\t  z";
  const visible = normalizeEditorMarkdown(source);
  const literalSpace = 5; // x + four spaces from first tab, then the literal space
  const next = visible.slice(0, literalSpace) + visible.slice(literalSpace + 1);
  const draft = new RawMarkdownDraft(source);
  draft.update(next, { kind: "forward", beforeCursor: literalSpace, afterCursor: literalSpace });
  assert.equal(draft.text, "x\ty\t  z", "both raw tabs remain intact");
  const insideTab = new RawMarkdownDraft(source);
  const inner = visible.slice(0, 3) + visible.slice(4);
  insideTab.update(inner, { kind: "backward", beforeCursor: 4, afterCursor: 3 });
  assert.equal(insideTab.text, "x    y\t  z", "only the touched tab expands, other tab preserved");
});

test("Real editor backspace at the first of two blank lines preserves the second LF", async () => {
  const m = mk("a\r\n\nb");
  m.view();
  m.modal.handleInput("\x1b[A"); // from last line 'b' to blank middle line
  m.modal.handleInput("\x01"); // Ctrl+A: start of current line
  assert.deepEqual(m.modal.editor.getCursor(), {line: 1, col: 0});
  m.modal.handleInput("\x7f"); // backspace merges with first line, deleting CRLF
  m.modal.handleInput("\x03");
  await flush();
  assert.deepEqual(m.copied, ["a\nb"], "the untouched LF is still LF");
});

test("Unmapped editor mutations do not silently copy normalized text", async () => {
  const m = mk("a\r\n\nb");
  m.view();
  m.modal.editor.setText("unexpected replacement"); // bypasses input location; can't prove provenance
  m.modal.handleInput("\x03");
  await flush();
  assert.deepEqual(m.copied, [], "unmapped editor change must NOT silently copy");
  assert.match(m.view(), /Cannot map this edit safely/);
  m.modal.handleInput("\x04");
  assert.match(m.view(), /Copy · Edit/, "unsafe source must not enter Preview as a clean draft");
});

test("Real editor undo restores the exact raw line endings after a deletion", async () => {
  const source = "a\r\n\nb";
  const m = mk(source);
  m.view();
  m.modal.handleInput("\x1b[A");
  m.modal.handleInput("\x01");
  m.modal.handleInput("\x7f");
  m.modal.handleInput("\x1f"); // Ctrl+Minus is Pi Editor undo on macOS/Linux; Ctrl+Z suspends
  m.modal.handleInput("\x03");
  await flush();
  assert.deepEqual(m.copied, [source]);
});

test("Small real editor change must not normalize unrelated tab indentation or CRLF", async () => {
  const source = "## Title\r\n\t" + "const a = 1;\r\n\t" + "const b = 2;\r\n";
  const m = mk(source);
  m.view();
  m.modal.handleInput("!"); // Append at current cursor
  m.modal.handleInput("\x03");
  await flush();
  assert.deepEqual(m.copied, [source + "!"]);
  m.modal.handleInput("\x04"); // Preview same corrected raw source
  m.modal.handleInput("\x03");
  await flush();
  assert.deepEqual(m.copied, [source+"!",source+"!"]);
});

test("Large bracketed paste copies full expanded Markdown, not the shortened marker", async () => {
  const m = mk("Short");
  m.view();
  const paste = "\n" + Array.from({length:250}, (_,i) => "row-"+i+" | value-"+i).join("\n");
  m.modal.handleInput("\x1b[200~"+paste+"\x1b[201~");
  assert.ok(m.modal.editor.getExpandedText().includes("row-249 | value-249"));
  m.modal.handleInput("\x04"); // preview, then copy
  m.modal.handleInput("\x03");
  await flush();
  assert.deepEqual(m.copied, ["Short"+paste]);
  assert.doesNotMatch(m.copied[0], /\[paste #\d/);
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
