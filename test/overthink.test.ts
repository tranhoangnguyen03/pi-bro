import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  FACTORY_QUESTIONS, OVERTHINK_ENTRY, checkQuestions, questionsFromText,
  readGlobalQuestions, writeGlobalQuestions, resolveOverthinkSession,
  questionKey, parseOverthinkAnswer, readOverthinkUsage,
} from "../src/overthink-state.ts";
import { overthinkReady, registerOverthink } from "../src/overthink.ts";

test("questions: validate ordered editable lines and keep empty list intentional", () => {
  assert.deepEqual(questionsFromText("One?\n\nTwo?  \n"), ["One?", "Two?"]);
  assert.deepEqual(checkQuestions([]), []);
  assert.throws(() => checkQuestions([" "]), /nonempty/);
  assert.throws(() => checkQuestions(["x".repeat(501)]), /500/);
  assert.throws(() => checkQuestions(Array(33).fill("Q?")), /32/);
  assert.deepEqual(parseOverthinkAnswer(" NONE. "), "");
  assert.equal(parseOverthinkAnswer("A material concern"), "A material concern");
  assert.deepEqual(readOverthinkUsage({ cacheReadTokens: 200, cacheWriteTokens: 13, outputTokens: 42 }),
    { cacheRead: 200, cacheWrite: 13, output: 42 });
  assert.equal(readOverthinkUsage(undefined), undefined);
});

test("global defaults: persisted list and reset source remain independent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bro-overthink-"));
  try {
    assert.deepEqual(await readGlobalQuestions(dir), FACTORY_QUESTIONS);
    await writeGlobalQuestions(["Changed direction?", "Risk?"], dir);
    assert.deepEqual(await readGlobalQuestions(dir), ["Changed direction?", "Risk?"]);
    const disk = JSON.parse(await readFile(join(dir, "bro-overthink-defaults.json"), "utf8"));
    assert.equal(disk.version, 1);
    await writeGlobalQuestions([], dir);
    assert.deepEqual(await readGlobalQuestions(dir), []);
    assert.equal(FACTORY_QUESTIONS.length, 7);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("session entries: branch-local latest questions and note; no model messages", () => {
  const entry = (kind: string, extra: object) => ({
    type: "custom", customType: OVERTHINK_ENTRY, data: { version: 1, kind, ...extra },
  }) as SessionEntry;
  const root = [
    entry("questions", { questions: ["First?"] }),
    entry("note", { text: "Risk", checkedAt: "2026-11-06T00:00:00Z", model: "test/a", questionKey: questionKey(["First?"]) }),
  ];
  assert.deepEqual(resolveOverthinkSession(root).questions, ["First?"]);
  assert.equal(resolveOverthinkSession(root).note?.text, "Risk");
  const forkA = [...root, entry("questions", { questions: ["Branch A?"] })];
  const forkB = [...root, entry("questions", { questions: ["Branch B?"] })];
  assert.deepEqual(resolveOverthinkSession(forkA).questions, ["Branch A?"]);
  assert.deepEqual(resolveOverthinkSession(forkB).questions, ["Branch B?"]);
  assert.equal(resolveOverthinkSession(forkA).note?.questionKey !== questionKey(["Branch A?"]), true);
  assert.equal(resolveOverthinkSession([entry("questions", { questions: [""] })]).initialized, false);
});

test("automatic gate: requires real completed tool work and an idle queue", () => {
  const event = { messages: [
    { role: "toolResult" }, { role: "toolResult" }, { role: "toolResult" },
    { role: "assistant", stopReason: "stop" },
  ] };
  assert.equal(overthinkReady(event, false), true);
  assert.equal(overthinkReady(event, true), false);
  assert.equal(overthinkReady({ messages: [{ role: "assistant", stopReason: "stop" }] }, false), false);
  assert.equal(overthinkReady({ messages: [...event.messages.slice(0, -1), { role: "assistant", stopReason: "aborted" }] }, false), false);
});

test("same Pi model is called once, report is stored privately, and a new turn clears its widget", async () => {
  const callbacks: Record<string, (...args: any[]) => any> = {};
  const entries: SessionEntry[] = [];
  const requests: any[][] = [];
  const widgets: unknown[] = [];
  const pi = {
    on: (name: string, fn: (...args: any[]) => any) => { callbacks[name] = fn; },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data } as SessionEntry);
    },
    getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI;
  const model = { provider: "demo", id: "test-model", reasoning: true };
  const ctx = {
    mode: "tui", model,
    modelRegistry: {
      streamSimple: (...args: any[]) => {
        requests.push(args);
        return { result: async () => ({
          stopReason: "stop",
          content: [{ type: "text", text: "Check one unexpected edge case." }],
          usage: { cacheReadTokens: 135, outputTokens: 20 },
        }) };
      },
    },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "test-session",
      buildSessionProjection: () => ({
        messages: [{ role: "user", content: [{ type: "text", text: "Build the feature" }], timestamp: 1 }],
      }),
    },
    hasPendingMessages: () => false,
    ui: { setWidget: (_name: string, value: unknown) => widgets.push(value), notify: () => undefined },
  } as unknown as ExtensionCommandContext;
  registerOverthink(pi);
  await callbacks.session_start({}, ctx);
  assert.equal(resolveOverthinkSession(entries).questions?.length, FACTORY_QUESTIONS.length);
  await callbacks.agent_end({ messages: [
    { role: "toolResult" }, { role: "toolResult" }, { role: "toolResult" },
    { role: "assistant", stopReason: "stop" },
  ] }, ctx);
  for (let i = 0; i < 20 && !resolveOverthinkSession(entries).note; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], model);
  assert.equal(requests[0][2].reasoning, "high");
  assert.equal(requests[0][2].sessionId, "test-session");
  assert.equal(resolveOverthinkSession(entries).note?.text, "Check one unexpected edge case.");
  assert.equal(resolveOverthinkSession(entries).note?.usage?.cacheRead, 135);
  assert.equal(widgets.length > 0, true);
  await callbacks.agent_start({}, ctx);
  assert.equal(widgets.at(-1), undefined);
});
