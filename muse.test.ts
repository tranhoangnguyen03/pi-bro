import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type BackendProgress,
	type BackendSelection,
	MUSE_EFFORTS,
	backendSupports,
	execute,
} from "./backend.ts";

const originalPath = process.env.PATH;

// Fake `muse` records argv (one per line), pwd, and prompt-file contents/mode into $BIN_DIR,
// then runs `body`.
async function withFakeMuse(body: string, run: (binDir: string) => Promise<void>): Promise<void> {
	const binDir = await mkdtemp(join(tmpdir(), "pi-bro-fake-muse-"));
	const script = `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg"; done > "$BIN_DIR/args.txt"
pwd > "$BIN_DIR/pwd.txt"
prev=""
for arg in "$@"; do
	if [ "$prev" = "--prompt-file" ]; then
		printf '%s' "$arg" > "$BIN_DIR/prompt-path.txt"
		cat "$arg" > "$BIN_DIR/prompt.txt"
		ls -l "$arg" | cut -c1-10 > "$BIN_DIR/prompt-mode.txt"
	fi
	prev="$arg"
done
${body}
`;
	await writeFile(join(binDir, "muse"), script);
	chmodSync(join(binDir, "muse"), 0o755);
	// Fake CLIs that only record they ran, so routing mistakes are visible.
	for (const cli of ["agy", "claude", "grok", "codex"]) {
		await writeFile(join(binDir, cli), `#!/bin/sh\ntouch "$BIN_DIR/${cli}-ran"\nexit 1\n`);
		chmodSync(join(binDir, cli), 0o755);
	}
	process.env.PATH = `${binDir}:${originalPath}`;
	process.env.BIN_DIR = binDir;
	try {
		await run(binDir);
	} finally {
		process.env.PATH = originalPath;
		delete process.env.BIN_DIR;
		await rm(binDir, { recursive: true, force: true });
	}
}

const line = (envelope: unknown) => `printf '%s\\n' '${JSON.stringify(envelope)}'`;
const cmdAccepted = (cmdId = "cmd-1", sessId = "sess-1") =>
	line({
		payload_type: "runtime.command.accepted",
		stream: { kind: "session", id: sessId },
		payload: { command_id: cmdId },
	});
const runLinked = (cmdId = "cmd-1", runId = "run-1", sessId = "sess-1") =>
	line({
		payload_type: "session.run.linked",
		stream: { kind: "session", id: sessId },
		payload: { command_id: cmdId, run_stream: { kind: "run", id: runId } },
	});
const outputDelta = (text: string, runId = "run-1") =>
	line({
		payload_type: "run.output.delta",
		payload: { text, run_stream: { kind: "run", id: runId } },
	});
const termCompleted = (text: string, runId = "run-1") =>
	line({
		payload_type: "run.terminal.completed",
		payload: { terminal: "completed", text, run_stream: { kind: "run", id: runId } },
	});
const termFailed = (reason = "failed to complete", runId = "run-1") =>
	line({
		payload_type: "run.terminal.failed",
		payload: { reason, run_stream: { kind: "run", id: runId } },
	});

const muse = (fields: Partial<{ model: string; effort: (typeof MUSE_EFFORTS)[number] }> = {}): BackendSelection => ({
	backend: "muse",
	model: "muse-spark-1.3",
	...fields,
});

async function args(binDir: string): Promise<string[]> {
	return (await readFile(join(binDir, "args.txt"), "utf8")).split("\n").slice(0, -1);
}

test("muse support predicate and effort list", () => {
	assert.deepEqual([...MUSE_EFFORTS], ["minimal", "low", "medium", "high", "xhigh", "max"]);
	for (const feature of ["explain", "show", "btw", "advisor"] as const) assert.equal(backendSupports("muse", feature), true);
});

