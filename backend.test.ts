import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type AgySelection,
	type BackendOnProgress,
	type BackendProgress,
	type BackendRequest,
	agySelection,
	execute,
} from "./backend.ts";

const originalPath = process.env.PATH;

async function withFakeAgy(script: string, run: (binDir: string) => Promise<void>): Promise<void> {
	const binDir = await mkdtemp(join(tmpdir(), "pi-bro-fake-agy-"));
	const fakeAgyPath = join(binDir, "agy");
	await writeFile(fakeAgyPath, script);
	chmodSync(fakeAgyPath, 0o755);
	process.env.PATH = `${binDir}:${originalPath}`;
	try {
		await run(binDir);
	} finally {
		process.env.PATH = originalPath;
		await rm(binDir, { recursive: true, force: true });
	}
}

test("backend exports public execute and selection helpers", () => {
	assert.equal(typeof execute, "function", "backend must export public execute function");
	assert.equal(typeof agySelection, "function", "backend must export agySelection");

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
		async (binDir) => {
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
		async (binDir) => {
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
		async (binDir) => {
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
sleep 30
touch "$BIN_DIR/still-running-after-kill.txt"
`,
		async (binDir) => {
			process.env.BIN_DIR = binDir;
			const marker = join(binDir, "still-running-after-kill.txt");
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 100);

			const startedAt = Date.now();
			const outcome = await execute(
				{ feature: "advisor", access: "workspace-full", prompt: "Advise", cwd: binDir },
				{ model: "gemini-advisor-model" },
				controller.signal,
				undefined,
				{ killEscalationMs: 200 },
			);

			const elapsed = Date.now() - startedAt;
			assert.equal(outcome.status, "cancelled");
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
