import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type BackendProgress,
	type BackendRequest,
	type BackendSelection,
	CODEX_EFFORTS,
	backendSupports,
	execute,
} from "./backend.ts";

const originalPath = process.env.PATH;

// Fake `codex` records argv (one per line), stdin, and cwd into $BIN_DIR, then runs `body`.
async function withFakeCodex(body: string, run: (binDir: string) => Promise<void>): Promise<void> {
	const binDir = await mkdtemp(join(tmpdir(), "pi-bro-fake-codex-"));
	const script = `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg"; done > "$BIN_DIR/args.txt"
cat > "$BIN_DIR/stdin.txt"
pwd > "$BIN_DIR/pwd.txt"
${body}
`;
	await writeFile(join(binDir, "codex"), script);
	chmodSync(join(binDir, "codex"), 0o755);
	// Fake CLIs that only record they ran, so routing mistakes are visible.
	for (const cli of ["agy", "claude", "grok", "muse"]) {
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

const line = (event: unknown) => `printf '%s\\n' '${JSON.stringify(event)}'`;
const threadStarted = (thread_id = "th-1") => line({ type: "thread.started", thread_id });
const turnStarted = line({ type: "turn.started" });
const agentMsg = (text: string) => line({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
const turnCompleted = line({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } });
const turnFailed = (message = "turn failed") => line({ type: "turn.failed", error: { message } });

const codex = (fields: Partial<{ model: string; effort: (typeof CODEX_EFFORTS)[number] }> = {}): BackendSelection => ({
	backend: "codex",
	model: "gpt-5.5",
	...fields,
});

async function args(binDir: string): Promise<string[]> {
	return (await readFile(join(binDir, "args.txt"), "utf8")).split("\n").slice(0, -1);
}

test("codex support predicate and effort list", () => {
	assert.deepEqual([...CODEX_EFFORTS], ["low", "medium", "high", "xhigh"]);
	for (const feature of ["explain", "show", "btw", "advisor"] as const) assert.equal(backendSupports("codex", feature), true);
});

test("codex explain: restricted fresh argv, stdin prompt, scratch cwd, text-only progress", async () => {
	await withFakeCodex(
		[
			threadStarted("th-exp"),
			turnStarted,
			agentMsg("Hello world from Codex"),
			turnCompleted,
		].join("\n"),
		async (binDir) => {
			const progress: BackendProgress[] = [];
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain 'this' $HOME" },
				codex({ effort: "high" }),
				new AbortController().signal,
				(p) => progress.push(p),
			);
			assert.deepEqual(outcome, { status: "success", text: "Hello world from Codex" });
			assert.deepEqual(progress, [{ kind: "text", text: "Hello world from Codex" }]);
			assert.deepEqual(await args(binDir), [
				"exec",
				"--sandbox",
				"read-only",
				"--json",
				"--skip-git-repo-check",
				"--ephemeral",
				"--model",
				"gpt-5.5",
				"-c",
				'model_reasoning_effort="high"',
				"--",
				"-",
			]);
			assert.equal(await readFile(join(binDir, "stdin.txt"), "utf8"), "Explain 'this' $HOME");
			const cwd = (await readFile(join(binDir, "pwd.txt"), "utf8")).trim();
			assert.ok(cwd.includes("pi-bro-"), "restricted run uses a scratch directory");
			assert.equal(existsSync(cwd), false, "scratch directory is removed");
			assert.equal(existsSync(join(binDir, "agy-ran")), false);

			await execute({ feature: "show", access: "restricted", prompt: "Show" }, codex(), new AbortController().signal);
			const showArgs = await args(binDir);
			assert.ok(!showArgs.includes("-c"), "omitted effort omits -c model_reasoning_effort");
			assert.ok(!showArgs.includes("resume"));
		},
	);
});

test("codex advisor: workspace-full fresh argv in workspace cwd, activity-only progress", async () => {
	await withFakeCodex(
		[
			threadStarted("th-adv"),
			turnStarted,
			line({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "git status" } }),
			line({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "git status", exit_code: 0 } }),
			line({ type: "item.completed", item: { type: "reasoning", text: "Private reasoning" } }),
			line({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "I looked at git status." } }),
			line({ type: "item.started", item: { id: "item_3", type: "file_search", query: "auth" } }),
			line({ type: "item.completed", item: { id: "item_3", type: "file_search", query: "auth" } }),
			line({ type: "item.completed", item: { id: "item_4", type: "agent_message", text: "Final advisor recommendation." } }),
			turnCompleted,
		].join("\n"),
		async (binDir) => {
			const progress: BackendProgress[] = [];
			const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-bro-codex-ws-")));
			try {
				const outcome = await execute(
					{ feature: "advisor", access: "workspace-full", cwd: workspace, prompt: "Advise on project" },
					codex({ model: "gpt-5.4", effort: "low" }),
					new AbortController().signal,
					(p) => progress.push(p),
				);
				assert.deepEqual(outcome, { status: "success", text: "Final advisor recommendation." });
				assert.deepEqual(
					progress.map((p) => (p.kind === "activity" ? p.label : `text:${p.text}`)),
					[
						"command_execution git status",
						"command_execution git status",
						"I looked at git status.",
						"file_search auth",
						"file_search auth",
						"Final advisor recommendation.",
					],
				);
				assert.deepEqual(await args(binDir), [
					"exec",
					"--dangerously-bypass-approvals-and-sandbox",
					"--json",
					"--skip-git-repo-check",
					"--ephemeral",
					"--model",
					"gpt-5.4",
					"-c",
					'model_reasoning_effort="low"',
					"--",
					"-",
				]);
				assert.equal((await readFile(join(binDir, "pwd.txt"), "utf8")).trim(), workspace);
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		},
	);
});

