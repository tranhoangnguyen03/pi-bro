import "./test-cli-guard.ts";
import { withFakeExecutable } from "./test-fake-exec.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
	type AgySelection,
	type BackendProgress,
	type BackendRequest,
	type PiHostContext,
	MAX_STDOUT_LINE_CHARS,
	REVIEW_DEADLINE_MS,
	agySelection,
	backendDeadlineMs,
	beginAttempt,
	bridgePiRuntimeForCatalog,
	execute,
	frameStdoutLines,
	getPiHostContext,
	piToolAllowlist,
	reviewBackendNotice,
	setPiHostContext,
	splitPiModel,
} from "../src/backend.ts";

const withFakeAgy = (script: string, run: (binDir: string) => Promise<void>) => withFakeExecutable("agy", script, run);

test("review backend notice recommends file-only inspection only for shell-capable sandboxes", () => {
	assert.equal(reviewBackendNotice("claude"), undefined);
	assert.equal(reviewBackendNotice("muse"), undefined);
	// Pi's Guided Review runs with read/grep/find/ls only: no shell, so no shell advisory.
	assert.equal(reviewBackendNotice("pi"), undefined);
	for (const backend of ["agy", "grok", "codex"] as const) {
		const notice = reviewBackendNotice(backend)!;
		assert.ok(notice.trim(), backend);
		assert.match(notice, /sandboxed shell/);
		assert.match(notice, /not strict file-only inspection/);
		assert.match(notice, /Claude, Muse, or Pi is recommended for untrusted PRs/);
		assert.doesNotMatch(notice, /[\x00-\x1f\x7f]/);
	}
	// Agy's sandbox only restricts terminal commands; it must not be sold as read-only.
	assert.match(reviewBackendNotice("agy")!, /project writes allowed/);
	assert.doesNotMatch(reviewBackendNotice("agy")!, /read-only sandbox/);
	for (const backend of ["codex", "grok"] as const)
		assert.match(reviewBackendNotice(backend)!, /read-only sandbox/);
});

test("review and advisor get the 610-second deadline; explain/show stay short", () => {
	assert.equal(REVIEW_DEADLINE_MS, 610_000);
	// Review must get the long bound for every backend, and no other feature may drift.
	for (const feature of ["review"] as const) assert.equal(backendDeadlineMs(feature, "restricted"), 610_000);
	for (const feature of ["explain", "show"] as const) {
		assert.equal(backendDeadlineMs(feature, "restricted"), 125_000, feature);
		assert.equal(backendDeadlineMs(feature, "workspace-full"), 610_000, feature);
	}
	assert.equal(backendDeadlineMs("btw", "restricted"), 130_000);
	assert.equal(backendDeadlineMs("btw", "workspace-full"), 610_000);
	assert.equal(backendDeadlineMs("advisor", "workspace-full"), 610_000);
});

