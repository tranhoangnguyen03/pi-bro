import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown } from "../hooks/core.js";

test("short text is one chunk", () => assert.deepEqual(chunkMarkdown("hi", 100), ["hi"]));

test("prefers paragraph boundaries and loses no text", () => {
  const paras = Array.from({ length: 6 }, (_, i) => `para ${i} ` + "x".repeat(30));
  const chunks = chunkMarkdown(paras.join("\n\n"), 100);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 100, c.length);
  for (const p of paras) assert.ok(chunks.some((c) => c.includes(p)), "paragraph split: " + p);
});

test("a long code fence is closed and reopened per chunk", () => {
  const code = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const chunks = chunkMarkdown("```js\n" + code + "\n```", 80);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.equal((c.match(/^```/gm) ?? []).length % 2, 0, c);
  assert.equal(chunks.join("\n").match(/line \d+/g).length, 30);
});

test("a tilde fence is closed with a tilde fence, and a backtick line inside it does not end it", () => {
  const code = Array.from({ length: 30 }, (_, i) => i === 3 ? "```" : `line ${i}`).join("\n");
  const chunks = chunkMarkdown("~~~\n" + code + "\n~~~", 80);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.equal((c.match(/^~~~/gm) ?? []).length % 2, 0, c);
    assert.ok(c.startsWith("~~~"), c);
  }
});
