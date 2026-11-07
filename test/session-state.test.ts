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
  assert.deepEqual(restored.simplify, simplify);
  assert.equal(restored.lastResult?.text, "diagram");
  assert.equal(restored.lastShowSteering, "1 question");
  assert.deepEqual(restorePrivateBroState(branch.slice(0, 1)).btw, btw, "forks inherit their own branch only");
  assert.deepEqual(restorePrivateBroState([]), {simplify:{}}, "a new session inherits nothing");
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