test("every adapter derives its deadline from backendDeadlineMs, never a local literal", async () => {
	// A single literal in one adapter was the original defect; the helper now owns the table. A
	// source check is the cheap guard a 610-second process test cannot be.
	const source = await readFile(new URL("../src/backend.ts", import.meta.url), "utf8");
	const body = source.slice(source.indexOf("export function backendDeadlineMs"));
	assert.equal(body.slice(0, body.indexOf("\n}")).includes("REVIEW_DEADLINE_MS"), true, "the helper owns the 610s value");
	assert.equal(
		(source.match(/610_000/g) ?? []).length,
		1,
		"610_000 may appear only once, in REVIEW_DEADLINE_MS (no adapter literal)",
	);
	// Every adapter routes through the helper; a new adapter that forgets to is caught here.
	// 6 CLI adapters (Agy argv/stdin, Claude, Grok, Codex, Muse) plus the in-process Pi executor.
	assert.equal((source.match(/deadlineMsOverride \?\? backendDeadlineMs\(/g) ?? []).length, 7);
});

test("pi tool allowlists isolate every capability: no tools for explain/show/elevate, read-only for review, workspace tools for advisor/btw-full", () => {
	// Restricted, non-review features only ever see the prompt: this is the isolation guarantee.
	for (const feature of ["explain", "show"] as const) {
		assert.deepEqual(piToolAllowlist(feature, "restricted"), { tools: [] }, feature);
	}
	assert.deepEqual(piToolAllowlist("btw", "restricted"), { tools: [] });
	// Guided Review gets file-only inspection in the captured checkout, never a shell.
	assert.deepEqual(piToolAllowlist("review", "restricted"), { tools: ["read", "grep", "find", "ls"] });
	for (const [feature, access] of [["advisor", "workspace-full"], ["btw", "workspace-full"]] as const) {
		const allowlist = piToolAllowlist(feature, access);
		assert.deepEqual(allowlist.tools, ["read", "bash", "edit", "write"]);
		// Nested Bro delegation and MCP must never be reachable from a Bro-run Pi child.
		for (const excluded of ["bro_advisor", "external_delegate", "external_workflow", "mcp__*"]) assert.ok(allowlist.excludeTools?.includes(excluded), `${feature}: ${excluded}`);
	}
});

test("splitPiModel splits on the first slash only and rejects malformed pairs", () => {
	assert.deepEqual(splitPiModel("9-router/glm-5.3"), { providerId: "9-router", modelId: "glm-5.3" });
	// Model IDs may contain slashes; only the first one separates provider from model.
	assert.deepEqual(splitPiModel("vendor/family/model-v2"), { providerId: "vendor", modelId: "family/model-v2" });
	assert.equal(splitPiModel("noslash"), undefined);
	assert.equal(splitPiModel("/missing-provider"), undefined);
	assert.equal(splitPiModel("missing-model/"), undefined);
	assert.equal(splitPiModel(""), undefined);
});

test("pi dispatch fails closed without a host registry instead of falling through to a CLI backend", async () => {
	// A physical-looking selection with no host context cannot resolve a model, so execute must fail
	// with a Pi-specific message rather than silently spawning Agy.
	setPiHostContext(undefined);
	assert.equal(getPiHostContext(), undefined);
	const outcome = await execute(
		{ feature: "explain", access: "restricted", prompt: "hi" },
		{ backend: "pi", model: "noslash" },
		new AbortController().signal,
	);
	assert.equal(outcome.status, "failure");
	assert.match((outcome as { message: string }).message, /not a `<provider>\/<id>` model/);
});

test("pi dispatch rejects a virtual model before session construction", async () => {
	setPiHostContext(undefined);
	const outcome = await execute(
		{ feature: "explain", access: "restricted", prompt: "hi" },
		{ backend: "pi", model: "some-provider/pi-virtual-thing" },
		new AbortController().signal,
	);
	assert.equal(outcome.status, "failure");
	assert.match((outcome as { message: string }).message, /not in your Pi model catalog/);
});

// Offline Pi harness: a fake host registry + a fake createAgentSession, so the adapter's real setup,
// cancellation, timeout, terminal-verification and continuation paths run without a provider.
type PiEvent = { type: string; message?: { role: string; content: unknown; stopReason?: string; errorMessage?: string }; toolName?: string; willRetry?: boolean };

function fakePiHost(models: Array<Record<string, unknown>>) {
	const byKey = new Map(models.map((m) => [`${m.provider}/${m.id}`, m]));
	return {
		modelRegistry: {
			getRegisteredProviderIds: () => [],
			getRegisteredNativeProvider: () => undefined,
			getRegisteredProviderConfig: () => undefined,
			getProviderAuthStatus: () => ({ source: "stored" }),
			getApiKeyForProvider: async () => undefined,
			find: (provider: string, id: string) => byKey.get(`${provider}/${id}`),
		},
		scopedModels: [],
	} as unknown as PiHostContext;
}

// A model whose "api" is not pi-virtual, so the physical-only guard lets it through.
const PI_MODEL = { provider: "test-provider", id: "test-model", api: "openai-responses", reasoning: true };

function fakeSession(options: {
	events?: PiEvent[];
	stopReason?: string;
	text?: string;
	agentEnd?: boolean;
	willRetry?: boolean;
	promptNeverSettles?: boolean;
	createDelayMs?: number;
	entries?: unknown[];
	sessionId?: string;
	// Runs inside prompt() so a test can trigger cancellation deterministically instead of on a timer.
	onPrompt?: () => void;
}) {
	const listeners: Array<(event: PiEvent) => void> = [];
	// Counted separately: dispose() also aborts, so a single "aborted" flag would make an
	// abort-was-called assertion pass even if abort() itself never ran.
	let abortCalls = 0;
	let disposed = false;
	const session = {
		sessionId: options.sessionId ?? "fake-session-id",
		messages: [] as unknown[],
		sessionManager: { getEntries: () => options.entries ?? [{ type: "message" }] },
		subscribe(fn: (event: PiEvent) => void) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
		async abort() { abortCalls++; },
		// Mirrors AgentSession.dispose(), which aborts the underlying agent.
		dispose() { disposed = true; },
		async prompt(_text?: string, _promptOptions?: unknown) {
			options.onPrompt?.();
			for (const event of options.events ?? []) for (const fn of [...listeners]) fn(event);
			if (options.agentEnd !== false) for (const fn of [...listeners]) fn({ type: "agent_end", willRetry: options.willRetry === true });
			const text = options.text ?? "done";
			session.messages = [{ role: "assistant", content: [{ type: "text", text }], stopReason: options.stopReason ?? "stop" }];
			if (options.promptNeverSettles) await new Promise(() => {});
		},
	};
	return { session, aborted: () => abortCalls > 0, abortCalls: () => abortCalls, disposed: () => disposed, listeners };
}

const piRequest = (feature: BackendRequest["feature"] = "explain", extra: Partial<BackendRequest> = {}): BackendRequest => ({
	feature, access: feature === "advisor" ? "workspace-full" : "restricted", prompt: "hello",
	...(feature === "advisor" || feature === "review" ? { cwd: process.cwd() } : {}), ...extra,
});

const runPi = (request: BackendRequest, session: ReturnType<typeof fakeSession>, options: Record<string, unknown> = {}, signal = new AbortController().signal) =>
	execute(request, { backend: "pi", model: "test-provider/test-model" }, signal, undefined, {
		...options,
		piCreateSession: (async () => ({ session: session.session })) as never,
	}, fakePiHost([PI_MODEL]));

test("pi returns the final assistant text on a clean turn", async () => {
	const outcome = await runPi(piRequest(), fakeSession({ text: "PONG" }));
	assert.equal(outcome.status, "success");
	assert.equal((outcome as { text: string }).text, "PONG");
});

test("pi rejects model.api === pi-virtual", async () => {
	setPiHostContext(undefined);
	const outcome = await execute(
		{ feature: "explain", access: "restricted", prompt: "hi" },
		{ backend: "pi", model: "test-provider/virtual" },
		new AbortController().signal,
		undefined,
		undefined,
		fakePiHost([{ provider: "test-provider", id: "virtual", api: "pi-virtual", reasoning: false }]),
	);
	assert.equal(outcome.status, "failure");
	assert.match((outcome as { message: string }).message, /virtual model/);
});

for (const stopReason of ["error", "aborted", "length"]) {
	test(`pi refuses to report a ${stopReason} turn as success`, async () => {
		const outcome = await runPi(piRequest(), fakeSession({ stopReason, text: "partial answer" }));
		assert.equal(outcome.status, "failure", stopReason);
		assert.match((outcome as { message: string }).message, /stopReason|did not complete/);
	});
}

test("pi fails when the turn never settles with an agent_end event", async () => {
	const outcome = await runPi(piRequest(), fakeSession({ agentEnd: false, text: "text but no end" }));
	assert.equal(outcome.status, "failure");
	assert.match((outcome as { message: string }).message, /without an agent_end/);
});

test("pi treats an agent_end that still wants to retry as a failure", async () => {
	const outcome = await runPi(piRequest(), fakeSession({ willRetry: true, text: "retrying" }));
	assert.equal(outcome.status, "failure");
	assert.match((outcome as { message: string }).message, /intended to retry/);
});

test("pi fails on an empty final answer", async () => {
	const outcome = await runPi(piRequest(), fakeSession({ text: "" }));
	assert.equal(outcome.status, "failure");
	assert.match((outcome as { message: string }).message, /no final explanation/);
});

test("pi reports cancellation when the signal is already aborted, without starting a turn", async () => {
	const controller = new AbortController();
	controller.abort();
	let created = false;
	const session = fakeSession({ text: "should not run" });
	const outcome = await execute(
		piRequest(), { backend: "pi", model: "test-provider/test-model" }, controller.signal, undefined,
		{ piCreateSession: (async () => { created = true; return { session: session.session }; }) as never },
		fakePiHost([PI_MODEL]),
	);
	assert.equal(outcome.status, "cancelled");
	assert.equal(created, false, "a pre-aborted signal must not construct a session");
});

test("pi reports cancellation when aborted mid-turn", async () => {
	const controller = new AbortController();
	// Abort from inside the turn, not on a wall clock: setup does real file I/O (~20ms), so a fixed
	// timer can fire before the session exists and then only exercise the pre-setup path.
	const session = fakeSession({ promptNeverSettles: true, text: "late", onPrompt: () => controller.abort() });
	const started = Date.now();
	const outcome = await runPi(piRequest(), session, {}, controller.signal);
	assert.equal(outcome.status, "cancelled");
	assert.ok(Date.now() - started < 2_000, "an uncooperative prompt must not hold the caller");
	assert.ok(session.aborted(), "the session must be asked to abort");
});

test("pi reports a timeout even when the deadline fires during setup", async () => {
	// The deadline elapses while createAgentSession is still pending: a timeout does not abort the
	// caller's signal, so only the latch can stop the attempt from starting a paid turn.
	const session = fakeSession({ text: "should not run" });
	let promptCalls = 0;
	const started = Date.now();
	const outcome = await execute(
		piRequest(), { backend: "pi", model: "test-provider/test-model" }, new AbortController().signal, undefined,
		{
			deadlineMs: 30,
			piCreateSession: (async () => { await new Promise((r) => setTimeout(r, 300)); session.session.prompt = async () => { promptCalls++; }; return { session: session.session }; }) as never,
		},
		fakePiHost([PI_MODEL]),
	);
	assert.equal(outcome.status, "timeout");
	assert.equal(promptCalls, 0, "a timed-out attempt must not start a model request");
	// The race must return AT the deadline, not after construction finally resolves 270ms later.
	assert.ok(Date.now() - started < 200, "a deadline during setup must not hold the caller");
});

test("pi reports a timeout when the deadline fires during the turn", async () => {
	const session = fakeSession({ promptNeverSettles: true });
	const started = Date.now();
	const outcome = await runPi(piRequest(), session, { deadlineMs: 40 });
	assert.equal(outcome.status, "timeout");
	assert.ok(Date.now() - started < 2_000);
});

test("pi btw continues the retained in-memory session and fails loudly once it is gone", async () => {
	const first = await runPi(piRequest("btw"), fakeSession({ text: "turn one", sessionId: "pi-btw-1" }));
	assert.equal(first.status, "success");
	assert.equal((first as { continuation?: { id: string } }).continuation?.id, "pi-btw-1");

	const resumed = await runPi(piRequest("btw", { continuation: { id: "pi-btw-1" } }), fakeSession({ text: "turn two", sessionId: "pi-btw-1" }));
	assert.equal(resumed.status, "success", "a retained thread must continue");

	const missing = await runPi(piRequest("btw", { continuation: { id: "never-stored" } }), fakeSession({ text: "must not answer" }));
	assert.equal(missing.status, "failure");
	assert.match((missing as { message: string }).message, /expired/);
});

test("pi review refuses to load the captured checkout's project settings", async () => {
	// A PR-controlled .pi/settings.json must not be merged into the reviewing session.
	const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const checkout = await mkdtemp(join(tmpdir(), "pi-bro-review-trust-"));
	await mkdir(join(checkout, ".pi"), { recursive: true });
	await writeFile(join(checkout, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "max" }));

	let seen: { getDefaultThinkingLevel?: () => string } | undefined;
	const session = fakeSession({ text: "reviewed" });
	const outcome = await execute(
		{ feature: "review", access: "restricted", cwd: checkout, prompt: "review" },
		{ backend: "pi", model: "test-provider/test-model" },
		new AbortController().signal,
		undefined,
		{ piCreateSession: (async (opts: { settingsManager: { getDefaultThinkingLevel?: () => string } }) => { seen = opts.settingsManager; return { session: session.session }; }) as never },
		fakePiHost([PI_MODEL]),
	);
	assert.equal(outcome.status, "success");
	assert.notEqual(seen?.getDefaultThinkingLevel?.(), "max", "PR project settings must be ignored for review");
});

