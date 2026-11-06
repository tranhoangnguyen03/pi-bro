import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  FACTORY_QUESTIONS, OVERTHINK_ENTRY, checkQuestions,
  readAutomaticChecks, readGlobalQuestions, writeGlobalQuestions, writeAutomaticChecks,
  resolveOverthinkSession, overthinkPrompt,
  overthinkContextPosition, overthinkIsStale,
  questionKey, parseOverthinkAnswer, readOverthinkUsage,
} from "../src/overthink-state.ts";
import { createOverthinkViewer, overthinkReady, accumulateOverthinkEvidence, registerOverthink, usageStatus, questionStatus } from "../src/overthink.ts";
import { createOverthinkQuestionEditor } from "../src/overthink-questions-ui.ts";

// getAgentDir() reads the environment each time. No test should depend on the
// developer's real Overthink preferences or write into their real agent home.
async function withIsolatedAgentHome<T>(run: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bro-overthink-home-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("questions: validate ordered editable lines and keep empty list intentional", () => {
  assert.deepEqual(checkQuestions(["One?", "Two?  "]), ["One?", "Two?"]);
  assert.deepEqual(checkQuestions([]), []);
  assert.throws(() => checkQuestions([" "]), /nonempty/);
  assert.throws(() => checkQuestions(["x".repeat(501)]), /500/);
  assert.throws(() => checkQuestions(Array(33).fill("Q?")), /32/);
  assert.deepEqual(parseOverthinkAnswer(" NONE. "), "");
  assert.equal(parseOverthinkAnswer("A material concern"), "A material concern");
  assert.deepEqual(readOverthinkUsage({ cacheReadTokens: 200, cacheWriteTokens: 13, outputTokens: 42 }),
    { cacheRead: 200, cacheWrite: 13, output: 42 });
  assert.equal(readOverthinkUsage(undefined), undefined);
  assert.deepEqual(readOverthinkUsage({ cacheRead: 0, cacheWrite: 4, reasoning: 321, cost: { total: 0.00234 } }),
    { cacheRead: 0, cacheWrite: 4, reasoning: 321, costTotal: 0.00234 });
  assert.match(usageStatus({ text: "", checkedAt: "", model: "", questionKey: "",
    usage: { cacheRead: 0, cacheWrite: 4, reasoning: 321, costTotal: 0.00234 } }).join(" "), /caching unsupported/);
  assert.match(usageStatus({ text: "", checkedAt: "", model: "", questionKey: "",
    usage: { cacheRead: 0, cacheWrite: 4, reasoning: 321, costTotal: 0.00234 } }).join(" "), /est\. cost \$0\.002340 \(Pi price table; not billed amount\)/);
  assert.match(overthinkPrompt(["Why?"]), /do not call tools or take actions/);
});

test("global defaults: persisted list and reset source remain independent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bro-overthink-"));
  try {
    assert.deepEqual(await readGlobalQuestions(dir), FACTORY_QUESTIONS);
    assert.equal(await readAutomaticChecks(dir), true);
    await writeAutomaticChecks(false, dir);
    assert.equal(await readAutomaticChecks(dir), false);
    await writeGlobalQuestions(["Changed direction?", "Risk?"], dir);
    assert.deepEqual(await readGlobalQuestions(dir), ["Changed direction?", "Risk?"]);
    assert.equal(await readAutomaticChecks(dir), false, "editing questions must preserve enabled state");
    const disk = JSON.parse(await readFile(join(dir, "bro-overthink-defaults.json"), "utf8"));
    assert.equal(disk.version, 1);
    await writeGlobalQuestions([], dir);
    assert.deepEqual(await readGlobalQuestions(dir), []);
    await writeAutomaticChecks(true, dir);
    assert.equal(await readAutomaticChecks(dir), true);
    assert.deepEqual(await readGlobalQuestions(dir), [], "toggling automatic checks must preserve questions");
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

test("automatic checks keep tool evidence through retry/compaction but require settled idle state", () => {
  const candidate = accumulateOverthinkEvidence(undefined, { messages: [
    { role: "toolResult" }, { role: "toolResult" }, { role: "toolResult" },
    { role: "assistant", stopReason: "stop" },
  ] });
  assert.equal(overthinkReady(candidate, false, false), true);
  assert.equal(overthinkReady(candidate, true, false), false);
  assert.equal(overthinkReady(candidate, false, true), false);
  assert.equal(overthinkReady(undefined, false, false), false);
  // A retry/compaction may finish with a subsequent short agent_end; preserve
  // the substantive work from the earlier portion but require a normal final stop.
  const afterRetry = accumulateOverthinkEvidence(candidate, { messages: [
    { role: "assistant", stopReason: "error" },
  ] });
  assert.equal(overthinkReady(afterRetry, false, false), false);
  const settled = accumulateOverthinkEvidence(afterRetry, { messages: [
    { role: "assistant", stopReason: "stop" },
  ] });
  assert.equal(settled.toolResults, 3);
  assert.equal(overthinkReady(settled, false, false), true);
});

test("note provenance ignores private entries and becomes stale after trivial work or branch change", () => {
  const message = (id: string) => ({ type: "message", id, message: { role: "assistant", content: [] } }) as unknown as SessionEntry;
  const privateEntry = ({ type: "custom", customType: OVERTHINK_ENTRY, data: { version: 1, kind: "questions", questions: ["One?"] } }) as SessionEntry;
  const initial = [message("m1")];
  assert.equal(overthinkContextPosition(initial), "m1");
  const note = { text: "Check recovery", checkedAt: "2026-11-06", model: "test/model",
    questionKey: questionKey(["One?"]), sourcePosition: "m1" };
  assert.equal(overthinkIsStale(note, overthinkContextPosition([...initial, privateEntry])), false);
  assert.match(questionStatus(note, ["One?"], "m1"), /current/);
  const laterTurn = [...initial, privateEntry, message("m2")];
  assert.equal(overthinkIsStale(note, overthinkContextPosition(laterTurn)), true);
  assert.match(questionStatus(note, ["One?"], "m2"), /OUTDATED/);
  assert.equal(overthinkIsStale(note, overthinkContextPosition([message("sibling")])), true);
  assert.equal(overthinkContextPosition([...initial, {type: "compaction", id:"c1"} as SessionEntry]), "c1");
});

test("same Pi model is called once, report is stored privately, and a new turn clears its widget", async () => {
  await withIsolatedAgentHome(async () => {
  const callbacks: Record<string, (...args: any[]) => any> = {};
  const entries: SessionEntry[] = [{ type:"message", id:"main-reply", message:{ role:"assistant", content:[] } } as unknown as SessionEntry];
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
  assert.equal(await readAutomaticChecks(), true, "clean fixture must start with automatic checks on");
  await callbacks.agent_end({ messages: [
    { role: "toolResult" }, { role: "toolResult" }, { role: "toolResult" },
    { role: "assistant", stopReason: "stop" },
  ] }, ctx);
  assert.equal(requests.length, 0, "agent_end is not yet safe to review");
  // Pi may open another agent loop as part of a queued continuation. The next
  // agent_start must invalidate an older check without losing work evidence.
  await callbacks.agent_start({}, ctx);
  await callbacks.agent_end({ messages: [{ role:"assistant", stopReason:"stop" }] }, ctx);
  // The settled context should include compaction performed between loops.
  entries.push({ type:"compaction", id:"post-compaction" } as SessionEntry);
  await callbacks.agent_settled({ aborted: false }, ctx);
  for (let i = 0; i < 20 && !resolveOverthinkSession(entries).note; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], model);
  assert.equal(requests[0][2].reasoning, "high");
  assert.equal(requests[0][2].sessionId, "test-session");
  assert.equal(resolveOverthinkSession(entries).note?.text, "Check one unexpected edge case.");
  assert.equal(resolveOverthinkSession(entries).note?.usage?.cacheRead, 135);
  assert.equal(resolveOverthinkSession(entries).note?.sourcePosition, "post-compaction");
  assert.equal(widgets.length > 0, true);
  await callbacks.agent_start({}, ctx);
  assert.equal(widgets.at(-1), undefined);
  });
});


