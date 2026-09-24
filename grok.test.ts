import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type BackendProgress, type BackendRequest, type BackendSelection, GROK_EFFORTS, backendSupports, execute } from "./backend.ts";

const originalPath = process.env.PATH;

// Fake `grok` records argv (one per line), cwd, the --prompt-file path, its contents and its
// permission bits into $BIN_DIR, then runs `body`.
async function withFakeGrok(body: string, run: (binDir: string) => Promise<void>): Promise<void> {
	const binDir = await mkdtemp(join(tmpdir(), "pi-bro-fake-grok-"));
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
	await writeFile(join(binDir, "grok"), script);
	chmodSync(join(binDir, "grok"), 0o755);
	// Fake agy/claude that only record they ran, so routing mistakes are visible.
	for (const cli of ["agy", "claude"]) {
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
const top = { parent_tool_use_id: null, session_id: "s1" };
const thinkingDelta = line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "SECRET REASONING" } }, ...top });
const textDelta = (text: string) => line({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } }, ...top });
const assistant = (content: unknown[], parent: string | null = null) => line({ type: "assistant", message: { id: "msg_0", content }, parent_tool_use_id: parent, session_id: "s1" });
const result = (fields: Record<string, unknown>) => line({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", num_turns: 1, session_id: "s1", ...fields });
const success = (text: string) => result({ result: text });

const grok = (fields: Partial<{ model: string; effort: (typeof GROK_EFFORTS)[number] }> = {}): BackendSelection => ({ backend: "grok", model: "grok-4.7", ...fields });

async function args(binDir: string): Promise<string[]> {
	return (await readFile(join(binDir, "args.txt"), "utf8")).split("\n").slice(0, -1);
}

async function advise(selection: BackendSelection, onProgress?: (p: BackendProgress) => void, signal = new AbortController().signal, deadlineMs?: number) {
	const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-bro-grok-ws-")));
	try {
		const outcome = await execute(
			{ feature: "advisor", access: "workspace-full", cwd: workspace, prompt: "Advise on 'this' $HOME" },
			selection,
			signal,
			onProgress,
			{ killEscalationMs: 100, ...(deadlineMs ? { deadlineMs } : {}) },
		);
		return { outcome, workspace };
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

test("grok support predicate and effort list", () => {
	assert.deepEqual([...GROK_EFFORTS], ["low", "medium", "high", "xhigh"]);
	assert.equal(backendSupports("grok", "advisor"), true);
	for (const feature of ["explain", "show", "btw"] as const) assert.equal(backendSupports("grok", feature), false);
});

test("grok advisor: fresh workspace argv, private prompt file cleaned up, activity-only progress without reasoning", async () => {
	await withFakeGrok(
		[
			line({ type: "system", subtype: "init", permissionMode: "bypassPermissions", session_id: "s1", model: "grok-4.7-build-fast" }),
			thinkingDelta,
			textDelta("PARTIAL "),
			assistant([{ type: "thinking", thinking: "SECRET REASONING", signature: "sig" }, { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } }]),
			assistant([{ type: "tool_use", id: "c2", name: "nested_tool", input: {} }], "c9"),
			result({ parent_tool_use_id: "c9", result: "NESTED RESULT", is_error: true, subtype: "error_during_execution" }),
			assistant([{ type: "text", text: "\nFinal advice line\nmore" }]),
			success("Final advice"),
		].join("\n"),
		async (binDir) => {
			const progress: BackendProgress[] = [];
			const { outcome, workspace } = await advise(grok({ model: "grok-4.7-build-fast", effort: "xhigh" }), (p) => progress.push(p));
			assert.deepEqual(outcome, { status: "success", text: "Final advice" });
			assert.deepEqual(
				progress.map((p) => (p.kind === "activity" ? p.label : `text:${p.text}`)),
				["read_file", "Final advice line"],
			);
			assert.doesNotMatch(JSON.stringify(progress), /SECRET|PARTIAL|NESTED|nested_tool/);
			const argv = await args(binDir);
			const promptPath = await readFile(join(binDir, "prompt-path.txt"), "utf8");
			assert.deepEqual(argv, [
				"--sandbox",
				"off",
				"--permission-mode",
				"bypassPermissions",
				"--no-subagents",
				"--disallowed-tools",
				"spawn_subagent,scheduler_create,scheduler_delete,scheduler_list,monitor,workflow",
				"--output-format",
				"streaming-messages-json",
				"--include-partial-messages",
				"--model",
				"grok-4.7-build-fast",
				"--reasoning-effort",
				"xhigh",
				"--prompt-file",
				promptPath,
			]);
			assert.equal((await readFile(join(binDir, "pwd.txt"), "utf8")).trim(), workspace);
			assert.equal(await readFile(join(binDir, "prompt.txt"), "utf8"), "Advise on 'this' $HOME");
			assert.equal((await readFile(join(binDir, "prompt-mode.txt"), "utf8")).trim(), "-rw-------");
			assert.ok(!promptPath.startsWith(workspace), "prompt file must not live in the workspace");
			assert.equal(existsSync(promptPath), false, "prompt file must be removed");
			assert.equal(existsSync(join(promptPath, "..")), false, "prompt directory must be removed");
		},
	);
});

test("grok advisor: selected model is explicit and default effort is omitted", async () => {
	await withFakeGrok(success("ok"), async (binDir) => {
		const { outcome } = await advise(grok());
		assert.deepEqual(outcome, { status: "success", text: "ok" });
		const argv = await args(binDir);
		assert.equal(argv[argv.indexOf("--model") + 1], "grok-4.7");
		assert.equal(argv.includes("--reasoning-effort"), false);
	});
});

test("grok rejects unsupported features, invalid selections and unknown backends before any spawn", async () => {
	await withFakeGrok(`touch "$BIN_DIR/grok-ran"\n${success("no")}`, async (binDir) => {
		const signal = new AbortController().signal;
		const restricted: BackendRequest[] = [
			{ feature: "explain", access: "restricted", prompt: "p" },
			{ feature: "show", access: "restricted", prompt: "p" },
			{ feature: "btw", access: "restricted", prompt: "p" },
			{ feature: "btw", access: "workspace-full", cwd: binDir, prompt: "p" },
		];
		for (const request of restricted) {
			const outcome = await execute(request, grok(), signal);
			assert.equal(outcome.status, "failure");
			assert.match((outcome as { message: string }).message, /Grok only supports the advisor/);
		}
		const advisor: BackendRequest = { feature: "advisor", access: "workspace-full", cwd: binDir, prompt: "p" };
		for (const selection of [grok({ effort: "max" as never }), grok({ effort: "minimal" as never }), grok({ model: "  " }), grok({ model: undefined })]) {
			const outcome = await execute(advisor, selection, signal);
			assert.equal(outcome.status, "failure");
			assert.match((outcome as { message: string }).message, /Unsupported Grok selection/);
		}
		const unknown = await execute(advisor, { backend: "bogus", model: "m" } as unknown as BackendSelection, signal);
		assert.equal(unknown.status, "failure");
		assert.match((unknown as { message: string }).message, /Unknown backend/);
		const unknownExplain = await execute({ feature: "explain", access: "restricted", prompt: "p" }, { backend: "bogus", model: "m" } as unknown as BackendSelection, signal);
		assert.equal(unknownExplain.status, "failure");
		for (const cli of ["grok", "agy", "claude"]) assert.equal(existsSync(join(binDir, `${cli}-ran`)), false, `${cli} must not run`);
	});
});

const failures: Array<{ name: string; body: string; message: RegExp }> = [
	{ name: "permission downgrade", body: `printf '%s\\n' '{"type":"system","subtype":"init","permissionMode":"default"}'\n${success("no")}`, message: /bypassPermissions/ },
	{ name: "missing terminal result", body: assistant([{ type: "text", text: "hi" }]), message: /without a terminal result/ },
	{ name: "nested-only result", body: result({ parent_tool_use_id: "c1", result: "nested" }), message: /without a terminal result/ },
	{ name: "non end_turn stop", body: result({ stop_reason: "max_tokens", result: "cut" }), message: /stop reason: max_tokens/ },
	{ name: "missing stop reason", body: result({ stop_reason: undefined, result: "x" }), message: /stop reason: undefined/ },
	{ name: "is_error true", body: result({ is_error: true, result: "x" }), message: /Grok failed/ },
	{
		name: "error subtype with errors[] details",
		body: result({ subtype: "error_during_execution", is_error: true, errors: ["rate limited", "second"], stop_reason: undefined }),
		message: /Grok failed: rate limited/,
	},
	{ name: "top-level error event", body: line({ type: "error", message: "Could not start session: boom" }), message: /Grok error: Could not start session: boom/ },
	{ name: "error after success", body: [success("good"), line({ type: "error", message: "late failure" })].join("\n"), message: /late failure/ },
	{ name: "failed result after success", body: [success("good"), result({ subtype: "error_max_turns", is_error: true })].join("\n"), message: /error_max_turns/ },
	{ name: "nonzero exit after success", body: `${success("good")}\necho 'crashed hard' >&2\nexit 3`, message: /Grok could not complete the advisor consultation: crashed hard/ },
	{ name: "empty final text", body: success("   "), message: /Grok returned no advice/ },
	{ name: "invalid json", body: "echo 'not json'", message: /invalid streaming-messages-json/ },
];

for (const { name, body, message } of failures) {
	test(`grok advisor fails on ${name}`, async () => {
		await withFakeGrok(body, async (binDir) => {
			const { outcome } = await advise(grok());
			assert.equal(outcome.status, "failure", JSON.stringify(outcome));
			assert.match((outcome as { message: string }).message, message);
			assert.match((outcome as { message: string }).message, /\/bro doctor/);
			assert.equal(existsSync(await readFile(join(binDir, "prompt-path.txt"), "utf8")), false);
		});
	});
}

test("grok advisor: cancellation stops the process and cleans the prompt file", async () => {
	await withFakeGrok(`${assistant([{ type: "tool_use", name: "grep" }])}\nexec sleep 30`, async (binDir) => {
		const controller = new AbortController();
		const started = Date.now();
		const { outcome } = await advise(grok(), (p) => {
			if (p.kind === "activity") controller.abort();
		}, controller.signal);
		assert.deepEqual(outcome, { status: "cancelled", message: "Canceled." });
		assert.ok(Date.now() - started < 10_000);
		assert.equal(existsSync(await readFile(join(binDir, "prompt-path.txt"), "utf8")), false);
	});
});

test("grok advisor: pre-aborted request never spawns", async () => {
	await withFakeGrok(`touch "$BIN_DIR/grok-ran"`, async (binDir) => {
		const controller = new AbortController();
		controller.abort();
		const { outcome } = await advise(grok(), undefined, controller.signal);
		assert.deepEqual(outcome, { status: "cancelled", message: "Canceled." });
		assert.equal(existsSync(join(binDir, "grok-ran")), false);
	});
});

test("grok advisor: deadline times out and cleans the prompt file", async () => {
	await withFakeGrok("exec sleep 30", async (binDir) => {
		const { outcome } = await advise(grok(), undefined, new AbortController().signal, 1_500);
		assert.equal(outcome.status, "timeout");
		assert.match((outcome as { message: string }).message, /Grok timed out during the advisor consultation/);
		assert.equal(existsSync(await readFile(join(binDir, "prompt-path.txt"), "utf8")), false);
	});
});

test("grok advisor: missing CLI gives an ENOENT install diagnostic", async () => {
	const emptyBin = await mkdtemp(join(tmpdir(), "pi-bro-no-grok-"));
	process.env.PATH = emptyBin;
	try {
		const { outcome } = await advise(grok());
		assert.equal(outcome.status, "failure");
		assert.match((outcome as { message: string }).message, /Grok could not start\. Make sure `grok` is installed and on PATH/);
	} finally {
		process.env.PATH = originalPath;
		await rm(emptyBin, { recursive: true, force: true });
	}
});