test("grok review fails closed when its permission mode is missing or auto-approving", async () => {
	// A restricting mode other than dontAsk is fine (the sandbox is the boundary), but an
	// auto-approving mode, or no reported mode at all, means the requested restriction was ignored.
	const cases: Array<{ name: string; init: string; ok: boolean }> = [
		{ name: "dontAsk", init: `{type:'system',subtype:'init',permissionMode:'dontAsk',session_id:'s1'}`, ok: true },
		{ name: "plan", init: `{type:'system',subtype:'init',permissionMode:'plan',session_id:'s1'}`, ok: true },
		{ name: "missing", init: `{type:'system',subtype:'init',session_id:'s1'}`, ok: false },
		{ name: "null", init: `{type:'system',subtype:'init',permissionMode:null,session_id:'s1'}`, ok: false },
		{ name: "bypassPermissions", init: `{type:'system',subtype:'init',permissionMode:'bypassPermissions',session_id:'s1'}`, ok: false },
		{ name: "always-approve", init: `{type:'system',subtype:'init',permissionMode:'always-approve',session_id:'s1'}`, ok: false },
	];
	for (const { name, init, ok } of cases) {
		await withFakeExecutable(
			"grok",
			`#!/usr/bin/env node
console.log(JSON.stringify(${init}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,stop_reason:'end_turn',result:'reviewed',session_id:'s1'}));
`,
			async (bin) => {
				const outcome = await execute(
					{ feature: "review", access: "restricted", cwd: bin, prompt: "inspect" },
					{ backend: "grok", model: "test" },
					new AbortController().signal,
				);
				assert.equal(outcome.status, ok ? "success" : "failure", `${name}: ${JSON.stringify(outcome)}`);
				if (!ok) assert.match((outcome as { message: string }).message, /Grok did not apply the required restricted mode/);
			},
		);
	}
});

test("review runs shell-capable backends in their sandbox in the captured checkout", async () => {
	const forbidden = [
		"--dangerously-skip-permissions",
		"--dangerously-bypass-approvals-and-sandbox",
		"--yolo",
		"--permission-mode bypassPermissions",
		"--disable-sandbox",
	];
	for (const backend of ["agy", "grok", "codex"] as const)
		await withFakeExecutable(
			backend,
			`#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.writeFileSync(process.env.BIN_DIR+'/argv.json',JSON.stringify(args));
fs.writeFileSync(process.env.BIN_DIR+'/pwd.txt',process.cwd());
const pair=(flag)=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined;
if(args.some(x=>${JSON.stringify(forbidden)}.includes(x)))process.exit(9);
if(${JSON.stringify(backend)}==='agy'){
 if(!args.includes('--sandbox')||args.includes('--dangerously-skip-permissions'))process.exit(9);
 if(pair('--print-timeout')!=='10m')process.exit(9);
 console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:process.cwd()}}));
}else if(${JSON.stringify(backend)}==='grok'){
 if(pair('--sandbox')!=='read-only'||pair('--permission-mode')!=='dontAsk')process.exit(9);
 const file=pair('--prompt-file');if(file)fs.copyFileSync(file,process.env.BIN_DIR+'/prompt.txt');
 console.log(JSON.stringify({type:'system',subtype:'init',permissionMode:'dontAsk',session_id:'s1'}));
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,stop_reason:'end_turn',result:process.cwd(),session_id:'s1'}));
}else{
 if(pair('--sandbox')!=='read-only'||!args.includes('--ephemeral'))process.exit(9);
 console.log(JSON.stringify({type:'thread.started',thread_id:'t1'}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.cwd()}}));
 console.log(JSON.stringify({type:'turn.completed'}));
}
`,
			async (bin) => {
				const result = await execute(
					{ feature: "review", access: "restricted", cwd: bin, prompt: "inspect" },
					{ backend, model: "test" },
					new AbortController().signal,
				);
				assert.equal(result.status, "success", `${backend}: ${JSON.stringify(result)}`);
				assert.equal(result.status === "success" ? await realpath(result.text) : undefined, await realpath(bin));
				assert.equal(result.status === "success" ? result.continuation : "missing", undefined);
				const promptFile = join(bin, "prompt.txt");
				if (backend === "grok") {
					// Review must be allowed to inspect: no "do not inspect the workspace" prefix.
					assert.doesNotMatch(await readFile(promptFile, "utf8"), /Do not inspect, read, or write workspace files/);
				}
				const argv = JSON.parse(await readFile(join(bin, "argv.json"), "utf8")) as string[];
				assert.doesNotMatch(argv.join(" "), /--dangerously|--yolo|--disable-sandbox|bypassPermissions|--sandbox off/);
			},
		);
});

test('review exposes only confined inspection tools and retains captured cwd', async () => {
 for (const backend of ['claude', 'muse'] as const) await withFakeExecutable(backend, `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
const required=${JSON.stringify([])};
if(${JSON.stringify(backend)}==='claude'){
 fs.readFileSync(0,'utf8');
 for(const flag of ['--restricted','--safe-mode','--no-session-persistence'])if(!args.includes(flag))process.exit(9);
 if(args[args.indexOf('--tools')+1]!=='Read,Grep,Glob'||args[args.indexOf('--permission-mode')+1]!=='dontAsk')process.exit(9);
 console.log(JSON.stringify({type:'system',subtype:'init',permissionMode:'dontAsk'}));
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:process.cwd(),stop_reason:'end_turn'}));
}else{
 for(const flag of ['--disable-write','--disable-shell','--disable-web-tools','--no-foreign-personal-context','--no-session-log'])if(!args.includes(flag))process.exit(9);
 console.log(JSON.stringify({payload_type:'runtime.command.accepted',payload:{command_id:'cmd'}}));
 console.log(JSON.stringify({payload_type:'session.run.linked',payload:{command_id:'cmd',run_stream:{kind:'run',id:'run'}}}));
 console.log(JSON.stringify({payload_type:'run.terminal.completed',payload:{terminal:'completed',text:process.cwd(),run_stream:{kind:'run',id:'run'}}}));
}
if(args.some(x=>['--yolo','--dangerously-skip-permissions','--disable-sandbox','--trust-workspace'].includes(x)))process.exit(9);
`,async bin=>{
  const result=await execute({feature:'review',access:'restricted',cwd:bin,prompt:'inspect'},{backend,model:'test'},new AbortController().signal);
  assert.equal(result.status,'success',JSON.stringify(result));if(result.status==='success'){assert.equal(await realpath(result.text),await realpath(bin));assert.equal(result.continuation,undefined);}
 });
});