test("a delayed automatic-settings read cannot schedule work after a new agent starts", async () => {
  await withIsolatedAgentHome(async () => {
    const callbacks: Record<string, (...args: any[]) => any> = {};
    const branch: SessionEntry[] = [
      { type: "message", id: "old-reply", message: { role: "assistant", content: [] } } as unknown as SessionEntry,
    ];
    let requests = 0;
    let release: ((value: boolean) => void) | undefined;
    const delayedSettings = () => new Promise<boolean>(resolve => { release = resolve; });
    const pi = {
      on(name: string, fn: (...args: any[]) => unknown) { callbacks[name] = fn; },
      appendEntry(customType: string, data: unknown) {
        branch.push({ type: "custom", customType, data } as SessionEntry);
      },
      getThinkingLevel: () => "off",
    } as unknown as ExtensionAPI;
    const ctx = {
      mode: "tui", model: { provider: "test", id: "active", reasoning: false },
      modelRegistry: { streamSimple() {
        requests++;
        return { result: async () => ({ stopReason: "stop", content: [{type:"text",text:"NONE"}] }) };
      } },
      sessionManager: {
        getBranch: () => branch,
        getSessionId: () => "session-1",
        buildSessionProjection: () => ({messages:[{role:"user",content:[{type:"text",text:"work"}],timestamp:1}]}),
      },
      hasPendingMessages: () => false,
      ui: {setWidget() {},notify() {}},
    } as unknown as ExtensionCommandContext;
    registerOverthink(pi, delayedSettings);
    await callbacks.session_start({}, ctx);
    await callbacks.agent_end({ messages: [
      {role:"toolResult"},{role:"toolResult"},{role:"toolResult"},
      {role:"assistant",stopReason:"stop"},
    ] }, ctx);
    await callbacks.agent_settled({ aborted: false }, ctx);
    assert.ok(release, "settlement should await automatic setting");
    await callbacks.agent_start({}, ctx);
    branch.push({type:"message",id:"new-work",message:{role:"user",content:[]}} as unknown as SessionEntry);
    release!(true);
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(requests, 0, "old settlement must not review the new in-progress task");
  });
});

