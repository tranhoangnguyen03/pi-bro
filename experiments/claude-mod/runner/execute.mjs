#!/usr/bin/env node
// Restricted, standalone explain-only CLI bridge for the Claude Mod.
// The existing Pi backend does NOT run here: this deliberately invokes the Pi CLI.
// No project cwd, no shell interpolation, no extra tools, no hidden fallback.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEADLINE_MS = 125_000;
const MAX_INPUT = 500_000;
const MAX_STDOUT = 6_000_000;
const MAX_STDERR = 20_000;
const WRITER = /[\n\r]/;
const KILL_GRACE_MS = 3_000;

export function commandFor({ backend, model, effort, prompt }) {
  if (!["agy", "codex", "pi"].includes(backend)) throw new Error("Unsupported external backend");
  if (typeof model !== "string" || !model.trim() || model.length > 180 || WRITER.test(model) || model.trim().startsWith("-")) throw new Error("Invalid model");
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_INPUT) throw new Error("Invalid prompt size");
  const effortSet = {
    agy: ["default","low","medium","high"],
    codex: ["default","low","medium","high","xhigh"],
    pi: ["default","minimal","low","medium","high","xhigh","max"]
  };
  if (!effortSet[backend].includes(effort)) throw new Error("Unsupported effort");
  if (backend === "agy") {
    const large = Buffer.byteLength(prompt,"utf8") >= 120000;
    return {
      bin: "agy",
      args: ["--sandbox","--disable-slash-commands","--output-format","stream-json",
        "--model",model,...(effort === "default" ? [] : ["--effort",effort]),
        "--print-timeout","2m",...(large ? ["--input-format","stream-json"] : ["--print",prompt])],
      stdin: large ? JSON.stringify({event:"user",message:{content:prompt}})+"\n" : undefined
    };
  }
  if (backend === "codex") return {
    bin: "codex",
    args: ["exec","--sandbox","read-only","--json","--skip-git-repo-check","--ephemeral",
      "--model",model,...(effort==="default"?[]:["-c",'model_reasoning_effort='+JSON.stringify(effort)]),"--","-"],
    stdin: prompt
  };
  if (!/^[^/\s]+\/[^/\s]+/.test(model)) throw new Error("Pi model must be provider/model");
  return {
    bin: "pi",
    args: ["--print","--no-session","--no-extensions","--no-mcp","--no-skills",
      "--no-prompt-templates","--no-context-files","--no-tools","--no-approve",
      "--model",model,...(effort==="default"?[]:["--thinking",effort])],
    stdin: prompt
  };
}

export function canonicalOutput(backend, stdout) {
  if (backend === "pi") {
    const text = stdout.trim();
    if (!text) throw new Error("Pi returned no final answer");
    return text;
  }
  let final = "";
  let success = false;
  let problem = "";
  let events = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.length > 2_000_000) throw new Error("Oversized backend event");
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error("Invalid " + backend + " event JSON"); }
    events++;
    if (backend==="agy") {
      if (event.event === "result") {
        success = event.result?.status === "SUCCESS" && typeof event.result?.response === "string";
        if (success) final = event.result.response;
        else problem = String(event.result?.error || "Agy reported an unsuccessful result");
      }
    } else if (backend==="codex") {
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        const msg = event.item.text ?? event.item.message ?? event.item.content;
        if (typeof msg === "string") final = msg;
      }
      if (event.type === "turn.completed") success = true;
      if (event.type === "turn.failed" || event.type === "error") {
        problem = String(event.error?.message || event.message || "Codex failed");
      }
    }
  }
  if (!events) throw new Error("No " + backend + " events");
  if (problem) throw new Error(problem.slice(0,1000));
  if (!success || !final.trim()) throw new Error("No verified final " + backend + " response");
  return final.trim();
}

export async function run(request, options={}) {
  const plan = commandFor(request);
  const dir = await mkdtemp(join(tmpdir(),"bro-mod-explain-"));
  let child;
  let deadline;
  let timedOut=false;
  let closed=false;
  let stdout="", stderr="";
  let escalation;
  function signal(sig) {
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid,sig); return; } catch {}
    }
    try { child.kill(sig); } catch {}
  }
  function kill() {
    if (!child || closed) return;
    signal("SIGTERM");
    // A child that ignores SIGTERM must not hang the bridge.
    escalation ??= setTimeout(()=>{ if (!closed) signal("SIGKILL"); },KILL_GRACE_MS);
  }
  const abort = () => kill();
  process.on("SIGTERM", abort); process.on("SIGINT", abort);
  try {
    child = spawn(options.commandOverride || plan.bin, options.argsOverride || plan.args,
      {cwd:dir,stdio:["pipe","pipe","pipe"],detached:process.platform!=="win32",
        windowsHide:true,env:options.env || process.env});
    child.stdin.on("error",()=>{}); // early backend rejection reported through exit status
    if (plan.stdin !== undefined) child.stdin.end(plan.stdin); else child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data",chunk=> { stdout+=chunk; if(stdout.length>MAX_STDOUT) kill(); });
    child.stderr.on("data",chunk=> { stderr=(stderr+chunk).slice(-MAX_STDERR); });
    const result=await new Promise(resolve=>{
      child.once("error",err=>resolve({code:-1,error:err.message}));
      child.once("close",(code,signal)=>{closed=true;resolve({code,signal});});
      deadline=setTimeout(()=>{timedOut=true;kill();},options.deadlineMs ?? DEADLINE_MS);
    });
    if (timedOut) throw new Error(request.backend+" exceeded its deadline");
    if(stdout.length>MAX_STDOUT)throw new Error("Backend output exceeded size limit");
    if(result.code !== 0 || result.signal)throw new Error((result.error || stderr || request.backend+" exited unsuccessfully").slice(0,1500));
    return {text:canonicalOutput(request.backend,stdout),model:request.model,backend:request.backend,effort:request.effort};
  } finally {
    clearTimeout(deadline);
    process.off("SIGTERM",abort);process.off("SIGINT",abort);
    kill();
    clearTimeout(escalation);
    await rm(dir,{recursive:true,force:true});
  }
}

async function readInput() {
  let text="";
  for await (const chunk of process.stdin) {
    text+=chunk;
    if(text.length>MAX_INPUT+3000)throw new Error("Request exceeded input limit");
  }
  return JSON.parse(text);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const result=await run(await readInput());
    process.stdout.write(JSON.stringify({ok:true,result})+"\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ok:false,error:e instanceof Error ? e.message : String(e)})+"\n");
    process.exitCode=1;
  }
}