test("large multibyte Agy prompts use stdin for explain, show and BTW reseeding", async () => {
 await withFakeAgy(`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
const envelope=JSON.parse(fs.readFileSync(0,'utf8'));
if(!args.includes('--input-format') || args.includes('--print') || envelope.message.content !== 'ế'.repeat(100000)) process.exit(2);
console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'ok',conversation_id:'continued'}}));
`, async binDir => {
  for (const feature of ['explain','show','btw'] as const) {
   const outcome=await execute({feature,access:'restricted',prompt:'ế'.repeat(100000),cwd:binDir}, {model:'test'},new AbortController().signal);
   assert.equal(outcome.status,'success',JSON.stringify(outcome));
   if(feature==='btw' && outcome.status==='success') assert.equal(outcome.continuation?.id,'continued');
  }
 });
});

test("large prompts on old Agy return an upgrade hint without fallback", async () => {
 await withFakeAgy(`#!/bin/sh
echo 'flag provided but not defined: -input-format' >&2
exit 2
`, async () => {
  const outcome=await execute({feature:'explain',access:'restricted',prompt:'x'.repeat(120000)}, {model:'test'},new AbortController().signal);
  assert.equal(outcome.status,'failure');
  assert.match(outcome.message,/Large prompts require Agy 1.1.15/);
 });
});

test("Agy selection normalizes default and suffixed effort", () => {

	assert.deepEqual(agySelection({ model: "gemini-2.5-flash", effort: "default" }), {
		model: "gemini-2.5-flash",
	});
	assert.deepEqual(agySelection({ model: "gemini-2.5-flash-high", effort: "high" }), {
		model: "gemini-2.5-flash",
		effort: "high",
	});
});

test("feature invocation: argv flags, stdin delivery, cwd, model, effort, continuation", async () => {
	await withFakeAgy(
		`#!/bin/sh
echo "$*" > "$BIN_DIR/args.txt"
cat > "$BIN_DIR/stdin.txt"
pwd > "$BIN_DIR/pwd.txt"
case "$*" in
  *--input-format*)
    printf '%s\\n' '{"event":"init","conversation_id":"c1"}'
    printf '%s\\n' '{"event":"step_update","step_update":{"tool_name":"Read files"}}'
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"Advisor verdict: LGTM"}}'
    ;;
  *--conversation*)
    printf '%s\\n' '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Continued answer"}}'
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"Continued answer","conversation_id":"conv-next"}}'
    ;;
  *)
    printf '%s\\n' '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Explanation body"}}'
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"Explanation body"}}'
    ;;
esac
`,
		async (binDir) => {
			process.env.BIN_DIR = binDir;

			// 1. Explain: restricted access, argv transport, model and effort
			const explainRequest: BackendRequest = {
				feature: "explain",
				access: "restricted",
				prompt: "Explain this code snippet",
			};
			const explainSelection: AgySelection = { model: "gemini-2.5-flash", effort: "high" };
			const explainProgress: BackendProgress[] = [];

			const explainOutcome = await execute(
				explainRequest,
				explainSelection,
				new AbortController().signal,
				(p) => explainProgress.push(p),
			);

			assert.equal(explainOutcome.status, "success");
			if (explainOutcome.status === "success") {
				assert.equal(explainOutcome.text, "Explanation body");
			}
			assert.deepEqual(explainProgress, [{ kind: "text", text: "Explanation body" }]);

			const explainArgs = (await readFile(join(binDir, "args.txt"), "utf8")).trim();
			const explainStdin = await readFile(join(binDir, "stdin.txt"), "utf8");
			const explainPwd = (await readFile(join(binDir, "pwd.txt"), "utf8")).trim();

			assert.match(explainArgs, /--sandbox/);
			assert.match(explainArgs, /--disable-slash-commands/);
			assert.match(explainArgs, /--output-format stream-json/);
			assert.match(explainArgs, /--model gemini-2.5-flash/);
			assert.match(explainArgs, /--effort high/);
			assert.match(explainArgs, /--print-timeout 2m/);
			assert.match(explainArgs, /--print Explain this code snippet/);
			assert.doesNotMatch(explainArgs, /--dangerously-skip-permissions/);
			assert.doesNotMatch(explainArgs, /--input-format/);
			assert.equal(explainStdin, "", "explain prompt must be passed via --print argv, not stdin");
			assert.ok(explainPwd.includes("pi-bro-"), "restricted explain must run in a temporary scratch directory");

			// 2. Effort omitted: verify --effort is not passed
			await execute(
				{ feature: "show", access: "restricted", prompt: "Show diagram" },
				{ model: "gemini-2.5-flash" },
				new AbortController().signal,
			);
			const showArgs = (await readFile(join(binDir, "args.txt"), "utf8")).trim();
			assert.doesNotMatch(showArgs, /--effort/, "--effort flag must be omitted when effort is not specified");

			// 3. Advisor: workspace-full access, stdin transport, custom cwd
			const advisorRequest: BackendRequest = {
				feature: "advisor",
				access: "workspace-full",
				prompt: "Review the plan",
				cwd: binDir,
			};
			const advisorProgress: BackendProgress[] = [];
			const advisorOutcome = await execute(
				advisorRequest,
				{ model: "gemini-advisor-model", effort: "medium" },
				new AbortController().signal,
				(p) => advisorProgress.push(p),
			);

			assert.equal(advisorOutcome.status, "success");
			if (advisorOutcome.status === "success") {
				assert.equal(advisorOutcome.text, "Advisor verdict: LGTM");
			}
			assert.equal(advisorProgress.length, 1);
			assert.equal(advisorProgress[0].kind, "activity");
			if (advisorProgress[0].kind === "activity") {
				assert.equal(advisorProgress[0].label, "Read files");
			}

			const advisorArgs = (await readFile(join(binDir, "args.txt"), "utf8")).trim();
			const advisorStdin = await readFile(join(binDir, "stdin.txt"), "utf8");
			const advisorPwd = (await readFile(join(binDir, "pwd.txt"), "utf8")).trim();

			assert.match(advisorArgs, /--dangerously-skip-permissions/);
			assert.match(advisorArgs, /--output-format stream-json/);
			assert.match(advisorArgs, /--input-format stream-json/);
			assert.match(advisorArgs, /--model gemini-advisor-model/);
			assert.match(advisorArgs, /--effort medium/);
			assert.match(advisorArgs, /--print-timeout 10m/);
			assert.doesNotMatch(advisorArgs, /--print /);
			assert.equal(
				advisorStdin,
				`${JSON.stringify({ event: "user", message: { content: "Review the plan" } })}\n`,
				"advisor prompt must be delivered via stdin NDJSON",
			);
			assert.equal(await realpath(advisorPwd), await realpath(binDir), "workspace-full advisor must run in the caller-supplied cwd");

			// 4. BTW Continuation: pass continuation ID and receive updated continuation ID
			const btwRequest: BackendRequest = {
				feature: "btw",
				access: "workspace-full",
				prompt: "What is next?",
				cwd: binDir,
				continuation: { id: "conv-prev" },
			};
			const btwOutcome = await execute(
				btwRequest,
				{ model: "gemini-2.5-flash" },
				new AbortController().signal,
			);

			assert.equal(btwOutcome.status, "success");
			if (btwOutcome.status === "success") {
				assert.equal(btwOutcome.text, "Continued answer");
				assert.deepEqual(btwOutcome.continuation, { id: "conv-next" });
			}
			const btwArgs = (await readFile(join(binDir, "args.txt"), "utf8")).trim();
			assert.match(btwArgs, /--conversation conv-prev/);

			delete process.env.BIN_DIR;
		},
	);
});