test("Overthink viewer opens without a call; ? help, Ctrl+R retry, Ctrl+E editor", async () => {
  let calls = 0;
  let action = "";
  const tui = { mode: "regular", terminal: { rows: 35, columns: 90 }, requestRender() {} };
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
  const note = { text: "Check recovery.", checkedAt: "2026-11-06T00:00:00Z", model: "test/model",
    questionKey: questionKey(["One?"]) };
  const component = createOverthinkViewer(
    () => ({ questions: ["One?"], note }),
    async () => { calls++; return note; },
  )(tui as any, theme as any, {}, (value) => { action = value; });
  assert.match(component.render(90).join("\n"), /Check recovery/);
  assert.equal(calls, 0, "viewing latest notes must not run a model");
  component.handleInput?.("?"); // normal ? opens help
  assert.match(component.render(90).join("\n"), /Toggle help/);
  component.handleInput?.("?"); // normal ? closes help
  assert.match(component.render(90).join("\n"), /Check recovery/);
  component.handleInput?.("\x1b[63u"); // extended keyboard protocol opens help
  assert.match(component.render(90).join("\n"), /Toggle help/);
  component.handleInput?.("\x1b[63u"); // extended keyboard protocol closes help
  assert.match(component.render(90).join("\n"), /Check recovery/);
  component.handleInput?.("\x12"); // Ctrl+R
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  component.handleInput?.("\x05"); // Ctrl+E
  assert.equal(action, "edit");
});

test("question editor reset is a draft until explicitly saved", async () => {
  const saves: string[][] = [];
  const tui = { mode: "regular", terminal: { rows: 35, columns: 90 }, requestRender() {} };
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
  const component = createOverthinkQuestionEditor({
    title: "Test questions", questions: ["My question?"],
    reset: async () => ["Reset source?"],
    save: async (questions: string[]) => { saves.push(questions); },
  })(tui as any, theme as any, {}, () => undefined);
  component.handleInput?.("\x04"); // Ctrl+D confirms only on second press
  assert.deepEqual(saves, []);
  component.handleInput?.("\x04");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(saves, [], "reset must never write without Ctrl+S");
  assert.match(component.render(90).join("\n"), /Reset source/);
  component.handleInput?.("\x13"); // Ctrl+S
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(saves, [["Reset source?"]]);
});
