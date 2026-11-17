import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKENDS, EFFORTS, DEFAULT_CONFIG, changeBackend, validateConfig, fromStore } from "../hooks/settings.js";

test("all requested backends supported, native default",()=>{
  assert.deepEqual(BACKENDS,["native","agy","codex","pi"]);
  assert.deepEqual(fromStore(undefined),DEFAULT_CONFIG);
  for(const backend of BACKENDS)assert.ok(EFFORTS[backend].includes("default"));
});
test("backend changes atomically reset model and effort",()=>{
  const codex=changeBackend(DEFAULT_CONFIG,"codex");
  assert.equal(codex.model,"gpt-5.4");
  assert.deepEqual(validateConfig(codex),codex);
  assert.equal(changeBackend(codex,"native").model,"current");
});
test("Pi requires an explicit physical provider/model",()=>{
  const pi=changeBackend(DEFAULT_CONFIG,"pi");
  assert.throws(()=>validateConfig(pi),/provider\/model/);
  assert.equal(validateConfig({...pi,model:"anthropic/claude-sonnet-4-5"}).backend,"pi");
});
test("backend and effort never silently fall back",()=>{
  assert.throws(()=>validateConfig({...DEFAULT_CONFIG,backend:"grok"}),/Choose/);
  assert.throws(()=>validateConfig({...DEFAULT_CONFIG,effort:"high"}),/effort/);
  assert.throws(()=>validateConfig({...DEFAULT_CONFIG,model:"opus\n--dangerously-skip-permissions"}),/single line/);
  assert.deepEqual(fromStore({version:1,backend:"agy",model:"gemini-3.7-flash",effort:"low"}),{version:1,backend:"agy",model:"gemini-3.7-flash",effort:"low"});
});
