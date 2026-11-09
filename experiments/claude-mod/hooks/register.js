import { buildBroPrompt, lastAssistantText, broAction, chunkMarkdown } from "./core.js";
import { BACKENDS, EFFORTS, DEFAULT_CONFIG, CONFIG_KEY, fromStore, validateConfig, changeBackend, settingsLabel } from "./settings.js";

const PANE = "bro_simplify_experimental";
const CONFIG_PANE = "bro_config_experimental";
const LIMIT = 9000;
function message(error) { return error instanceof Error ? error.message : String(error); }

// Mod state lives at module level so helpers can be top-level functions: the host only lets `$` be passed to
// functions declared at the top of this file. Never place prompts or explanations in the main agent thread.
let lastCompleted = "";
let inMainTurn = false;
let queued = [];
let source = "";
let output = "";
let error = "";
let modelName = "";
let loading = false;
let epoch = 0;
let activeConfig = { ...DEFAULT_CONFIG };
let configDraft = { ...DEFAULT_CONFIG };
let configError = "";
let configSaving = false;

function resetState() {
  dropWaiters("Session restarted.");
  epoch++;
  lastCompleted = ""; inMainTurn = false; source = ""; output = ""; error = ""; loading = false;
  configError = ""; configSaving = false;
}

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
async function readConfig($) {
  // The real Mod has a plugin-scoped persistent store; old offline test fakes may not.
  return $.store?.get ? fromStore(await $.store.get(CONFIG_KEY)) : { ...DEFAULT_CONFIG };
}
async function saveConfig($) {
  if (configSaving) return;
  configSaving = true;
  try {
    const chosen = validateConfig(configDraft);
    if (!$.store?.set) throw new Error("Claude Mod persistent store unavailable");
    await $.store.set(CONFIG_KEY, chosen);
    activeConfig = chosen;
    configError = "";
    $.ui.toast("Bro backend: " + settingsLabel(chosen));
    await $.ui.close({id:CONFIG_PANE});
  } catch (err) {
    configError = message(err);
  } finally {
    configSaving = false;
    repaint($);
  }
}
async function showConfig($) {
  try {
    activeConfig = await readConfig($);
    configDraft = {...activeConfig};
    configError = "";
  } catch (err) {
    configDraft = {...DEFAULT_CONFIG};
    configError = message(err);
  }
  await $.ui.open({id:CONFIG_PANE,title:"Bro — config",focus:true,closeOnEscape:true,rows:17});
  repaint($);
}
async function runSelectedBackend($, config, prompt) {
  if (config.backend === "native") {
    const model = config.model === "current" ? await $.session.model() : config.model;
    const reply = await $.model.complete({model,prompt,maxTokens:8192});
    const text = typeof reply === "string" ? reply
      : reply && reply.isAnswered !== false && typeof reply.text === "string" ? reply.text : "";
    return {text, label:"Claude Native · "+model+" · host effort"};
  }
  // Process.run only reads settled output. Node executes in a private scratch directory.
  // The runner's allowlists are mandatory; it does not accept caller-supplied flags.
  const response = await $.process.run(["node",$.plugin.root+"/runner/execute.mjs"],{
    stdin:JSON.stringify({...config,prompt}),
    timeoutMs:140000
  });
  let body;
  try { body=JSON.parse(response.stdout.trim()); }
  catch { throw new Error("Backend bridge returned invalid JSON: "+(response.stderr||"").slice(0,250)); }
  if(response.exitCode!==0||body?.ok!==true)throw new Error(body?.error||"Backend bridge failed");
  if (typeof body.result?.text !== "string") throw new Error("Backend returned no text");
  return {text:body.result.text,label:settingsLabel(config)};
}
async function simplify($, captured, id = ++epoch) {
  source = captured || "";
  output = ""; error = ""; loading = true;
  repaint($);
  try {
    const config = await readConfig($);
    const reply = await runSelectedBackend($,config,buildBroPrompt(source));
    if (id !== epoch) return; // Pane was closed or a newer request won.
    modelName = reply.label;
    if (!reply.text.trim()) throw new Error("The backend returned no explanation.");
    output = reply.text;
  } catch (err) {
    if (id === epoch) error = message(err);
  } finally {
    if (id === epoch) { loading = false; repaint($); }
  }
}

async function launch($, action) {
  if (action === "config") { await showConfig($); return {text:""}; }
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

export function register(on) {
  resetState();
  on("session.start", async ($, e, next) => {
    resetState();
    await $.command.register({
      name: "bro",
      description: "Privately simplify the latest completed Claude reply",
      argumentHint: "[simplify|open|config]",
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
    if (e.requestId === CONFIG_PANE) {
      const {Box,Text,Button,Input,Select} = $.ui.resolve(e);
      const children=[
        Text({bold:true,children:"Explanation backend"}),
        Text({dimColor:true,children:"Saved: "+settingsLabel(activeConfig)}),
        Text({children:"Choose backend, then set model and effort. Save to apply."})
      ];
      children.push(Box({flexDirection:"row",flexWrap:"wrap",children:BACKENDS.map(backend=>
        Button({key:"choose_"+backend,label:(configDraft.backend===backend?"✓ ":"")+({native:"Claude Native",agy:"Agy",codex:"Codex",pi:"Pi"}[backend]),onPress:()=>{
          configDraft=changeBackend(configDraft,backend);configError="";repaint($);
        }}))}));
      if (Input) children.push(Input({
        key:"bro_model",
        label:"Model:",
        placeholder:configDraft.backend==="pi"?"provider/model":configDraft.backend==="native"?"current, sonnet, opus":"Model ID",
        value:configDraft.model,
        onInput:value=>{configDraft={...configDraft,model:value};},
        onSubmit:value=>{configDraft={...configDraft,model:value};repaint($);}
      }));
      else children.push(Text({children:"Model: "+configDraft.model+" (edit on terminal or desktop)"}));
      if (Select) children.push(Select({
        key:"bro_effort",
        label:"Reasoning:",
        value:configDraft.effort,
        options:EFFORTS[configDraft.backend].map(value=>({label:value,value})),
        onSelect:value=>{configDraft={...configDraft,effort:value};repaint($);}
      }));
      if (configError) children.push(Text({children:"Error: "+configError}));
      children.push(Box({flexDirection:"row",children:[
        Button({key:"bro_save_config",label:configSaving?"Saving...":"Save",onPress:()=>{void saveConfig($);}}),
        Button({key:"bro_cancel_config",label:"Close",onPress:()=>{void $.ui.close({id:CONFIG_PANE});}})
      ]}));
      return Box({flexDirection:"column",padding:1,children});
    }
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