test("terminal failure after partial: returns failure outcome and preserves partial progress", async () => {
	await withFakeAgy(
		`#!/bin/sh
cat > /dev/null
case "$*" in
  *--input-format*)
    printf '%s\\n' '{"event":"step_update","step_update":{"step_type":"assistant","text_delta":"First thoughts..."}}'
    printf '%s\\n' '{"event":"result","result":{"status":"ERROR","error":"context length exceeded"}}'
    ;;
  *)
    printf '%s\\n' '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Halfway through..."}}'
    printf '%s\\n' '{"event":"result","result":{"status":"ERROR","error":"model overloaded"}}'
    ;;
esac
`,
		async (binDir) => {
			// Explain partial failure
			const explainProgress: BackendProgress[] = [];
			const explainOutcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				{ model: "gemini-2.5-flash" },
				new AbortController().signal,
				(p) => explainProgress.push(p),
			);

			assert.equal(explainOutcome.status, "failure");
			assert.deepEqual(explainProgress, [{ kind: "text", text: "Halfway through..." }]);
			if (explainOutcome.status === "failure") {
				assert.equal(explainOutcome.partialText, "Halfway through...");
				assert.match(explainOutcome.message, /Agy returned invalid streaming data|did not complete/);
			}

			// Advisor partial failure
			const advisorProgress: BackendProgress[] = [];
			const advisorOutcome = await execute(
				{ feature: "advisor", access: "workspace-full", prompt: "Advise", cwd: binDir },
				{ model: "gemini-advisor-model" },
				new AbortController().signal,
				(p) => advisorProgress.push(p),
			);

			assert.equal(advisorOutcome.status, "failure");
			assert.equal(advisorProgress.length, 1);
			assert.equal(advisorProgress[0].kind, "activity");
			if (advisorOutcome.status === "failure") {
				assert.match(advisorOutcome.message, /ERROR: context length exceeded/);
			}
		},
	);
});

test("missing terminal: handles clean exit without terminal result and old-Agy flag error", async () => {
	// Missing terminal event on exit 0
	await withFakeAgy(
		`#!/bin/sh
cat > /dev/null
printf '%s\\n' '{"event":"init","conversation_id":"c1"}'
exit 0
`,
		async (binDir) => {
			const outcome = await execute(
				{ feature: "advisor", access: "workspace-full", prompt: "Advise", cwd: binDir },
				{ model: "gemini-advisor-model" },
				new AbortController().signal,
			);
			assert.equal(outcome.status, "failure");
			if (outcome.status === "failure") {
				assert.match(outcome.message, /Agy exited without a terminal result event/);
				assert.match(outcome.message, /\/bro doctor/);
			}
		},
	);

	// Missing terminal due to outdated Agy rejecting --input-format
	await withFakeAgy(
		`#!/bin/sh
cat > /dev/null
echo 'flag provided but not defined: -input-format' >&2
echo 'Usage of agy:' >&2
exit 2
`,
		async (binDir) => {
			const outcome = await execute(
				{ feature: "advisor", access: "workspace-full", prompt: "Advise", cwd: binDir },
				{ model: "gemini-advisor-model" },
				new AbortController().signal,
			);
			assert.equal(outcome.status, "failure");
			if (outcome.status === "failure") {
				assert.match(outcome.message, /installed Agy CLI is too old; the advisor needs Agy 1\.1\.15\+/);
				assert.match(outcome.message, /agy update/);
			}
		},
	);
});

test("preabort: rejects immediately when signal is already aborted without spawning", async () => {
	await withFakeAgy(
		`#!/bin/sh
echo "SPAWNED" > "$BIN_DIR/spawned.txt"
exit 0
`,
		async (binDir) => {
			process.env.BIN_DIR = binDir;
			const controller = new AbortController();
			controller.abort();

			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				{ model: "gemini-2.5-flash" },
				controller.signal,
			);

			assert.equal(outcome.status, "cancelled");
			if (outcome.status === "cancelled") {
				assert.equal(outcome.message, "Canceled.");
			}
			assert.equal(
				existsSync(join(binDir, "spawned.txt")),
				false,
				"pre-aborted execution must not spawn child process",
			);
			delete process.env.BIN_DIR;
		},
	);
});

test("timeout, cancel, and unexpected signal handling", async () => {
	// Cancel mid-run
	await withFakeAgy(
		`#!/bin/sh
cat > /dev/null
sleep 10
`,
		async () => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 100);

			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				{ model: "gemini-2.5-flash" },
				controller.signal,
			);

			assert.equal(outcome.status, "cancelled");
			if (outcome.status === "cancelled") {
				assert.equal(outcome.message, "Canceled.");
			}
		},
	);

	// Host deadline / timeout
	await withFakeAgy(
		`#!/bin/sh
cat > /dev/null
sleep 10
`,
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				{ model: "gemini-2.5-flash" },
				new AbortController().signal,
				undefined,
				{ deadlineMs: 150, killEscalationMs: 150 },
			);

			assert.equal(outcome.status, "timeout");
			if (outcome.status === "timeout") {
				assert.match(outcome.message, /Agy timed out while simplifying the response/);
			}
		},
	);

	// Unexpected signal (e.g. killed by SIGHUP or SIGKILL externally)
	await withFakeAgy(
		`#!/bin/sh
cat > /dev/null
kill -HUP $$
`,
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				{ model: "gemini-2.5-flash" },
				new AbortController().signal,
			);

			assert.equal(outcome.status, "failure");
			if (outcome.status === "failure") {
				assert.match(outcome.message, /Agy exited unexpectedly \(signal SIGHUP\)/);
				assert.doesNotMatch(outcome.message, /timed out/, "unexpected signal must not be mislabeled as timeout");
			}
		},
	);
});

test("POSIX child/grandchild ignoring TERM escalates to SIGKILL with bounded cleanup", { skip: process.platform === "win32" }, async () => {
	await withFakeAgy(
		`#!/bin/sh
trap '' TERM
cat > /dev/null
(trap '' TERM; while :; do sleep 1; done) &
echo "$!" > "$BIN_DIR/grandchild.pid"
touch "$BIN_DIR/ready"
wait
touch "$BIN_DIR/still-running-after-kill.txt"
`,
		async (binDir) => {
			process.env.BIN_DIR = binDir;
			const marker = join(binDir, "still-running-after-kill.txt");
			const controller = new AbortController();
			const readyTimer = setInterval(() => {
				if (existsSync(join(binDir, "ready"))) controller.abort();
			}, 10);

			const startedAt = Date.now();
			const outcome = await execute(
				{ feature: "advisor", access: "workspace-full", prompt: "Advise", cwd: binDir },
				{ model: "gemini-advisor-model" },
				controller.signal,
				undefined,
				{ killEscalationMs: 200 },
			);

			clearInterval(readyTimer);
			const elapsed = Date.now() - startedAt;
			assert.equal(outcome.status, "cancelled");
			assert.ok(existsSync(join(binDir, "ready")), "fixture reached TERM-resistant state before cancellation");
			const grandchildPid = Number(await readFile(join(binDir, "grandchild.pid"), "utf8"));
			// Allow the OS to reap after SIGKILL before probing the process table.
			await new Promise(resolve => setTimeout(resolve, 100));
			const probe = spawnSync("ps", ["-o", "stat=", "-p", String(grandchildPid)], { encoding: "utf8" });
			assert.equal(probe.error, undefined, probe.error?.message);
			const state = (probe.stdout ?? "").trim();
			assert.ok(!state || state.startsWith("Z"), `grandchild must be gone or awaiting reaping, got ${state}`);
			assert.ok(elapsed < 4_000, `SIGKILL escalation must bound cleanup time (took ${elapsed}ms, expected < 4000ms)`);
			assert.equal(
				existsSync(marker),
				false,
				"process group was forcibly killed before reaching code after sleep",
			);
			delete process.env.BIN_DIR;
		},
	);
});

