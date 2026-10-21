import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "../hooks/register.js";

const tick = () => new Promise((r) => setImmediate(r));

function harness() {
  const handlers = {};
  register((name, a, b) => { (handlers[name] ??= []).push(typeof a === "function" ? { fn: a } : { fn: b, filter: a }); });
  const completions = [];
  const log = { closes: 0, opens: 0 };
  let messages = [];
  const $ = {
    command: { register: async () => {} },
    session: { model: async () => "m", messages: async () => messages },
    model: { complete: () => new Promise((resolve, reject) => completions.push({ resolve, reject })) },
    process: { run: async () => ({ exitCode: 0 }) },
    ui: {
      invalidate() {}, toast() {},
      open: async () => { log.opens++; }, close: async () => { log.closes++; },
      resolve: () => {
        const mk = (type) => (props = {}) => ({ type, ...props });
        return { Box: mk("Box"), Text: mk("Text"), Markdown: mk("Markdown"), Button: mk("Button") };
      },
    },
  };
  const next = async () => {};
  const fire = (name, e = {}, filter) => {
    const h = handlers[name].find((x) => !filter || (x.filter && x.filter.command === filter.command) || x.filter?.component === filter.component);
    return h.fn($, e, next);
  };
  const labels = (node, out = []) => {
    if (!node || typeof node !== "object") return out;
    if (node.type === "Button") out.push(node.label);
    for (const c of [].concat(node.children ?? [])) labels(c, out);
    return out;
  };
  const render = () => fire("ui.render", { requestId: "bro_simplify_experimental" }, { component: "Pane" });
  const run = (args = "") => fire("command.run", { args }, { command: "bro" });
  const turn = async (answer) => { await fire("turn.start", {}); await fire("turn.complete", { reason: "answer", answer }); };
  return { $, fire, run, render, labels, completions, log, turn, setMessages: (m) => { messages = m; } };
}

test("simplifies the captured reply and offers Retry, Copy, Close", async () => {
  const h = harness();
  await h.fire("session.start", {});
  await h.turn("the reply");
  const p = h.run(); await tick();
  assert.equal(h.completions.length, 1);
  h.completions[0].resolve({ text: "simple" });
  await p;
  assert.deepEqual(h.labels(h.render()), ["Retry", "Copy", "Close"]);
});

test("a stale in-flight result cannot overwrite a newer /bro", async () => {
  const h = harness();
  await h.fire("session.start", {});
  await h.turn("first");
  const first = h.run(); await tick();   // request 1 in flight
  await h.fire("turn.start", {});         // main turn running: request 2 must wait
  const second = h.run(); await tick();
  h.completions[0].resolve({ text: "OLD" });
  await first;
  const pane = JSON.stringify(h.render());
  assert.ok(!pane.includes("OLD"), "stale output rendered");
  assert.ok(pane.includes("Simplifying"));
  await h.fire("turn.complete", { reason: "answer", answer: "second" });
  await tick();
  h.completions[1].resolve({ text: "NEW" });
  await second;
  assert.ok(JSON.stringify(h.render()).includes("NEW"));
});

test("a failed wait never leaves the previous reply available to Retry", async () => {
  const h = harness();
  await h.fire("session.start", {});
  await h.turn("first");
  const first = h.run(); await tick();
  h.completions[0].resolve({ text: "ok" });
  await first;
  await h.fire("turn.start", {});
  const second = h.run(); await tick();
  await h.fire("turn.complete", { reason: "interrupted", answer: "" });
  await second;
  assert.deepEqual(h.labels(h.render()), ["Close"]);
});

test("Close is offered when nothing was captured", async () => {
  const h = harness();
  await h.fire("session.start", {});
  await h.run();
  assert.deepEqual(h.labels(h.render()), ["Close"]);
});

test("closing the pane settles a request waiting on a main turn", async () => {
  const h = harness();
  await h.fire("session.start", {});
  await h.fire("turn.start", {});
  const pending = h.run();
  await tick();
  await h.fire("ui.close", { id: "bro_simplify_experimental" });
  await h.fire("turn.complete", { reason: "answer", answer: "late" });
  await pending;
  assert.equal(h.completions.length, 0, "late answer must not start a completion");
});

test("a subagent turn does not mark the main agent busy", async () => {
  const h = harness();
  await h.fire("session.start", {});
  await h.turn("main reply");
  await h.fire("turn.start", { agentId: "sub" });
  h.run(); await tick();
  assert.equal(h.completions.length, 1, "should not wait for the subagent");
});

test("/bro open without a prior result explains itself", async () => {
  const h = harness();
  await h.fire("session.start", {});
  assert.match((await h.run("open")).text, /Nothing to reopen/);
});

test("Escape (ui.close) settles a waiting request without a later turn", async () => {
  const h = harness();
  await h.fire("session.start", {});
  await h.fire("turn.start", {});
  let settled = false;
  const pending = h.run().then(() => { settled = true; });
  await tick();
  await h.fire("ui.close", { id: "bro_simplify_experimental" });
  await pending;
  assert.ok(settled, "command.run should settle on Escape");
});

test("reopening after a cancelled run shows Cancelled with Retry, not an empty reply", async () => {
  const h = harness();
  await h.fire("session.start", {});
  await h.turn("the reply");
  const p = h.run(); await tick();
  await h.fire("ui.close", { id: "bro_simplify_experimental" });
  h.completions[0].resolve({ text: "late" });
  await p;
  await h.run("open");
  const pane = JSON.stringify(h.render());
  assert.ok(pane.includes("Cancelled."));
  assert.ok(!pane.includes("Simplified reply"));
  assert.deepEqual(h.labels(h.render()), ["Retry", "Close"]);
});
