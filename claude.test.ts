import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type BackendProgress, type BackendSelection, CLAUDE_EFFORTS, backendSupports, execute } from "./backend.ts";

const originalPath = process.env.PATH;

// Fake `claude` records argv (one per line), stdin and cwd into $BIN_DIR, then runs `body`.
async function withFakeClaude(body: string, run: (binDir: string) => Promise<void>): Promise<void> {
	const binDir = await mkdtemp(join(tmpdir(), "pi-bro-fake-claude-"));
	const script = `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg"; done > "$BIN_DIR/args.txt"
cat > "$BIN_DIR/stdin.txt"
pwd > "$BIN_DIR/pwd.txt"
${body}
`;
	await writeFile(join(binDir, "claude"), script);
	chmodSync(join(binDir, "claude"), 0o755);
	// A fake agy that only records it ran, so routing mistakes are visible.
	await writeFile(join(binDir, "agy"), `#!/bin/sh\ntouch "$BIN_DIR/agy-ran"\nprintf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"agy answer"}}'\n`);
	chmodSync(join(binDir, "agy"), 0o755);
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
const textDelta = (text: string) => line({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } }, parent_tool_use_id: null });
const thinkingDelta = line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "SECRET REASONING" } }, parent_tool_use_id: null });
const assistant = (content: unknown[]) => line({ type: "assistant", message: { content }, parent_tool_use_id: null });
const success = (result: string) => line({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", terminal_reason: "completed", result });

const claude = (effort?: (typeof CLAUDE_EFFORTS)[number]): BackendSelection => ({
	backend: "claude",
	model: "sonnet",
	...(effort ? { effort } : {}),
});

async function args(binDir: string): Promise<string[]> {
	return (await readFile(join(binDir, "args.txt"), "utf8")).split("\n").slice(0, -1);
}

test("support predicate and effort list", () => {
	assert.deepEqual([...CLAUDE_EFFORTS], ["low", "medium", "high", "xhigh", "max"]);
	for (const feature of ["explain", "show", "btw", "advisor"] as const) assert.equal(backendSupports("agy", feature), true);
	assert.equal(backendSupports("claude", "explain"), true);
	assert.equal(backendSupports("claude", "show"), true);
	assert.equal(backendSupports("claude", "advisor"), true);
	assert.equal(backendSupports("claude", "btw"), true);
});

test("claude explain: restricted fresh argv, stdin prompt, scratch cwd, text-only progress without reasoning", async () => {
	await withFakeClaude(
		[
			thinkingDelta,
			assistant([{ type: "thinking", thinking: "SECRET REASONING" }]),
			textDelta("Hello "),
			textDelta("world"),
			assistant([{ type: "text", text: "Hello world" }]),
			success("Hello world"),
		].join("\n"),
		async (binDir) => {
			const progress: BackendProgress[] = [];
			const outcome = await execute(
				{ feature: "explain", access: "restricted", prompt: "Explain 'this' $HOME" },
				claude("xhigh"),
				new AbortController().signal,
				(p) => progress.push(p),
			);
			assert.deepEqual(outcome, { status: "success", text: "Hello world" });
			assert.deepEqual(progress, [
				{ kind: "text", text: "Hello " },
				{ kind: "text", text: "Hello world" },
			]);
			assert.deepEqual(await args(binDir), [
				"-p",
				"--safe-mode",
				"--no-session-persistence",
				"--disable-slash-commands",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				"--tools",
				"",
				"--strict-mcp-config",
				"--mcp-config",
				'{"mcpServers":{}}',
				"--permission-mode",
				"dontAsk",
				"--model",
				"sonnet",
				"--effort",
				"xhigh",
			]);
			assert.equal(await readFile(join(binDir, "stdin.txt"), "utf8"), "Explain 'this' $HOME");
			const cwd = (await readFile(join(binDir, "pwd.txt"), "utf8")).trim();
			assert.ok(cwd.includes("pi-bro-"), "restricted run uses a scratch directory");
			assert.equal(existsSync(cwd), false, "scratch directory is removed");
			assert.equal(existsSync(join(binDir, "agy-ran")), false);

			await execute({ feature: "show", access: "restricted", prompt: "Show" }, claude(), new AbortController().signal);
			const showArgs = await args(binDir);
			assert.ok(!showArgs.includes("--effort"), "omitted effort omits --effort");
			assert.ok(!showArgs.includes("--bare"), "--bare breaks OAuth and must never be passed");
			assert.ok(!showArgs.includes("--resume") && !showArgs.includes("--continue"));
		},
	);
});

test("claude advisor: workspace-full fresh argv in workspace cwd, activity-only progress without reasoning", async () => {
	await withFakeClaude(
		[
			thinkingDelta,
			textDelta("Looking at the plan"),
			assistant([
				{ type: "thinking", thinking: "SECRET REASONING" },
				{ type: "text", text: "Looking at the plan\nmore" },
				{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
			]),
			success("Advice: ship it"),
		].join("\n"),
		async (binDir) => {
			const progress: BackendProgress[] = [];
			const outcome = await execute(
				{ feature: "advisor", access: "workspace-full", prompt: "Review the plan", cwd: binDir },
				claude(),
				new AbortController().signal,
				(p) => progress.push(p),
			);
			assert.deepEqual(outcome, { status: "success", text: "Advice: ship it" });
			assert.deepEqual(
				progress.map((p) => (p.kind === "activity" ? p.label : `text:${p.text}`)),
				["Looking at the plan", "Read"],
			);
			assert.deepEqual(await args(binDir), [
				"-p",
				"--safe-mode",
				"--no-session-persistence",
				"--disable-slash-commands",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				"--strict-mcp-config",
				"--mcp-config",
				'{"mcpServers":{}}',
				"--dangerously-skip-permissions",
				"--model",
				"sonnet",
			]);
			assert.equal(await readFile(join(binDir, "stdin.txt"), "utf8"), "Review the plan");
			assert.equal(await realpath((await readFile(join(binDir, "pwd.txt"), "utf8")).trim()), await realpath(binDir));
		},
	);
});

test("claude failures: error result after partial, non-success subtype, empty result, missing result, bad exit, invalid json", async () => {
	const cases: Array<{ name: string; body: string; message: RegExp; partial?: string }> = [
		{
			name: "error result after partial",
			body: [textDelta("Halfway"), line({ type: "result", subtype: "success", is_error: true, result: "API Error: overloaded" })].join("\n"),
			message: /Claude failed: API Error: overloaded/,
			partial: "Halfway",
		},
		{
			name: "non-success subtype",
			body: line({ type: "result", subtype: "error_max_turns", is_error: false, result: "x" }),
			message: /Claude failed: error_max_turns/,
		},
		{ name: "empty result", body: success("  "), message: /Claude returned no final answer/ },
		{ name: "missing result", body: textDelta("partial only"), message: /Claude exited without a result event/, partial: "partial only" },
		{ name: "nonzero exit after success", body: `${success("ok")}\necho 'boom' >&2\nexit 3`, message: /Claude could not .*: boom/ },
		{ name: "invalid json", body: `${textDelta("so far")}\necho 'not json'`, message: /Claude emitted invalid stream-json output/, partial: "so far" },
	];
	await withFakeClaude('case "$(cat "$BIN_DIR/stdin.txt")" in\n' + cases.map((c, i) => `  case${i}) ${c.body.replaceAll("\n", "; ")} ;;`).join("\n") + "\nesac", async () => {
		for (const [i, c] of cases.entries()) {
			const outcome = await execute({ feature: "explain", access: "restricted", prompt: `case${i}` }, claude(), new AbortController().signal);
			assert.equal(outcome.status, "failure", c.name);
			if (outcome.status !== "failure") continue;
			assert.match(outcome.message, c.message, c.name);
			assert.match(outcome.message, /\/bro doctor/, c.name);
			assert.equal(outcome.partialText, c.partial, c.name);
		}
	});
});

test("claude cancel after partial and deadline reuse the attempt lifecycle", async () => {
	await withFakeClaude(`${textDelta("Partial")}\ntouch "$BIN_DIR/ready"\nsleep 10`, async (binDir) => {
		const controller = new AbortController();
		const timer = setInterval(() => existsSync(join(binDir, "ready")) && controller.abort(), 10);
		const cancelled = await execute({ feature: "explain", access: "restricted", prompt: "p" }, claude(), controller.signal, undefined, { killEscalationMs: 200 });
		clearInterval(timer);
		assert.deepEqual(cancelled, { status: "cancelled", message: "Canceled.", partialText: "Partial" });
		const cwd = (await readFile(join(binDir, "pwd.txt"), "utf8")).trim();
		assert.equal(existsSync(cwd), false, "scratch directory removed after cancel");

		const timedOut = await execute(
			{ feature: "advisor", access: "workspace-full", prompt: "p", cwd: binDir },
			claude(),
			new AbortController().signal,
			undefined,
			{ deadlineMs: 150, killEscalationMs: 150 },
		);
		assert.equal(timedOut.status, "timeout");
		if (timedOut.status === "timeout") assert.match(timedOut.message, /Claude timed out/);
	});
});

test("claude missing binary reports an install hint", async () => {
	const emptyDir = await mkdtemp(join(tmpdir(), "pi-bro-no-claude-"));
	process.env.PATH = emptyDir;
	try {
		const outcome = await execute({ feature: "explain", access: "restricted", prompt: "p" }, claude(), new AbortController().signal);
		assert.equal(outcome.status, "failure");
		if (outcome.status === "failure") assert.match(outcome.message, /Claude Code could not start\. Make sure `claude` is installed/);
	} finally {
		process.env.PATH = originalPath;
		await rm(emptyDir, { recursive: true, force: true });
	}
});

test("unsupported claude combinations and pre-abort fail before spawn; missing backend routes to Agy", async () => {
	await withFakeClaude(success("should not run"), async (binDir) => {
		const signal = new AbortController().signal;
		const rejected = [
			await execute({ feature: "btw", access: "restricted", prompt: "p" }, claude(), signal),
			await execute({ feature: "btw", access: "restricted", prompt: "p", cwd: "  " }, claude(), signal),
			await execute({ feature: "advisor", access: "restricted", prompt: "p" }, claude(), signal),
			await execute({ feature: "explain", access: "workspace-full", prompt: "p", cwd: binDir }, claude(), signal),
			await execute({ feature: "advisor", access: "workspace-full", prompt: "p" }, claude(), signal),
			await execute({ feature: "explain", access: "restricted", prompt: "p", continuation: { id: "c" } }, claude(), signal),
			await execute({ feature: "explain", access: "restricted", prompt: "p" }, { backend: "claude", model: " " }, signal),
			await execute({ feature: "explain", access: "restricted", prompt: "p" }, { backend: "claude", model: "sonnet", effort: "turbo" as "max" }, signal),
		];
		for (const outcome of rejected) assert.equal(outcome.status, "failure");
		assert.match(rejected[0].status === "failure" ? rejected[0].message : "", /Unsupported execution request/);

		const aborted = new AbortController();
		aborted.abort();
		assert.deepEqual(
			await execute({ feature: "explain", access: "restricted", prompt: "p" }, claude(), aborted.signal),
			{ status: "cancelled", message: "Canceled." },
		);
		assert.equal(existsSync(join(binDir, "args.txt")), false, "claude must never be spawned");

		const viaAgy = await execute({ feature: "explain", access: "restricted", prompt: "p" }, { model: "gemini" }, signal);
		assert.equal(viaAgy.status === "success" && viaAgy.text, "agy answer");
		assert.ok(existsSync(join(binDir, "agy-ran")));
		await rm(join(binDir, "agy-ran"));
		await execute({ feature: "explain", access: "restricted", prompt: "p" }, { backend: "agy", model: "gemini" }, signal);
		assert.ok(existsSync(join(binDir, "agy-ran")));
		assert.equal(existsSync(join(binDir, "args.txt")), false);
	});
});


test("Claude rejects truncated results and ignores nested terminal answers", async () => {
 for (const event of [
  { type: "result", subtype: "success", is_error: false, result: "cut off", stop_reason: "max_tokens" },
  { type: "result", subtype: "success", is_error: false, result: "child only", parent_tool_use_id: "nested" },
 ]) {
  await withFakeClaude(line(event), async () => {
   const outcome = await execute({ feature: "explain", access: "restricted", prompt: "test" }, claude(), new AbortController().signal);
   assert.equal(outcome.status, "failure");
  });
 }
});

const init = (sessionId: string) => line({ type: "system", subtype: "init", session_id: sessionId, parent_tool_use_id: null });
const successIn = (result: string, sessionId: string) =>
	line({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", terminal_reason: "completed", result, session_id: sessionId });
const btwBase = ["-p", "--safe-mode", "--disable-slash-commands", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
const noMcp = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];

async function runClaudeBtw(request: { access: "restricted" | "workspace-full"; continuation?: { id: string } }, onProgress?: (p: BackendProgress) => void) {
	const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-bro-claude-ws-")));
	try {
		const outcome = await execute({ feature: "btw", prompt: "Side q", cwd: workspace, ...request }, claude(), new AbortController().signal, onProgress);
		return { outcome, workspace };
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

test("claude btw conversation-only: persisted session, tool-less, workspace cwd, session continuation", async () => {
	await withFakeClaude([init("sess-1"), textDelta("Ans"), textDelta("wer"), successIn("Answer", "sess-1")].join("\n"), async (binDir) => {
		const progress: BackendProgress[] = [];
		const { outcome, workspace } = await runClaudeBtw({ access: "restricted" }, (p) => progress.push(p));
		assert.deepEqual(outcome, { status: "success", text: "Answer", continuation: { id: "sess-1" } });
		assert.deepEqual(progress, [{ kind: "text", text: "Ans" }, { kind: "text", text: "Answer" }]);
		assert.deepEqual(await args(binDir), [...btwBase, "--tools", "", ...noMcp, "--permission-mode", "dontAsk", "--model", "sonnet"]);
		assert.equal((await readFile(join(binDir, "pwd.txt"), "utf8")).trim(), workspace, "resume needs a stable cwd");
		assert.equal(await readFile(join(binDir, "stdin.txt"), "utf8"), "Side q");
		assert.equal(existsSync(join(binDir, "agy-ran")), false);
	});
});

test("claude btw full permission resumes the same session with workspace tools", async () => {
	await withFakeClaude([init("sess-1"), successIn("Edited", "sess-1")].join("\n"), async (binDir) => {
		const { outcome } = await runClaudeBtw({ access: "workspace-full", continuation: { id: "sess-1" } });
		assert.deepEqual(outcome, { status: "success", text: "Edited", continuation: { id: "sess-1" } });
		assert.deepEqual(await args(binDir), [...btwBase, ...noMcp, "--dangerously-skip-permissions", "--resume", "sess-1", "--model", "sonnet"]);
	});
});

for (const { name, body, continuation } of [
	{ name: "resumed session id mismatch", body: [init("other"), successIn("x", "other")].join("\n"), continuation: { id: "sess-1" } },
	{ name: "init/result session id mismatch", body: [init("s1"), successIn("x", "s2")].join("\n") },
	{ name: "missing session id", body: success("x") },
]) {
	test(`claude btw fails on ${name}`, async () => {
		await withFakeClaude(body, async () => {
			const { outcome } = await runClaudeBtw({ access: "restricted", ...(continuation ? { continuation } : {}) });
			assert.equal(outcome.status, "failure", JSON.stringify(outcome));
			assert.match((outcome as { message: string }).message, /session id[\s\S]*\/bro doctor/);
		});
	});
}

test("claude btw keeps partial text on a failed terminal result and uses side-conversation wording", async () => {
	await withFakeClaude([init("sess-1"), textDelta("half"), line({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "sess-1" })].join("\n"), async () => {
		const { outcome } = await runClaudeBtw({ access: "restricted" });
		assert.equal(outcome.status, "failure");
		assert.equal((outcome as { partialText?: string }).partialText, "half");
	});
	await withFakeClaude("echo 'not signed in' >&2; exit 3", async () => {
		const { outcome } = await runClaudeBtw({ access: "workspace-full" });
		assert.match((outcome as { message: string }).message, /Claude could not answer the side question: not signed in/);
	});
});