test("temp dirs and progress cleanup: scratch directory removed on success, failure, and cancel", async () => {
	await withFakeAgy(
		`#!/bin/sh
pwd > "$BIN_DIR/used-cwd.txt"
case "$*" in
  *FAIL*)
    exit 1
    ;;
  *SLEEP*)
    cat > /dev/null
    sleep 10
    ;;
  *)
    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'
    ;;
esac
`,
		async (binDir) => {
			process.env.BIN_DIR = binDir;
			const cwdFile = join(binDir, "used-cwd.txt");

			// 1. Cleaned up on success
			const successOutcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Success case" },
				{ model: "gemini-2.5-flash" },
				new AbortController().signal,
			);
			assert.equal(successOutcome.status, "success");
			const successCwd = (await readFile(cwdFile, "utf8")).trim();
			assert.ok(successCwd.includes("pi-bro-"), "used scratch directory");
			assert.equal(existsSync(successCwd), false, "scratch directory must be removed on success");

			// 2. Cleaned up on failure
			const failOutcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "FAIL case" },
				{ model: "gemini-2.5-flash" },
				new AbortController().signal,
			);
			assert.equal(failOutcome.status, "failure");
			const failCwd = (await readFile(cwdFile, "utf8")).trim();
			assert.ok(failCwd.includes("pi-bro-"), "used scratch directory");
			assert.equal(existsSync(failCwd), false, "scratch directory must be removed on failure");

			// 3. Cleaned up on cancellation
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 100);
			const cancelOutcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "SLEEP case" },
				{ model: "gemini-2.5-flash" },
				controller.signal,
			);
			assert.equal(cancelOutcome.status, "cancelled");
			const cancelCwd = (await readFile(cwdFile, "utf8")).trim();
			assert.ok(cancelCwd.includes("pi-bro-"), "used scratch directory");
			assert.equal(existsSync(cancelCwd), false, "scratch directory must be removed on cancel");

			delete process.env.BIN_DIR;
		},
	);
});


test("invalid feature/access/continuation combinations fail before invocation", async () => {
 await withFakeAgy('#!/bin/sh\ntouch "$(dirname "$0")/spawned"\nexit 1\n', async (binDir) => {
 for (const request of [
  { feature: "advisor", access: "restricted", cwd: process.cwd() },
  { feature: "advisor", access: "workspace-full" },
  { feature: "explain", access: "workspace-full", cwd: process.cwd() },
  { feature: "show", access: "restricted", continuation: { id: "wrong" } },
 ] as Omit<BackendRequest, "prompt">[]) {
  const outcome = await execute({ prompt: "test", ...request }, { model: "test" }, new AbortController().signal);
  assert.equal(outcome.status, "failure");
  assert.match(outcome.message, /Unsupported execution request/);
 }
 assert.equal(existsSync(join(binDir, "spawned")), false);
 });
});


test("deadline stays timeout when a terminating child emits malformed output", async () => {
 await withFakeAgy(`#!/usr/bin/env node
process.on('SIGTERM', () => { console.log('not-json'); setTimeout(() => process.exit(0), 20); });
console.log(JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'ready'}}));
setInterval(() => {}, 1000);
`, async () => {
  for (const feature of ["explain", "advisor"] as const) {
   const outcome = await execute({ feature, prompt: "test", access: feature === "advisor" ? "workspace-full" : "restricted", cwd: process.cwd() }, { model: "test" }, new AbortController().signal, undefined, { deadlineMs: 200, killEscalationMs: 100 });
   assert.equal(outcome.status, "timeout");
  }
 });
});

test("frameStdoutLines: split records, UTF-8 boundaries, CRLF, limits, and final flush", async () => {
	const stream = new PassThrough();
	let stopCause: string | undefined;
	const mockAttempt = {
		causeOf: () => stopCause as any,
		stop: (cause: any) => { stopCause ??= cause; },
		closed: Promise.resolve({ code: 0, exitSignal: null }),
		dispose: () => {},
	};
	const received: string[] = [];
	const finish = frameStdoutLines(
		{ stdout: stream } as any,
		mockAttempt,
		"TestBackend",
		(line) => received.push(line),
	);

	// 1. Split JSON record across chunks
	stream.write('{"type":"step');
	stream.write('_update","delta":"he');
	stream.write('llo"}\n');
	assert.equal(received.length, 1);
	assert.equal(received[0], '{"type":"step_update","delta":"hello"}');

	// 2. Multibyte UTF-8 split across byte chunks ('ế' is 0xE1 0xBA 0xBF)
	stream.write(Buffer.from([0xe1, 0xba]));
	stream.write(Buffer.from([0xbf, 0x0a])); // followed by \n
	assert.equal(received.length, 2);
	assert.equal(received[1], "ế");

	// 3. CRLF split across chunks (\r at end of chunk 1, \n at start of chunk 2)
	stream.write('{"line":"crlf"}\r');
	stream.write('\n{"line":"next"}\r\n');
	assert.equal(received.length, 4);
	assert.equal(received[2], '{"line":"crlf"}');
	assert.equal(received[3], '{"line":"next"}');

	// 4. Exact limit boundary
	const exactPayload = "x".repeat(MAX_STDOUT_LINE_CHARS);
	stream.write(exactPayload + "\r");
	stream.write("\n");
	assert.equal(received.length, 5);
	assert.equal(received[4], exactPayload);

	// 5. Final record without trailing newline
	stream.write('{"final":"record"}');
	stream.end();

	const protocolError = finish();
	assert.equal(protocolError, undefined);
	assert.equal(received.length, 6);
	assert.equal(received[5], '{"final":"record"}');
});

test("frameStdoutLines: oversized line fails closed immediately and stops attempt", async () => {
	const stream = new PassThrough();
	let stopCause: string | undefined;
	const mockAttempt = {
		causeOf: () => stopCause as any,
		stop: (cause: any) => { stopCause ??= cause; },
		closed: Promise.resolve({ code: 0, exitSignal: null }),
		dispose: () => {},
	};
	const received: string[] = [];
	const finish = frameStdoutLines(
		{ stdout: stream } as any,
		mockAttempt,
		"TestBackend",
		(line) => received.push(line),
	);

	stream.write("a".repeat(MAX_STDOUT_LINE_CHARS + 1) + "\n");
	assert.equal(stopCause, "protocol");
	const error = finish();
	assert.match(error ?? "", /TestBackend emitted a stdout line over 2000000 characters/);
	assert.equal(received.length, 0);

	// Also test pending buffer overflow without newline
	let pendingStopCause: string | undefined;
	const pendingAttempt = {
		causeOf: () => pendingStopCause as any,
		stop: (cause: any) => { pendingStopCause ??= cause; },
		closed: Promise.resolve({ code: 0, exitSignal: null }),
		dispose: () => {},
	};
	const pendingStream = new PassThrough();
	const finishPending = frameStdoutLines(
		{ stdout: pendingStream } as any,
		pendingAttempt,
		"TestBackend",
		() => {},
	);
	pendingStream.write("b".repeat(MAX_STDOUT_LINE_CHARS + 1));
	assert.equal(pendingStopCause, "protocol");
	assert.match(finishPending() ?? "", /TestBackend emitted a stdout line over 2000000 characters/);
});

