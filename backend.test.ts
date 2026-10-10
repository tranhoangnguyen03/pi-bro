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
	MAX_STDOUT_LINE_CHARS,
	agySelection,
	beginAttempt,
	execute,
	frameStdoutLines,
} from "./backend.ts";

const withFakeAgy = (script: string, run: (binDir: string) => Promise<void>) => withFakeExecutable("agy", script, run);

test('review inspection fails closed on command-capable adapters', async () => {
 for (const backend of ['agy', 'grok', 'codex'] as const) {
  const result = await execute({feature:'review',access:'restricted',cwd:process.cwd(),prompt:'inspect'}, {backend,model:'test'}, new AbortController().signal);
  assert.equal(result.status,'failure');assert.match(result.message,/Claude or Muse/);
 }
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
