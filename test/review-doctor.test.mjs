import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bro } from "./test-build.mjs";

test("doctor probes each backend selected only by the review capability", async () => {
	const directory = process.env.PI_CODING_AGENT_DIR;
	await mkdir(directory, { recursive: true });
	for (const backend of ["agy", "claude", "grok", "codex", "muse"]) {
		const other = backend === "agy" ? "claude" : "agy";
		await writeFile(
			join(directory, "bro-settings.json"),
			JSON.stringify({
				version: 2,
				default: { backend: other, model: "test", effort: "default" },
				overrides: { review: { backend, model: "test", effort: "default" } },
			}),
		);
		const calls = [];
		const pi = {
			getAllTools: () => [],
			getActiveTools: () => [],
			exec: async (command, args) => {
				calls.push({ command, args });
				throw Error("offline probe fixture");
			},
		};
		const ctx = { sessionManager: { getBranch: () => [] } };
		const report = await bro.doctorReport(pi, ctx, new AbortController().signal);
		if (!["claude", "muse"].includes(backend))
			assert.match(report, /needs a Claude or Muse override/);
		assert.ok(
			calls.some((call) => call.command === backend),
			`${backend} review override must be probed`,
		);
	}
});

test("unsupported optional review backend does not make a healthy installation fail", async () => {
	const directory = process.env.PI_CODING_AGENT_DIR;
	await mkdir(directory, { recursive: true });
	for (const backend of ["agy", "grok", "codex"]) {
		await writeFile(
			join(directory, "bro-settings.json"),
			JSON.stringify({ version: 2, default: { backend, model: "test", effort: "default" } }),
		);
		const pi = {
			getAllTools: () => [],
			getActiveTools: () => [],
			exec: async (_command, args) => ({
				code: 0,
				killed: false,
				stderr: "",
				stdout:
					args[0] === "models"
						? "test\tTest"
						: args.includes("/usage")
							? JSON.stringify({ status: "SUCCESS", response: "Fixture\tRequests\t100" })
							: args[0] === "login"
								? "Logged in"
								: "1.3.3",
			}),
		};
		const report = await bro.doctorReport(
			pi,
			{ sessionManager: { getBranch: () => [] } },
			new AbortController().signal,
		);
		assert.match(report, /Bro is ready\./, backend);
		assert.doesNotMatch(report, /Bro needs attention|✗/);
		assert.match(
			report,
			/- ℹ \*\*Guided review:\*\* needs a Claude or Muse override in `\/bro config`/,
		);
	}
});