test("muse explain: restricted fresh argv, prompt file mode 0600, scratch cwd, text-only progress", async () => {
	await withFakeMuse(
		[
			cmdAccepted("c1", "s1"),
			runLinked("c1", "r1", "s1"),
			outputDelta("Hello ", "r1"),
			outputDelta("world from Muse", "r1"),
			termCompleted("Hello world from Muse", "r1"),
		].join("\n"),
		async (binDir) => {
			const progress: BackendProgress[] = [];
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain 'this' code" },
				muse({ effort: "medium" }),
				new AbortController().signal,
				(p) => progress.push(p),
			);
			assert.deepEqual(outcome, { status: "success", text: "Hello world from Muse" });
			assert.deepEqual(progress, [
				{ kind: "text", text: "Hello " },
				{ kind: "text", text: "Hello world from Muse" },
			]);
			const argv = await args(binDir);
			const promptPath = await readFile(join(binDir, "prompt-path.txt"), "utf8");
			const workspace = (await readFile(join(binDir, "pwd.txt"), "utf8")).trim();
			assert.equal(argv[0], "exec");
			assert.equal(argv[1], "--json");
			assert.equal(argv[2], "--provider");
			assert.equal(argv[3], "meta");
			assert.equal(argv[4], "--workspace");
			assert.ok(argv[5].includes("pi-bro-"), "--workspace is a scratch directory");
			assert.deepEqual(argv.slice(6), [
				"--no-session-log",
				"--disable-approval",
				"--disable-write",
				"--disable-shell",
				"--model",
				"muse-spark-1.3",
				"--reasoning-effort",
				"medium",
				"--prompt-file",
				promptPath,
			]);
			assert.equal(await readFile(join(binDir, "prompt.txt"), "utf8"), "Explain 'this' code");
			const promptMode = (await readFile(join(binDir, "prompt-mode.txt"), "utf8")).trim();
			assert.match(promptMode, /-rw-------/, "prompt file must be mode 0600");
			assert.equal(existsSync(promptPath), false, "prompt file cleaned up");
			assert.ok(workspace.includes("pi-bro-"), "restricted run uses a scratch directory");
			assert.equal(existsSync(workspace), false, "scratch directory is removed");

			await execute({ feature: "show", access: "restricted", prompt: "Show" }, muse(), new AbortController().signal);
			const showArgs = await args(binDir);
			assert.ok(!showArgs.includes("--reasoning-effort"), "omitted effort omits --reasoning-effort");
			assert.ok(!showArgs.includes("--session-id"));
		},
	);
});

test("muse advisor: workspace-full fresh argv in workspace cwd, activity progress", async () => {
	await withFakeMuse(
		[
			cmdAccepted("c-adv", "s-adv"),
			runLinked("c-adv", "r-adv", "s-adv"),
			line({
				payload_type: "task.lifecycle.status",
				payload: { event: { message: "reading repo files" }, run_stream: { kind: "run", id: "r-adv" } },
			}),
			line({
				payload_type: "tool.result",
				payload: {
					correlation_facts: { tool_name: "read_file" },
					path: "package.json",
					run_stream: { kind: "run", id: "r-adv" },
				},
			}),
			termCompleted("Advisory recommendations", "r-adv"),
		].join("\n"),
		async (binDir) => {
			const progress: BackendProgress[] = [];
			const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-bro-muse-ws-")));
			try {
				const outcome = await execute(
					{ feature: "advisor", access: "workspace-full", cwd: workspace, prompt: "Advise on project" },
					muse({ model: "muse-spark-1.3-contributor", effort: "high" }),
					new AbortController().signal,
					(p) => progress.push(p),
				);
				assert.deepEqual(outcome, { status: "success", text: "Advisory recommendations" });
				assert.deepEqual(
					progress.map((p) => (p.kind === "activity" ? p.label : `text:${p.text}`)),
					["reading repo files", "read_file package.json"],
				);
				const argv = await args(binDir);
				const promptPath = await readFile(join(binDir, "prompt-path.txt"), "utf8");
				assert.deepEqual(argv, [
					"exec",
					"--json",
					"--provider",
					"meta",
					"--workspace",
					workspace,
					"--no-session-log",
					"--yolo",
					"--model",
					"muse-spark-1.3-contributor",
					"--reasoning-effort",
					"high",
					"--prompt-file",
					promptPath,
				]);
				assert.equal((await readFile(join(binDir, "pwd.txt"), "utf8")).trim(), workspace);
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		},
	);
});

test("muse root vs nested run isolation: ignores nested task lifecycle and output", async () => {
	await withFakeMuse(
		[
			cmdAccepted("c-root", "s-root"),
			outputDelta("NESTED BEFORE LINK", "r-nested"),
			termCompleted("NESTED BEFORE LINK", "r-nested"),
			runLinked("c-root", "r-root", "s-root"),
			// Nested task / subagent run
			line({
				payload_type: "session.run.linked",
				payload: { command_id: "c-nested", run_stream: { kind: "run", id: "r-nested" } },
			}),
			outputDelta("NESTED SECRET", "r-nested"),
			termCompleted("NESTED EARLY DONE", "r-nested"),
			// Root run continues
			outputDelta("Root answer delta", "r-root"),
			termCompleted("Root final answer", "r-root"),
		].join("\n"),
		async () => {
			const progress: BackendProgress[] = [];
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				muse(),
				new AbortController().signal,
				(p) => progress.push(p),
			);
			assert.deepEqual(outcome, { status: "success", text: "Root final answer" });
			assert.deepEqual(progress, [{ kind: "text", text: "Root answer delta" }]);
			assert.doesNotMatch(JSON.stringify(progress), /NESTED/);
		},
	);
});

