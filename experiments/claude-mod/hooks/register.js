import { buildBroPrompt, lastAssistantText, broAction, chunkMarkdown } from "./core.js";

const PANE = "bro_simplify_experimental";
const LIMIT = 9000;
function message(error) { return error instanceof Error ? error.message : String(error); }

/** Separate Mod state: never place prompts or explanations in the main agent thread. */
export function register(on) {
  let lastCompleted = "";
  let inMainTurn = false;
  let queued = [];
  let source = "";
  let output = "";
  let error = "";
  let modelName = "";
  let loading = false;
  let epoch = 0;

  function repaint($) { $.ui.invalidate("ui.render"); }
  // Settle every request still waiting on a main turn so none outlives its pane or a newer request.
  function dropWaiters(reason) {
    const waiting = queued; queued = [];
    for (const w of waiting) w.reject(new Error(reason));
  }
  // Shared by the Close button and Escape: invalidate in-flight work and settle waiters. A run that was
  // still loading is marked cancelled so reopening never shows an empty "Simplified reply".
  function cancel() {
    epoch++; dropWaiters("Closed.");
    if (loading) { loading = false; error = "Cancelled."; }
  }
  async function close($) { cancel(); await $.ui.close({ id: PANE }); }
  async function copy($) {
    if (!output) return;
    // CLI clipboard transports; no transcript, model message or shell interpolation.
    for (const argv of [["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"]]) {
      try {
        const r = await $.process.run(argv, { stdin: output, timeoutMs: 5000 });
        if (r.exitCode === 0) { $.ui.toast("Copied explanation"); return; }
      } catch { /* try next installed clipboard tool */ }
    }
    $.ui.toast("Clipboard tool unavailable; select text from the pane instead");
  }
  async function waitForReply($) {
    if (inMainTurn) {
      // Only the main turn's successful completion resolves this promise.
      return new Promise((resolve, reject) => queued.push({resolve, reject}));
    }
    if (lastCompleted.trim()) return lastCompleted;
    return lastAssistantText(await $.session.messages());
  }
  async function simplify($, captured, id = ++epoch) {
    source = captured || "";
    output = ""; error = ""; loading = true;
    repaint($);
    try {
      const model = await $.session.model();
      const reply = await $.model.complete({ model, prompt: buildBroPrompt(source), maxTokens: 8192 });
      // Completion responses differ across early Mod API builds.
      const text = typeof reply === "string" ? reply
        : reply && reply.isAnswered !== false && typeof reply.text === "string" ? reply.text : "";
      if (id !== epoch) return; // Pane was closed or a newer request won.
      modelName = model;
      if (!text.trim()) throw new Error("The model returned no explanation.");
      output = text;
    } catch (err) {
      if (id === epoch) error = message(err);
    } finally {
      if (id === epoch) { loading = false; repaint($); }
    }
  }
  async function launch($, action) {
    if (action === "open") {
      if (!source) return { text: "Nothing to reopen yet. Use /bro after Claude replies." };
      await $.ui.open({ id: PANE, title: "Bro — simplify", focus: true, closeOnEscape: true, rows: 16 });
      repaint($);
      return { text: "" };
    }
    // A new request supersedes any in-flight one (including one still waiting on a main turn) and
    // must not leave the previous reply behind for Retry.
    const id = ++epoch;
    dropWaiters("Superseded by a newer /bro.");
    loading = true;
    source = ""; output = ""; error = "";
    // Open before waiting so the user sees that the command was accepted.
    await $.ui.open({ id: PANE, title: "Bro — simplify", focus: true, closeOnEscape: true, rows: 16 });
    repaint($);
    try {
      const captured = await waitForReply($);
      if (id !== epoch) return { text: "" };
      if (!captured) throw new Error("No completed assistant response found.");
      await simplify($, captured, id);
    } catch (err) {
      if (id === epoch) { error = message(err); loading = false; repaint($); }
    }
    return { text: "" }; // Never print the private answer into the transcript.
  }

  on("session.start", async ($, e, next) => {
    epoch++; dropWaiters("Session restarted.");
    lastCompleted = ""; inMainTurn = false; source = ""; output = ""; error = ""; loading = false;
    await $.command.register({
      name: "bro",
      description: "Privately simplify the latest completed Claude reply",
      argumentHint: "[simplify|open]",
      immediate: true
    });
    return next(e);
  });
  on("turn.start", ($, e, next) => { if (!e.agentId) inMainTurn = true; return next(e); });
  on("turn.complete", ($, e, next) => {
    if (!e.agentId) {
      inMainTurn = false;
      if (e.reason === "answer" && e.answer.trim()) lastCompleted = e.answer;
      const ok = e.reason === "answer" && e.answer.trim();
      const waiting = queued; queued = [];
      for (const w of waiting) {
        if (ok) w.resolve(e.answer);
        else w.reject(new Error("The current main turn ended without a completed answer."));
      }
    }
    return next(e);
  });
  on("command.run", { command: "bro" }, async ($, e) => {
    try { return await launch($, broAction(e.args)); }
    catch (err) { return { text: "Bro could not open: " + message(err) }; }
  });
  on("ui.close", ($, e, next) => {
    if (e.id === PANE) cancel();
    return next(e);
  });
  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const { Box, Text, Markdown, Button } = $.ui.resolve(e);
    const body = [];
    body.push(Text({ bold: true, children: loading ? "Simplifying…" : error ? "Bro failed" : "Simplified reply" }));
    body.push(Text({ dimColor: true, children: modelName ? modelName + " · balanced" : "balanced" }));
    if (error) body.push(Text({ children: error }));
    if (output) for (const text of chunkMarkdown(output, LIMIT)) body.push(Markdown({ text }));
    if (loading) {
      body.push(Button({ key: "bro_cancel", label: "Close / dismiss pending result", onPress: () => { void close($); } }));
    } else {
      // Close is always offered, including after a failure that captured no source.
      const buttons = [];
      if (source) buttons.push(Button({ key: "bro_retry", label: "Retry", hotkey: "r", onPress: () => { void simplify($, source); } }));
      if (output) buttons.push(Button({ key: "bro_copy", label: "Copy", hotkey: "c", onPress: () => { void copy($); } }));
      buttons.push(Button({ key: "bro_close", label: "Close", hotkey: "q", onPress: () => { void close($); } }));
      body.push(Box({ flexDirection: "row", children: buttons }));
    }
    return Box({ flexDirection: "column", padding: 1, children: body });
  });
}
