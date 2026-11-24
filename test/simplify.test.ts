import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSimplifyAction, parseSimplifyRequest, SIMPLIFY_MODAL_HELP } from "../src/simplify-engine.ts";

test("Simplify commands are source-focused, explicit and handle text with spaces",()=>{
  assert.deepEqual(parseSimplifyAction("/simplify"),{kind:"latest"});
  assert.deepEqual(parseSimplifyAction("/copy"),{kind:"copy"});
  assert.deepEqual(parseSimplifyAction("/clear"),{kind:"clear"});
  assert.deepEqual(parseSimplifyAction("/help"),{kind:"help"});
  assert.deepEqual(parseSimplifyAction("/retry"),{kind:"retry"});
  assert.deepEqual(parseSimplifyAction("/file docs/with spaces/report.pdf"),{kind:"file",input:"docs/with spaces/report.pdf"});
  assert.deepEqual(parseSimplifyAction("/url https://example.org/article"),{kind:"url",input:"https://example.org/article"});
  assert.deepEqual(parseSimplifyAction("/text Short, clear explanation please"),{kind:"text",input:"Short, clear explanation please"});
  assert.deepEqual(parseSimplifyAction("/show 2 Trace  Login"), { kind: "show", turns: 2, steering: "Trace  Login" });
  assert.deepEqual(parseSimplifyRequest("show", "Focus on Login"), { kind: "show", turns: undefined, steering: "Focus on Login" });
  assert.equal(parseSimplifyAction("/show 0").kind, "invalid");
  assert.equal(parseSimplifyRequest("latest", "extra").kind, "invalid");
  for(const input of ["/file","/text","/url","/simplify extra","/copy extra","hello","/mode full"]) {
    const x=parseSimplifyAction(input);
    assert.equal(x.kind,"invalid",input);
    if(x.kind==="invalid") assert.ok(x.message.trim());
  }
  for(const path of ["/simplify","/url","/text","/file","/copy","/clear","/help"])
    assert.ok(SIMPLIFY_MODAL_HELP.includes(path),path);
});