test("muse btw restricted: fresh turn runs in workspace cwd and returns continuation", async () => {
	await withFakeMuse(
		[
			cmdAccepted("c-btw", "s-btw-1"),
			runLinked("c-btw", "r-btw", "s-btw-1"),
			outputDelta("First turn answer", "r-btw"),
			termCompleted("First turn answer", "r-btw"),
		].join("\n"),
		async (binDir) => {
			const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-bro-muse-ws-")));
			try {
				const outcome = await execute(
					{ feature: "btw", access: "restricted", cwd: workspace, prompt: "Turn 1" },
					muse(),
					new AbortController().signal,
				);
				assert.deepEqual(outcome, {
					status: "success",
					text: "First turn answer",
					continuation: { id: "s-btw-1" },
				});
				const argv = await args(binDir);
				const promptPath = await readFile(join(binDir, "prompt-path.txt"), "utf8");
				assert.deepEqual(argv, [
					"exec",
					"--json",
					"--provider",
					"meta",
					"--workspace",
					workspace,
					"--disable-approval",
					"--disable-write",
					"--disable-shell",
					"--model",
					"muse-spark-1.3",
					"--prompt-file",
					promptPath,
				]);
				assert.ok(!argv.includes("--no-session-log"), "btw turns must not pass --no-session-log so sessions persist");
				assert.equal((await readFile(join(binDir, "pwd.txt"), "utf8")).trim(), workspace);
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		},
	);
});

for (const access of ["restricted", "workspace-full"] as const) {
test(`muse btw ${access}: resume preserves permissions and continuation`, async () => {
	await withFakeMuse(
		[
			cmdAccepted("c-btw-2", "s-btw-1"),
			runLinked("c-btw-2", "r-btw-2", "s-btw-1"),
			outputDelta("Resumed turn answer", "r-btw-2"),
			termCompleted("Resumed turn answer", "r-btw-2"),
		].join("\n"),
		async (binDir) => {
			const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-bro-muse-ws-")));
			try {
				const outcome = await execute(
					{
						feature: "btw",
						access,
						cwd: workspace,
						prompt: "Turn 2",
						continuation: { id: "s-btw-1" },
					},
					muse({ effort: "xhigh" }),
					new AbortController().signal,
				);
				assert.deepEqual(outcome, {
					status: "success",
					text: "Resumed turn answer",
					continuation: { id: "s-btw-1" },
				});
				const argv = await args(binDir);
				const promptPath = await readFile(join(binDir, "prompt-path.txt"), "utf8");
				assert.deepEqual(argv, [
					"exec",
					"--json",
					"--provider",
					"meta",
					"--workspace",
					workspace,
					...(access === "restricted" ? ["--disable-approval", "--disable-write", "--disable-shell"] : ["--yolo"]),
					"--session-id",
					"s-btw-1",
					"--model",
					"muse-spark-1.3",
					"--reasoning-effort",
					"xhigh",
					"--prompt-file",
					promptPath,
				]);
				assert.ok(!argv.includes("--no-session-log"));
				assert.equal((await readFile(join(binDir, "pwd.txt"), "utf8")).trim(), workspace);
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		},
	);
});

}

test("muse btw fails on resumed session id mismatch", async () => {
	await withFakeMuse(
		[
			cmdAccepted("c-diff", "s-different"),
			runLinked("c-diff", "r-diff", "s-different"),
			termCompleted("Answer", "r-diff"),
		].join("\n"),
		async () => {
			const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-bro-muse-ws-")));
			try {
				const outcome = await execute(
					{
						feature: "btw",
						access: "restricted",
						cwd: workspace,
						prompt: "Turn 2",
						continuation: { id: "s-expected" },
					},
					muse(),
					new AbortController().signal,
				);
				assert.equal(outcome.status, "failure");
				assert.match(outcome.message, /inconsistent session id.*expected s-expected.*s-different/i);
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		},
	);
});

test("muse btw fails on missing session id", async () => {
	await withFakeMuse(
		[
			line({
				payload_type: "session.run.linked",
				payload: { run_stream: { kind: "run", id: "r-no-session" } },
			}),
			termCompleted("Answer with no session stream", "r-no-session"),
		].join("\n"),
		async () => {
			const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-bro-muse-ws-")));
			try {
				const outcome = await execute(
					{ feature: "btw", access: "restricted", cwd: workspace, prompt: "Turn" },
					muse(),
					new AbortController().signal,
				);
				assert.equal(outcome.status, "failure");
				assert.match(outcome.message, /inconsistent session id/i);
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		},
	);
});

test("muse failures: run.terminal.failed, exit error, missing terminal, invalid json, empty text", async () => {
	// 1. run.terminal.failed keeps partial
	await withFakeMuse(
		[
			cmdAccepted("c1", "s1"),
			runLinked("c1", "r1", "s1"),
			outputDelta("Partial before failure", "r1"),
			termFailed("model quota exceeded", "r1"),
		].join("\n"),
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				muse(),
				new AbortController().signal,
			);
			assert.equal(outcome.status, "failure");
			assert.match(outcome.message, /Muse failed: model quota exceeded/);
			assert.equal(outcome.partialText, "Partial before failure");
		},
	);

	// 2. nonzero exit code
	await withFakeMuse(
		"printf 'muse crash\\n' >&2\nexit 1\n",
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				muse(),
				new AbortController().signal,
			);
			assert.equal(outcome.status, "failure");
			assert.match(outcome.message, /Muse could not simplify the response: muse crash/);
		},
	);

	// 3. missing terminal event
	await withFakeMuse(
		[cmdAccepted("c1", "s1"), runLinked("c1", "r1", "s1"), outputDelta("Delta only", "r1")].join("\n"),
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				muse(),
				new AbortController().signal,
			);
			assert.equal(outcome.status, "failure");
			assert.match(outcome.message, /Muse exited without a terminal result event/);
		},
	);

	// 4. invalid json
	await withFakeMuse(
		"printf 'not-json-line\\n'\n",
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				muse(),
				new AbortController().signal,
			);
			assert.equal(outcome.status, "failure");
			assert.match(outcome.message, /invalid JSON output/);
		},
	);

	// 5. empty text
	await withFakeMuse(
		[cmdAccepted("c1", "s1"), runLinked("c1", "r1", "s1"), termCompleted("   ", "r1")].join("\n"),
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				muse(),
				new AbortController().signal,
			);
			assert.equal(outcome.status, "failure");
			assert.match(outcome.message, /Muse returned no final explanation/);
		},
	);
});