test("codex btw restricted: fresh turn runs in workspace cwd and returns continuation", async () => {
	await withFakeCodex(
		[
			threadStarted("th-btw-1"),
			turnStarted,
			agentMsg("First turn answer"),
			turnCompleted,
		].join("\n"),
		async (binDir) => {
			const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-bro-codex-ws-")));
			try {
				const outcome = await execute(
					{ feature: "btw", access: "restricted", cwd: workspace, prompt: "Turn 1 question" },
					codex(),
					new AbortController().signal,
				);
				assert.deepEqual(outcome, {
					status: "success",
					text: "First turn answer",
					continuation: { id: "th-btw-1" },
				});
				const argv = await args(binDir);
				assert.deepEqual(argv, [
					"exec",
					"--sandbox",
					"read-only",
					"--json",
					"--skip-git-repo-check",
					"--model",
					"gpt-5.5",
					"--",
					"-",
				]);
				assert.ok(!argv.includes("--ephemeral"), "btw turns must not pass --ephemeral so sessions persist");
				assert.equal((await readFile(join(binDir, "pwd.txt"), "utf8")).trim(), workspace);
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		},
	);
});

for (const access of ["restricted", "workspace-full"] as const) {
test(`codex btw ${access}: resume preserves permissions and continuation`, async () => {
	await withFakeCodex(
		[
			threadStarted("th-btw-1"),
			turnStarted,
			agentMsg("Resumed turn answer"),
			turnCompleted,
		].join("\n"),
		async (binDir) => {
			const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-bro-codex-ws-")));
			try {
				const outcome = await execute(
					{
						feature: "btw",
						access,
						cwd: workspace,
						prompt: "Turn 2 question",
						continuation: { id: "th-btw-1" },
					},
					codex({ effort: "medium" }),
					new AbortController().signal,
				);
				assert.deepEqual(outcome, {
					status: "success",
					text: "Resumed turn answer",
					continuation: { id: "th-btw-1" },
				});
				const argv = await args(binDir);
				assert.deepEqual(argv, [
					"exec",
					...(access === "restricted" ? ["--sandbox", "read-only"] : ["--dangerously-bypass-approvals-and-sandbox"]),
					"resume",
					"--json",
					"--skip-git-repo-check",
					"--model",
					"gpt-5.5",
					"-c",
					'model_reasoning_effort="medium"',
					"th-btw-1",
					"-",
				]);
				assert.ok(!argv.includes("--ephemeral"));
				assert.equal((await readFile(join(binDir, "pwd.txt"), "utf8")).trim(), workspace);
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		},
	);
});

}

test("codex btw fails on resumed session id mismatch", async () => {
	await withFakeCodex(
		[
			threadStarted("th-different"),
			turnStarted,
			agentMsg("Mismatch answer"),
			turnCompleted,
		].join("\n"),
		async () => {
			const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-bro-codex-ws-")));
			try {
				const outcome = await execute(
					{
						feature: "btw",
						access: "restricted",
						cwd: workspace,
						prompt: "Turn 2",
						continuation: { id: "th-expected" },
					},
					codex(),
					new AbortController().signal,
				);
				assert.equal(outcome.status, "failure");
				assert.match(outcome.message, /inconsistent session id.*expected th-expected.*th-different/i);
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		},
	);
});

test("codex btw fails on missing session id", async () => {
	await withFakeCodex(
		[
			turnStarted,
			agentMsg("No thread started"),
			turnCompleted,
		].join("\n"),
		async () => {
			const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-bro-codex-ws-")));
			try {
				const outcome = await execute(
					{ feature: "btw", access: "restricted", cwd: workspace, prompt: "Turn" },
					codex(),
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

test("codex failures: turn.failed, top-level error, exit error, missing terminal, invalid json, empty text", async () => {
	// 1. turn.failed keeps partial
	await withFakeCodex(
		[threadStarted(), agentMsg("Partial before failure"), turnFailed("rate limit exceeded")].join("\n"),
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				codex(),
				new AbortController().signal,
			);
			assert.equal(outcome.status, "failure");
			assert.match(outcome.message, /Codex failed: rate limit exceeded/);
			assert.equal(outcome.partialText, "Partial before failure");
		},
	);

	// 2. top-level error event
	await withFakeCodex(
		[line({ type: "error", message: "auth token expired" })].join("\n"),
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				codex(),
				new AbortController().signal,
			);
			assert.equal(outcome.status, "failure");
			assert.match(outcome.message, /Codex error: auth token expired/);
		},
	);

	// 3. nonzero exit code
	await withFakeCodex(
		"printf 'model error\\n' >&2\nexit 1\n",
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				codex(),
				new AbortController().signal,
			);
			assert.equal(outcome.status, "failure");
			assert.match(outcome.message, /Codex could not simplify the response: model error/);
		},
	);

	// 4. missing terminal event
	await withFakeCodex(
		agentMsg("Text but no turn.completed"),
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				codex(),
				new AbortController().signal,
			);
			assert.equal(outcome.status, "failure");
			assert.match(outcome.message, /Codex exited without a terminal result event/);
		},
	);

	// 5. invalid json
	await withFakeCodex(
		"printf 'not-json-line\\n'\n",
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				codex(),
				new AbortController().signal,
			);
			assert.equal(outcome.status, "failure");
			assert.match(outcome.message, /invalid JSON output/);
		},
	);

	// 6. empty text
	await withFakeCodex(
		[threadStarted(), agentMsg("   "), turnCompleted].join("\n"),
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				codex(),
				new AbortController().signal,
			);
			assert.equal(outcome.status, "failure");
			assert.match(outcome.message, /Codex returned no final explanation/);
		},
	);
});