test("frameStdoutLines: stream error triggers protocol failure", async () => {
	const stream = new PassThrough();
	let stopCause: string | undefined;
	const mockAttempt = {
		causeOf: () => stopCause as any,
		stop: (cause: any) => { stopCause ??= cause; },
		closed: Promise.resolve({ code: 0, exitSignal: null }),
		dispose: () => {},
	};
	const finish = frameStdoutLines(
		{ stdout: stream } as any,
		mockAttempt,
		"TestBackend",
		() => {},
	);

	stream.emit("error", new Error("Simulated pipe failure"));
	assert.equal(stopCause, "protocol");
	const error = finish();
	assert.match(error ?? "", /TestBackend stdout error: Simulated pipe failure/);
});

test("beginAttempt: stop after close latches cause without process signaling", async () => {
	const { EventEmitter } = await import("node:events");
	const fakeChild = new EventEmitter() as any;
	fakeChild.pid = 999999;
	const controller = new AbortController();
	const attempt = beginAttempt(fakeChild, controller.signal, 10_000, 5_000);

	// Simulate normal close
	fakeChild.emit("close", 0, null);
	const res = await attempt.closed;
	assert.equal(res.code, 0);

	// Calling stop after close should latch cause without throwing or signaling
	attempt.stop("protocol");
	assert.equal(attempt.causeOf(), "protocol");
	attempt.dispose();
});

test("production Agy framing: split chunks, CRLF, final record without newline, and oversized line for explain and advisor", async () => {
	await withFakeAgy(`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.TEST_MODE || 'split';

if (mode === 'split') {
	process.stdout.write('{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"half ');
	setTimeout(() => {
		process.stdout.write('way"}}\\r\\n');
		process.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"finished answer"}}');
		// no trailing newline on final record
	}, 20);
} else if (mode === 'split_advisor') {
	process.stdout.write('{"event":"step_update","step_update":{"tool_name":"grep');
	setTimeout(() => {
		process.stdout.write('_search"}}\\r\\n');
		process.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"advisor answer"}}');
	}, 20);
} else if (mode === 'oversized') {
	process.stdout.write('x'.repeat(2000001) + '\\n');
} else if (mode === 'oversized_no_newline') {
	process.stdout.write('x'.repeat(2000001));
}
`, async (binDir) => {
		try {
			// 1. Split chunks + CRLF + final record without newline (explain)
			process.env.TEST_MODE = "split";
			let progressText = "";
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "split test", cwd: binDir },
				{ model: "gemini-2.5-flash" },
				new AbortController().signal,
				(prog) => { if (prog.kind === "text") progressText = prog.text; },
			);
			assert.equal(outcome.status, "success", JSON.stringify(outcome));
			assert.equal(outcome.text, "finished answer");
			assert.equal(progressText, "half way");

			// 2. Split chunks + CRLF + final record without newline (advisor)
			process.env.TEST_MODE = "split_advisor";
			let activityLabel = "";
			const advisorOutcome = await execute(
				{ feature: "advisor", access: "workspace-full", prompt: "advisor test", cwd: binDir },
				{ model: "gemini-2.5-flash" },
				new AbortController().signal,
				(prog) => { if (prog.kind === "activity") activityLabel = prog.label; },
			);
			assert.equal(advisorOutcome.status, "success", JSON.stringify(advisorOutcome));
			assert.equal(advisorOutcome.text, "advisor answer");
			assert.equal(activityLabel, "grep_search");

			// 3. Oversized line (> 2MB) fails closed for explain and advisor (both newline-terminated and newline-free)
			process.env.TEST_MODE = "oversized";
			const overOutcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "oversized test", cwd: binDir },
				{ model: "gemini-2.5-flash" },
				new AbortController().signal,
			);
			assert.equal(overOutcome.status, "failure");
			assert.match(overOutcome.message, /over 2000000 characters/);

			process.env.TEST_MODE = "oversized_no_newline";
			const advisorOverOutcome = await execute(
				{ feature: "advisor", access: "workspace-full", prompt: "advisor oversized test", cwd: binDir },
				{ model: "gemini-2.5-flash" },
				new AbortController().signal,
			);
			assert.equal(advisorOverOutcome.status, "failure");
			assert.match(advisorOverOutcome.message, /over 2000000 characters/);
		} finally {
			delete process.env.TEST_MODE;
		}
	});
});