test("muse cancel after partial and deadline reuse attempt lifecycle", async () => {
	await withFakeMuse(
		[
			cmdAccepted("c1", "s1"),
			runLinked("c1", "r1", "s1"),
			outputDelta("Partial before stop", "r1"),
			'touch "$BIN_DIR/ready"',
			"sleep 10",
		].join("\n"),
		async (binDir) => {
			const controller = new AbortController();
			const timer = setInterval(() => existsSync(join(binDir, "ready")) && controller.abort(), 10);
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				muse(),
				controller.signal,
				undefined,
				{ killEscalationMs: 200 },
			);
			clearInterval(timer);
			assert.equal(outcome.status, "cancelled");
			assert.equal(outcome.partialText, "Partial before stop");
		},
	);

	await withFakeMuse(
		"sleep 10\n",
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				muse(),
				new AbortController().signal,
				undefined,
				{ deadlineMs: 50, killEscalationMs: 50 },
			);
			assert.equal(outcome.status, "timeout");
			assert.match(outcome.message, /Muse timed out while simplifying the response/);
		},
	);
});

test("muse missing binary reports an install hint", async () => {
	const emptyDir = await mkdtemp(join(tmpdir(), "pi-bro-no-muse-"));
	process.env.PATH = emptyDir;
	try {
		const outcome = await execute(
			{ feature: "explain", access: "restricted", prompt: "Explain" },
			muse(),
			new AbortController().signal,
		);
		assert.equal(outcome.status, "failure");
		assert.match(outcome.message, /Muse could not start\. Make sure `muse` is installed and on PATH/);
	} finally {
		process.env.PATH = originalPath;
		await rm(emptyDir, { recursive: true, force: true });
	}
});

test("unsupported muse combinations and pre-abort fail before spawn", async () => {
	const aborted = new AbortController();
	aborted.abort();
	assert.deepEqual(
		await execute({ feature: "explain", access: "restricted", prompt: "Explain" }, muse(), aborted.signal),
		{ status: "cancelled", message: "Canceled." },
	);

	assert.deepEqual(
		await execute({ feature: "btw", access: "restricted", prompt: "Missing cwd" }, muse(), new AbortController().signal),
		{ status: "failure", message: "Unsupported execution request: check feature access, workspace cwd and continuation." },
	);

	assert.deepEqual(
		await execute(
			{ feature: "explain", access: "restricted", prompt: "Explain" },
			{ backend: "muse", model: "" },
			new AbortController().signal,
		),
		{ status: "failure", message: "Unsupported Muse selection: check the model and effort (minimal, low, medium, high, xhigh or max)." },
	);

	assert.deepEqual(
		await execute(
			{ feature: "explain", access: "restricted", prompt: "Explain" },
			// @ts-expect-error verifying invalid effort runtime guard
			{ backend: "muse", model: "muse-spark-1.3", effort: "none" },
			new AbortController().signal,
		),
		{ status: "failure", message: "Unsupported Muse selection: check the model and effort (minimal, low, medium, high, xhigh or max)." },
	);
});