test("codex cancel after partial and deadline reuse the attempt lifecycle", async () => {
	await withFakeCodex(
		[
			threadStarted(),
			agentMsg("Partial before stop"),
			'touch "$BIN_DIR/ready"',
			"sleep 10",
		].join("\n"),
		async (binDir) => {
			const controller = new AbortController();
			const timer = setInterval(() => existsSync(join(binDir, "ready")) && controller.abort(), 10);
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				codex(),
				controller.signal,
				undefined,
				{ killEscalationMs: 200 },
			);
			clearInterval(timer);
			assert.equal(outcome.status, "cancelled");
			assert.equal(outcome.partialText, "Partial before stop");
		},
	);

	await withFakeCodex(
		"sleep 10\n",
		async () => {
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain" },
				codex(),
				new AbortController().signal,
				undefined,
				{ deadlineMs: 50, killEscalationMs: 50 },
			);
			assert.equal(outcome.status, "timeout");
			assert.match(outcome.message, /Codex timed out while simplifying the response/);
		},
	);
});

test("codex missing binary reports an install hint", async () => {
	const emptyDir = await mkdtemp(join(tmpdir(), "pi-bro-no-codex-"));
	process.env.PATH = emptyDir;
	try {
		const outcome = await execute(
			{ feature: "explain", access: "restricted", prompt: "Explain" },
			codex(),
			new AbortController().signal,
		);
		assert.equal(outcome.status, "failure");
		assert.match(outcome.message, /Codex could not start\. Make sure `codex` is installed and on PATH/);
	} finally {
		process.env.PATH = originalPath;
		await rm(emptyDir, { recursive: true, force: true });
	}
});

test("unsupported codex combinations and pre-abort fail before spawn", async () => {
	const aborted = new AbortController();
	aborted.abort();
	assert.deepEqual(
		await execute({ feature: "explain", access: "restricted", prompt: "Explain" }, codex(), aborted.signal),
		{ status: "cancelled", message: "Canceled." },
	);

	assert.deepEqual(
		await execute({ feature: "btw", access: "restricted", prompt: "Missing cwd" }, codex(), new AbortController().signal),
		{ status: "failure", message: "Unsupported execution request: check feature access, workspace cwd and continuation." },
	);

	assert.deepEqual(
		await execute(
			{ feature: "explain", access: "restricted", prompt: "Explain" },
			{ backend: "codex", model: "" },
			new AbortController().signal,
		),
		{ status: "failure", message: "Unsupported Codex selection: check the model and effort (low, medium, high or xhigh)." },
	);
});