test("pi disposes a session that resolves after the stop race was already lost", async () => {
	// When the stop wins the construction race, construction can still finish later. That session is
	// never prompted, so it must be torn down here or its listeners and resources leak.
	const session = fakeSession({ text: "must not run" });
	let disposed = 0;
	let prompted = 0;
	session.session.dispose = () => { disposed++; };
	session.session.prompt = async () => { prompted++; };
	// A gate the test opens itself, and a cancellation driven from inside construction: a wall-clock
	// deadline could fire during runtime preparation, before a session is ever created.
	let releaseConstruction: () => void = () => {};
	const constructionGate = new Promise<void>((resolve) => { releaseConstruction = resolve; });
	const controller = new AbortController();
	const outcome = await execute(
		piRequest(), { backend: "pi", model: "test-provider/test-model" }, controller.signal, undefined,
		{ piCreateSession: (async () => { controller.abort(); await constructionGate; return { session: session.session }; }) as never },
		fakePiHost([PI_MODEL]),
	);
	assert.equal(outcome.status, "cancelled");
	assert.equal(prompted, 0, "a stopped attempt must not start a model request");
	// Now let construction finish and wait for its cleanup to be observed, rather than guessing a delay.
	releaseConstruction();
	for (let i = 0; i < 400 && disposed === 0; i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(disposed, 1, "the late session must be disposed exactly once");
});

test("pi re-issues abort when a stop is latched during prompt preflight", async () => {
	// session.prompt() awaits an auth check before any run exists, and abort() only latches while a run
	// is active, so a stop in that window would be forgotten. preflightResult must re-issue it.
	const session = fakeSession({});
	let aborts = 0;
	const controller = new AbortController();
	session.session.abort = async () => { aborts++; };
	session.session.prompt = async (_text: string, options?: { preflightResult?: (d: string) => void }) => {
		// Emulate the SDK's asynchronous preflight, aborting from inside it so the stop is guaranteed to
		// land after the run starts regardless of machine load.
		controller.abort();
		options?.preflightResult?.("started");
		await new Promise(() => {});
	};
	const outcome = await runPi(piRequest(), session, {}, controller.signal);
	assert.equal(outcome.status, "cancelled");
	// The latch aborts immediately; the preflight callback re-issues it. Poll rather than guess a delay.
	for (let i = 0; i < 200 && aborts < 2; i++) await new Promise((r) => setTimeout(r, 5));
	assert.ok(aborts >= 2, `abort must be re-issued at preflight (saw ${aborts})`);
});

test("pi catalog bridge copies runtime keys for providers that are only in the model catalog", async () => {
	// getRegisteredProviderIds() lists extension registrations only, so a runtime key set on a built-in
	// provider (Pi's own --api-key) must be found through the model catalog instead.
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
	const { join } = await import("node:path");
	const agentDir = getAgentDir();
	const hostRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	const provider = hostRuntime.getAllModels()[0]?.provider;
	assert.ok(provider, "the fixture needs at least one installed model");
	await hostRuntime.setRuntimeApiKey(provider, "sk-fixture-runtime-key");
	const catalogRuntime = await bridgePiRuntimeForCatalog(
		{ modelRegistry: new (await import("@earendil-works/pi-coding-agent")).ModelRegistry(hostRuntime) } as never,
		agentDir,
	);
	assert.equal(catalogRuntime.getProviderAuthStatus(provider).source, "runtime", "the runtime key must be carried across");
});

test("pi bounds runtime preparation by the deadline", async () => {
	// Credential preparation is real I/O and sits inside the latch: a slow lookup must not extend the
	// deadline. (A never-resolving lookup would only let the process exit, since the timer is unref'd.)
	const baseRegistry = fakePiHost([PI_MODEL]).modelRegistry as unknown as Record<string, unknown>;
	const slowHost = {
		modelRegistry: {
			...baseRegistry,
			getProviderAuthStatus: () => ({ source: "runtime" }),
			getApiKeyForProvider: () => new Promise((r) => setTimeout(() => r("sk-late"), 5_000)),
		},
		scopedModels: [],
	} as unknown as PiHostContext;
	const started = Date.now();
	const outcome = await execute(
		piRequest(), { backend: "pi", model: "test-provider/test-model" }, new AbortController().signal, undefined,
		{ deadlineMs: 40 },
		slowHost,
	);
	assert.equal(outcome.status, "timeout", "a slow credential lookup must be bounded by the deadline");
	assert.ok(Date.now() - started < 2_000, "preparation must not hold the caller past the deadline");
});

test("pi turns a throwing host registry into a failure outcome, not a rejection", async () => {
	// A stale extension ctx throws from its getters; execute() must still return an outcome.
	const throwingHost = { get modelRegistry(): never { throw new Error("stale extension ctx"); }, scopedModels: [] } as never;
	const outcome = await execute(
		piRequest(), { backend: "pi", model: "test-provider/test-model" }, new AbortController().signal, undefined,
		undefined,
		throwingHost,
	);
	assert.equal(outcome.status, "failure");
	assert.match((outcome as { message: string }).message, /stale extension ctx/);
});

test("pi builds the child session with retry, compaction and cache warming off", async () => {
	// These must hold in the manager the session actually receives. Cache warming matters most: it is
	// read from globalSettings, so an applyOverrides() would not take, and a warm replay is a paid
	// request Bro's single attempt never asked for.
	let seen: { getCacheWarmingMode: () => string; getRetrySettings: () => { enabled: boolean }; getProviderRetrySettings: () => { maxRetries?: number }; getCompactionSettings: () => { enabled: boolean } } | undefined;
	await execute(
		piRequest(), { backend: "pi", model: "test-provider/test-model" }, new AbortController().signal, undefined,
		{ piCreateSession: (async (opts: { settingsManager: typeof seen }) => { seen = opts.settingsManager; return { session: fakeSession({ text: "ok" }).session }; }) as never },
		fakePiHost([PI_MODEL]),
	);
	assert.ok(seen, "the session must receive a settings manager");
	assert.equal(seen!.getRetrySettings().enabled, false, "SDK retry must be off");
	assert.equal(seen!.getProviderRetrySettings().maxRetries, 0, "provider retries must be off");
	assert.equal(seen!.getCompactionSettings().enabled, false, "compaction must be off");
	assert.equal(seen!.getCacheWarmingMode(), "off", "cache warming must be off (it can replay a paid request)");
});

test("pi does not trust project settings when the host has not trusted the workspace", async () => {
	const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const cwd = await mkdtemp(join(tmpdir(), "pi-bro-untrusted-"));
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "max" }));

	let seen: { getSettings: () => { defaultThinkingLevel?: string } } | undefined;
	const host = { ...(fakePiHost([PI_MODEL]) as unknown as Record<string, unknown>), isProjectTrusted: () => false };
	await execute(
		{ feature: "explain", access: "restricted", prompt: "hi", cwd },
		{ backend: "pi", model: "test-provider/test-model" },
		new AbortController().signal, undefined,
		{ piCreateSession: (async (opts: { settingsManager: typeof seen }) => { seen = opts.settingsManager; return { session: fakeSession({ text: "ok" }).session }; }) as never },
		host as never,
	);
	assert.ok(seen, "the session must have been constructed");
	assert.notEqual(seen.getSettings().defaultThinkingLevel, "max", "an untrusted workspace's settings must not apply");
	// Control: with a trusting host the same file IS read, so the assertion above is not vacuous.
	let trusted: { getSettings: () => { defaultThinkingLevel?: string } } | undefined;
	await execute(
		{ feature: "explain", access: "restricted", prompt: "hi", cwd },
		{ backend: "pi", model: "test-provider/test-model" },
		new AbortController().signal, undefined,
		{ piCreateSession: (async (opts: { settingsManager: typeof trusted }) => { trusted = opts.settingsManager; return { session: fakeSession({ text: "ok" }).session }; }) as never },
		{ ...(fakePiHost([PI_MODEL]) as unknown as Record<string, unknown>), isProjectTrusted: () => true } as never,
	);
	assert.equal(trusted?.getSettings().defaultThinkingLevel, "max", "a trusting host must still honour the workspace's settings");
});

test("pi rejects a corrupt selection as an outcome instead of throwing", async () => {
	// Every CLI adapter validates its selection first; without this a bad runtime tag throws a
	// TypeError out of execute() and violates the "always an outcome" contract.
	for (const selection of [
		{ backend: "pi", model: "" },
		{ backend: "pi", model: "ok/model", effort: "turbo" },
	]) {
		const outcome = await execute(
			piRequest(), selection as never, new AbortController().signal, undefined, undefined, fakePiHost([PI_MODEL]),
		);
		assert.equal(outcome.status, "failure", JSON.stringify(selection));
		assert.match((outcome as { message: string }).message, /Unsupported Pi selection/);
	}
});


test("pi preserves workspace trust for system prompt discovery after settings reload", async () => {
	const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const directory = await mkdtemp(join(tmpdir(), "pi-bro-system-trust-"));
	const cwd = join(directory, "workspace");
	const agentDir = join(directory, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await mkdir(agentDir);
		await writeFile(join(cwd, ".pi", "SYSTEM.md"), "REPO_SYSTEM_CANARY");
		await writeFile(join(cwd, ".pi", "APPEND_SYSTEM.md"), "REPO_APPEND_CANARY");
		for (const [feature, isProjectTrusted, expectedTrust] of [
			["review", () => true, false],
			["explain", () => false, false],
			["explain", () => { throw Error("stale context"); }, false],
			["explain", () => true, true],
		] as const) {
			let seen: { trusted: boolean; system: string | undefined; append: string[] } | undefined;
			const outcome = await execute(
				piRequest(feature, { cwd }),
				{ backend: "pi", model: "test-provider/test-model" },
				new AbortController().signal, undefined,
				{ piCreateSession: (async (opts: {
					settingsManager: { isProjectTrusted(): boolean };
					resourceLoader: { reload(): Promise<void>; getSystemPrompt(): string | undefined; getAppendSystemPrompt(): string[] };
				}) => {
					await opts.resourceLoader.reload();
					seen = {
						trusted: opts.settingsManager.isProjectTrusted(),
						system: opts.resourceLoader.getSystemPrompt(),
						append: opts.resourceLoader.getAppendSystemPrompt(),
					};
					return { session: fakeSession({ text: "ok" }).session };
				}) as never },
				{ ...fakePiHost([PI_MODEL]), isProjectTrusted } as never,
			);
			assert.equal(outcome.status, "success");
			assert.ok(seen);
			assert.equal(seen.system, expectedTrust ? "REPO_SYSTEM_CANARY" : undefined, `${feature}: repo SYSTEM.md must follow trust`);
			assert.deepEqual(seen.append, expectedTrust ? ["REPO_APPEND_CANARY"] : []);
			assert.equal(seen.trusted, expectedTrust, `${feature}: child must preserve the trust decision`);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});
