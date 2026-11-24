import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  restorePrivateBroState, privateSessionEntrySnapshots, BTW_SESSION_ENTRY, GRILL_SESSION_ENTRY,
  SIMPLIFY_SESSION_ENTRY, LAST_RESULT_SESSION_ENTRY,
} from "../src/session-state.ts";

const custom = (customType: string, data: unknown) =>
  ({ type: "custom", customType, data }) as SessionEntry;
const btw = { turns: [{question:"q",answer:"answer"}], full:false, context:"original session" };
const grill = { topic:"Should we merge?", depth:"balanced", turns:[{question:"q",answer:"a"}], fullAccess:false };
const simplify = { view:"result", result:{source:{text:"Original"},text:"Plain explanation",mode:"balanced"} };

test("restore last private state from the active branch, including cleared threads", () => {
  const branch = [
    custom(BTW_SESSION_ENTRY,{thread: btw}),
    custom(GRILL_SESSION_ENTRY,{thread: grill}),
    custom(SIMPLIFY_SESSION_ENTRY,{state:simplify}),
    custom(LAST_RESULT_SESSION_ENTRY,{result:{source:{text:"Conversation"},text:"diagram"},steering:"1 question"}),
    custom(BTW_SESSION_ENTRY,{thread:{turns:[],full:true}}),
  ];
  const restored = restorePrivateBroState(branch);
  assert.deepEqual(restored.btw, {turns:[],full:true}, "clear/mode is the latest state, not the previous transcript");
  assert.deepEqual(restored.grill, grill);
  assert.deepEqual(restored.simplify.result, { source: { text: "Conversation" }, text: "diagram", showSteering: "1 question" });
  assert.deepEqual(restorePrivateBroState(branch.slice(0, 3)).simplify, simplify);
  assert.deepEqual(restorePrivateBroState(branch.slice(0, 1)).btw, btw, "forks inherit their own branch only");
  assert.deepEqual(restorePrivateBroState([]), {simplify:{}}, "a new session inherits nothing");
});

test("legacy unsteered Show restores without trusting its temp path; clearing stays cleared", () => {
  const legacy = custom(LAST_RESULT_SESSION_ENTRY, {
    result: { source: { text: "Conversation" }, text: "Diagram", htmlPath: "/tmp/stale.html" }, steering: "",
  });
  assert.deepEqual(restorePrivateBroState([
    custom(SIMPLIFY_SESSION_ENTRY, { state: { ...simplify, draft: "/text draft" } }), legacy,
  ]).simplify, {
    result: { source: { text: "Conversation" }, text: "Diagram", showSteering: "" }, view: "result", draft: "/text draft",
  });
  const cleared = custom(SIMPLIFY_SESSION_ENTRY, { state: { view: "empty" } });
  assert.deepEqual(restorePrivateBroState([legacy, cleared]).simplify, { view: "empty" });
  assert.deepEqual(restorePrivateBroState([cleared, custom(LAST_RESULT_SESSION_ENTRY, { result: simplify.result })]).simplify, { view: "empty" });
});

test("a legacy Explain retry replaces its original result without discarding the draft", () => {
  const snapshot = custom(SIMPLIFY_SESSION_ENTRY, { state: { ...simplify, draft: "/text draft" } });
  const duplicate = custom(LAST_RESULT_SESSION_ENTRY, { result: simplify.result });
  const retried = { ...simplify.result, text: "Retried explanation", mode: "faithful" };
  const retry = custom(LAST_RESULT_SESSION_ENTRY, { result: retried });
  assert.equal(privateSessionEntrySnapshots([snapshot, duplicate]).has(SIMPLIFY_SESSION_ENTRY), true);
  assert.deepEqual(restorePrivateBroState([snapshot, duplicate, retry]).simplify,
    { view: "result", result: retried, draft: "/text draft" });
  assert.equal(privateSessionEntrySnapshots([snapshot, duplicate, retry]).has(SIMPLIFY_SESSION_ENTRY), false);
});

test("latest invalid state does not resurrect stale private content", () => {
  assert.equal(restorePrivateBroState([
    custom(BTW_SESSION_ENTRY,{thread:btw}),
    custom(BTW_SESSION_ENTRY,{thread:{turns:"corrupt",full:true}}),
  ]).btw, undefined);
  assert.deepEqual(restorePrivateBroState([
    custom(SIMPLIFY_SESSION_ENTRY,{state:simplify}),
    custom(SIMPLIFY_SESSION_ENTRY,{state:{view:"result",result:{source:{bad:true},text:"oops"}}}),
  ]).simplify, {});
});

test("custom message-like entries are ignored; private state is not a model-facing message", () => {
  const branch = [
    {type:"custom_message", customType: BTW_SESSION_ENTRY, content:[{type:"text",text:"injected"}]},
    custom(BTW_SESSION_ENTRY,{thread:btw}),
    {type:"message",message:{role:"user",content:[{type:"text",text:"no changes"}]}},
  ] as SessionEntry[];
  assert.deepEqual(restorePrivateBroState(branch).btw, btw);
});

test("write signatures track the active branch and latest saved value", () => {
  const oldBranch = [custom(BTW_SESSION_ENTRY, { thread: btw }), custom(GRILL_SESSION_ENTRY, { thread: grill })];
  const signatures = privateSessionEntrySnapshots(oldBranch);
  assert.equal(signatures.get(BTW_SESSION_ENTRY), JSON.stringify({ thread: btw }));
  assert.equal(signatures.get(GRILL_SESSION_ENTRY), JSON.stringify({ thread: grill }));
  assert.equal(privateSessionEntrySnapshots([]).size, 0, "rewinding before Bro activity erases stale signatures");
  const next = [...oldBranch, custom(BTW_SESSION_ENTRY, { thread: { turns: [], full: false } })];
  assert.equal(privateSessionEntrySnapshots(next).get(BTW_SESSION_ENTRY), JSON.stringify({ thread: { turns: [], full: false } }));
});
