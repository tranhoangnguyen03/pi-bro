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
	for (const feature of ["explain", "show", "btw", "advisor"] as const) assert.equal(backendSupports("grok", feature), true);
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
			assert.equal(await readFile(join(binDir, "prompt.txt"), "utf8"), "Advise on 'this' $HOME", "advisor prompt gets no restricted prefix");
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

test("grok rejects cwd-less btw, invalid selections and unknown backends before any spawn", async () => {
	await withFakeGrok(`touch "$BIN_DIR/grok-ran"\n${success("no")}`, async (binDir) => {
		const signal = new AbortController().signal;
		for (const request of [
			{ feature: "btw", access: "restricted", prompt: "p" },
			{ feature: "btw", access: "restricted", cwd: "  ", prompt: "p" },
			{ feature: "btw", access: "workspace-full", prompt: "p" },
		] as BackendRequest[]) {
			const outcome = await execute(request, grok(), signal);
			assert.equal(outcome.status, "failure");
			assert.match((outcome as { message: string }).message, /workspace cwd/);
		}
		const requests: BackendRequest[] = [
			{ feature: "advisor", access: "workspace-full", cwd: binDir, prompt: "p" },
			{ feature: "explain", access: "restricted", prompt: "p" },
			{ feature: "btw", access: "restricted", cwd: binDir, prompt: "p" },
		];
		for (const request of requests) {
			for (const selection of [grok({ effort: "max" as never }), grok({ effort: "minimal" as never }), grok({ model: "  " }), grok({ model: undefined })]) {
				const outcome = await execute(request, selection, signal);
				assert.equal(outcome.status, "failure");
				assert.match((outcome as { message: string }).message, /Unsupported Grok selection/);
			}
		}
		const unknown = await execute(requests[0], { backend: "bogus", model: "m" } as unknown as BackendSelection, signal);
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

const init = (sessionId = "s1") => line({ type: "system", subtype: "init", permissionMode: "bypassPermissions", session_id: sessionId, parent_tool_use_id: null });
const baseArgv = ["--sandbox", "off", "--permission-mode", "bypassPermissions", "--output-format", "streaming-messages-json", "--include-partial-messages", "--model", "grok-4.7"];

async function run(request: Omit<BackendRequest, "cwd"> & { cwd?: string | "workspace" }, onProgress?: (p: BackendProgress) => void, signal = new AbortController().signal, deadlineMs?: number) {
	const workspace = await realpath(await mkdtemp(join(tmpdir(), "pi-bro-grok-ws-")));
	try {
		const outcome = await execute(
			{ ...request, cwd: request.cwd === "workspace" ? workspace : request.cwd } as BackendRequest,
			grok(),
			signal,
			onProgress,
			{ killEscalationMs: 100, ...(deadlineMs ? { deadlineMs } : {}) },
		);
		return { outcome, workspace };
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

const texts = (progress: BackendProgress[]) => progress.map((p) => (p.kind === "text" ? p.text : `activity:${p.label}`));

for (const feature of ["explain", "show"] as const) {
	test(`grok ${feature}: restricted prompt request, all features on, removed scratch cwd, text progress without reasoning`, async () => {
		await withFakeGrok(
			[init(), thinkingDelta, textDelta("Hello "), textDelta("world"), assistant([{ type: "thinking", thinking: "SECRET REASONING" }, { type: "text", text: "Hello world" }]), success("Hello world")].join("\n"),
			async (binDir) => {
				const progress: BackendProgress[] = [];
				const { outcome, workspace } = await run({ feature, access: "restricted", prompt: "Explain 'x' $HOME" }, (p) => progress.push(p));
				assert.deepEqual(outcome, { status: "success", text: "Hello world" });
				assert.deepEqual(texts(progress), ["Hello ", "Hello world"], "assistant text must not double-append streamed deltas");
				assert.doesNotMatch(JSON.stringify(progress), /SECRET/);
				const argv = await args(binDir);
				assert.deepEqual(argv, [...baseArgv, "--prompt-file", await readFile(join(binDir, "prompt-path.txt"), "utf8")]);
				for (const flag of ["--no-subagents", "--disallowed-tools", "--disable-web-search", "--tools", "--resume"]) assert.equal(argv.includes(flag), false, flag);
				const prompt = await readFile(join(binDir, "prompt.txt"), "utf8");
				assert.match(prompt, /^Bro restricted mode/);
				assert.match(prompt, /not a technical restriction/);
				assert.match(prompt, /Do not inspect, read, or write workspace files/);
				assert.ok(prompt.endsWith("\n\nExplain 'x' $HOME"));
				const cwd = (await readFile(join(binDir, "pwd.txt"), "utf8")).trim();
				assert.notEqual(cwd, workspace);
				assert.equal(existsSync(cwd), false, "scratch cwd must be removed");
				assert.ok(!(await readFile(join(binDir, "prompt-path.txt"), "utf8")).startsWith(cwd), "prompt file must not live in the scratch cwd");
			},
		);
	});
}

test("grok explain: assistant text is the progress fallback when no deltas stream, nested frames ignored", async () => {
	await withFakeGrok(
		[
			init(),
			assistant([{ type: "text", text: "Part one. " }]),
			assistant([{ type: "text", text: "NESTED" }], "c1"),
			line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "NESTED DELTA" } }, parent_tool_use_id: "c1", session_id: "s1" }),
			assistant([{ type: "tool_use", name: "read_file" }, { type: "text", text: "Part two." }]),
			success("Part one. Part two."),
		].join("\n"),
		async () => {
			const progress: BackendProgress[] = [];
			const { outcome } = await run({ feature: "explain", access: "restricted", prompt: "p" }, (p) => progress.push(p));
			assert.deepEqual(outcome, { status: "success", text: "Part one. Part two." });
			assert.deepEqual(texts(progress), ["Part one. ", "Part one. Part two."]);
		},
	);
});

for (const access of ["restricted", "workspace-full"] as const) {
	test(`grok btw ${access}: fresh turn runs in the workspace cwd and returns the session continuation`, async () => {
		await withFakeGrok([init("sess-1"), textDelta("Answer"), line({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "Answer", session_id: "sess-1" })].join("\n"), async (binDir) => {
			const progress: BackendProgress[] = [];
			const { outcome, workspace } = await run({ feature: "btw", access, cwd: "workspace", prompt: "Side q" }, (p) => progress.push(p));
			assert.deepEqual(outcome, { status: "success", text: "Answer", continuation: { id: "sess-1" } });
			assert.deepEqual(texts(progress), ["Answer"]);
			assert.equal((await readFile(join(binDir, "pwd.txt"), "utf8")).trim(), workspace);
			const argv = await args(binDir);
			assert.deepEqual(argv, [...baseArgv, "--prompt-file", await readFile(join(binDir, "prompt-path.txt"), "utf8")]);
			const prompt = await readFile(join(binDir, "prompt.txt"), "utf8");
			if (access === "restricted") assert.match(prompt, /^Bro restricted mode[\s\S]*\n\nSide q$/);
			else assert.equal(prompt, "Side q");
		});
	});
}

test("grok btw: resume passes --resume with the continuation id and keeps it", async () => {
	await withFakeGrok([init("sess-1"), success("again").replace('"s1"', '"sess-1"')].join("\n"), async (binDir) => {
		const { outcome } = await run({ feature: "btw", access: "restricted", cwd: "workspace", prompt: "Follow up", continuation: { id: "sess-1" } });
		assert.deepEqual(outcome, { status: "success", text: "again", continuation: { id: "sess-1" } });
		const argv = await args(binDir);
		assert.deepEqual(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2), ["--resume", "sess-1"]);
		assert.match(await readFile(join(binDir, "prompt.txt"), "utf8"), /^Bro restricted mode[\s\S]*Follow up$/);
	});
});

const sessionFailures: Array<{ name: string; body: string; continuation?: { id: string }; message: RegExp }> = [
	{ name: "resumed session id mismatch", body: [init("other"), success("x").replace('"s1"', '"other"')].join("\n"), continuation: { id: "sess-1" }, message: /session id/ },
	{ name: "init/result session id mismatch", body: [init("s1"), success("x").replace('"s1"', '"s2"')].join("\n"), message: /session id/ },
	{ name: "missing session id", body: line({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "x" }), message: /session id/ },
];

for (const { name, body, continuation, message } of sessionFailures) {
	test(`grok btw fails on ${name}`, async () => {
		await withFakeGrok(body, async () => {
			const { outcome } = await run({ feature: "btw", access: "workspace-full", cwd: "workspace", prompt: "p", ...(continuation ? { continuation } : {}) });
			assert.equal(outcome.status, "failure", JSON.stringify(outcome));
			assert.match((outcome as { message: string }).message, message);
			assert.match((outcome as { message: string }).message, /\/bro doctor/);
		});
	});
}

test("grok btw/explain terminal errors keep partial text and use feature wording", async () => {
	await withFakeGrok([init(), textDelta("half"), result({ is_error: true, subtype: "error_during_execution", errors: ["rate limited"] })].join("\n"), async () => {
		const { outcome } = await run({ feature: "btw", access: "restricted", cwd: "workspace", prompt: "p" });
		assert.equal(outcome.status, "failure");
		assert.match((outcome as { message: string }).message, /Grok failed: rate limited/);
		assert.equal((outcome as { partialText?: string }).partialText, "half");
	});
	await withFakeGrok(`${textDelta("half")}\necho boom >&2\nexit 2`, async () => {
		const { outcome } = await run({ feature: "explain", access: "restricted", prompt: "p" });
		assert.match((outcome as { message: string }).message, /Grok could not simplify the response: boom/);
	});
	await withFakeGrok(success("  "), async () => {
		const { outcome } = await run({ feature: "btw", access: "restricted", cwd: "workspace", prompt: "p" });
		assert.match((outcome as { message: string }).message, /Grok returned no answer for the side question/);
	});
});

test("grok btw: cancellation keeps partial text; explain deadline times out and removes the scratch cwd", async () => {
	await withFakeGrok(`${textDelta("partial")}\nexec sleep 30`, async () => {
		const controller = new AbortController();
		const { outcome } = await run({ feature: "btw", access: "restricted", cwd: "workspace", prompt: "p" }, () => controller.abort(), controller.signal);
		assert.deepEqual(outcome, { status: "cancelled", message: "Canceled.", partialText: "partial" });
	});
	await withFakeGrok("exec sleep 30", async (binDir) => {
		const { outcome } = await run({ feature: "explain", access: "restricted", prompt: "p" }, undefined, new AbortController().signal, 1_500);
		assert.equal(outcome.status, "timeout");
		assert.match((outcome as { message: string }).message, /Grok timed out while simplifying the response/);
		assert.equal(existsSync((await readFile(join(binDir, "pwd.txt"), "utf8")).trim()), false);
	});
});
