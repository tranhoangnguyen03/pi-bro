import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUDIENCE, BALANCED, GUARD, MODE, buildBroPrompt } from "../hooks/core.js";

const src = readFileSync(new URL("../../../src/prompt.ts", import.meta.url), "utf8");

function tsString(name) {
  const m = src.match(new RegExp(`const ${name} = \`([^\`]*)\``)) ?? src.match(new RegExp(`${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  assert.ok(m, `${name} not found in src/prompt.ts`);
  return m[1];
}

test("core.js prompt text matches src/prompt.ts", () => {
  assert.equal(AUDIENCE, tsString("AUDIENCE_PROMPT"));
  assert.equal(GUARD, tsString("SOURCE_GUARD"));
  const balanced = src.match(/balanced: "((?:[^"\\]|\\.)*)"/);
  assert.ok(balanced, "balanced prompt not found");
  assert.equal(BALANCED, JSON.parse(`"${balanced[1]}"`));
  assert.equal(MODE, "balanced");
});

test("buildBroPrompt assembles pieces in the same order as src/prompt.ts", () => {
  const assembly = src.match(/return `(\$\{AUDIENCE_PROMPT\}[^`]*)`;/);
  assert.ok(assembly, "buildDefaultPrompt template not found");
  // With no preferences, reader is "" and MODE_PROMPTS[mode] is the balanced prompt.
  const expected = assembly[1]
    .replace("${AUDIENCE_PROMPT}", AUDIENCE)
    .replace("${reader}", "")
    .replace("${MODE_PROMPTS[mode]}", BALANCED)
    .replace("${SOURCE_GUARD}", GUARD)
    .replace("${JSON.stringify(response)}", JSON.stringify("hi"))
    .replaceAll("\\n", "\n");
  assert.equal(buildBroPrompt("hi"), expected);
});
