import { spawn } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BRO_MODES, buildDefaultPrompt, type BroMode } from "../prompt.ts";
import { buildBaselinePrompt } from "./baseline.ts";
import { BENCHMARK_CORPUS, checkOutput, type BenchmarkFixture } from "./corpus.ts";

const MODEL = "gemini-3.7-flash";
const EFFORT = "low";
const TIMEOUT_MS = 125_000;
const WORK_DIRECTORY = fileURLToPath(new URL("./.work/", import.meta.url));
const VARIANTS = ["baseline", ...BRO_MODES] as const;
type PromptVariant = (typeof VARIANTS)[number];

export type CallIdentity = {
	fixture: string;
	fixtureSha256: string;
	variant: string;
	promptSha256: string;
	model: string;
	effort: string;
	timeoutMs: number;
};

type ManifestRow = CallIdentity & {
	callId: string;
};

export type BenchmarkManifest = {
	version: 1;
	rows: ManifestRow[];
	fingerprint: string;
};

type BenchmarkResult = {
	callId: string;
	fixture: string;
	variant: PromptVariant;
	model: string;
	effort: string;
	elapsedMs: number;
	outcome: "success" | "error" | "timeout" | "cancelled";
	stopReason: string | null;
	output: string;
	error?: string;
};

type StreamEvent = {
	event?: string;
	step_update?: { step_type?: string; text_delta?: unknown };
	result?: { status?: string; response?: unknown };
};

export function stableCallId(identity: CallIdentity): string {
	return sha256(stableJson(identity));
}

export function buildManifest(): BenchmarkManifest {
	const rows: ManifestRow[] = [];
	for (const fixture of BENCHMARK_CORPUS) {
		for (const variant of VARIANTS) {
			const prompt = promptFor(fixture.target, variant);
			const identity: CallIdentity = {
				fixture: fixture.id,
				fixtureSha256: sha256(fixture.target),
				variant,
				promptSha256: sha256(prompt),
				model: MODEL,
				effort: EFFORT,
				timeoutMs: TIMEOUT_MS,
			};
			rows.push({ callId: stableCallId(identity), ...identity });
		}
	}
	const withoutFingerprint = { version: 1 as const, rows };
	return { ...withoutFingerprint, fingerprint: sha256(stableJson(withoutFingerprint)) };
}

function promptFor(target: string, variant: PromptVariant): string {
	return variant === "baseline" ? buildBaselinePrompt(target) : buildDefaultPrompt(target, variant as BroMode);
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function runMatrix(approval: string | undefined): Promise<void> {
	const manifest = buildManifest();
	if (approval !== manifest.fingerprint) {
		throw new Error(`Refusing live calls. Re-run with --approve ${manifest.fingerprint}`);
	}

	await mkdir(WORK_DIRECTORY, { recursive: true });
	await writeAtomic(join(WORK_DIRECTORY, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(await usagePreflight());
	console.log(`Approved ${manifest.rows.length} calls on ${MODEL} (${EFFORT}).`);

	const runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-benchmark-"));
	const controller = new AbortController();
	const onSigint = () => controller.abort();
	process.once("SIGINT", onSigint);
	try {
		for (const [index, row] of manifest.rows.entries()) {
			const saved = await readResult(row.callId);
			if (saved) {
				console.log(`[${index + 1}/${manifest.rows.length}] skip ${row.fixture}/${row.variant} (${saved.outcome})`);
				continue;
			}
			if (controller.signal.aborted) break;
			const fixture = fixtureFor(row.fixture);
			console.log(`[${index + 1}/${manifest.rows.length}] ${row.fixture}/${row.variant}`);
			const result = await executeCall(row, promptFor(fixture.target, row.variant as PromptVariant), runDirectory, controller.signal);
			await writeAtomic(resultPath(row.callId), `${JSON.stringify(result)}\n`);
			if (result.outcome !== "success") {
				throw new Error(`Stopped after ${row.fixture}/${row.variant}: ${result.outcome}${result.error ? `: ${result.error}` : ""}`);
			}
		}
	} finally {
		process.removeListener("SIGINT", onSigint);
		await rm(runDirectory, { recursive: true, force: true });
	}
}

async function executeCall(
	row: ManifestRow,
	prompt: string,
	cwd: string,
	signal: AbortSignal,
): Promise<BenchmarkResult> {
	if (signal.aborted) return baseResult(row, 0, "cancelled", null, "");
	const startedAt = Date.now();
	const child = spawn("agy", [
		"--sandbox",
		"--disable-slash-commands",
		"--output-format", "stream-json",
		"--model", row.model,
		"--effort", row.effort,
		"--print-timeout", "2m",
		"--print", prompt,
	], { cwd, signal, timeout: row.timeoutMs, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

	let stderr = "";
	let final = "";
	let stopReason: string | null = null;
	let parseError: string | undefined;
	let processError: string | undefined;
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => { stderr += chunk; });
	child.once("error", (error) => { processError = error.message; });
	const closed = new Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>((done) => {
		child.once("close", (code, exitSignal) => done({ code, exitSignal }));
	});
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as StreamEvent;
				if (event.event === "result") {
					stopReason = event.result?.status === "SUCCESS" ? "stop" : "error";
					if (typeof event.result?.response === "string") final = event.result.response;
				}
			} catch {
				parseError = "Agy returned malformed stream JSON.";
				child.kill();
				break;
			}
		}
	} finally {
		lines.close();
	}
	const closedResult = await closed;
	const elapsedMs = Date.now() - startedAt;
	if (signal.aborted) return baseResult(row, elapsedMs, "cancelled", stopReason, final, "Cancelled.");
	if (parseError) return baseResult(row, elapsedMs, "error", stopReason, final, parseError);
	if (processError) return baseResult(row, elapsedMs, "error", stopReason, final, processError);
	if (closedResult.exitSignal || closedResult.code === null) {
		return baseResult(row, elapsedMs, "timeout", stopReason, final, stderr.trim() || "Agy timed out.");
	}
	if (closedResult.code !== 0) return baseResult(row, elapsedMs, "error", stopReason, final, stderr.trim() || `Agy exited ${closedResult.code}.`);
	if (!final.trim() || stopReason !== "stop") return baseResult(row, elapsedMs, "error", stopReason, final, "Agy returned no successful final output.");
	return baseResult(row, elapsedMs, "success", stopReason, final.trim());
}

function baseResult(
	row: ManifestRow,
	elapsedMs: number,
	outcome: BenchmarkResult["outcome"],
	stopReason: string | null,
	output: string,
	error?: string,
): BenchmarkResult {
	return {
		callId: row.callId,
		fixture: row.fixture,
		variant: row.variant as PromptVariant,
		model: row.model,
		effort: row.effort,
		elapsedMs,
		outcome,
		stopReason,
		output,
		...(error ? { error } : {}),
	};
}

async function usagePreflight(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-bro-benchmark-usage-"));
	try {
		const child = spawn("agy", ["-p", "/usage", "--output-format", "json", "--print-timeout", "30s", "--sandbox"], {
			cwd,
			timeout: 35_000,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		const code = await new Promise<number | null>((done) => child.once("close", done));
		if (code !== 0) throw new Error(stderr.trim() || "Agy usage preflight failed.");
		return `Agy usage preflight:\n${stdout.trim()}`;
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

async function writeReport(): Promise<void> {
	const manifest = buildManifest();
	await mkdir(WORK_DIRECTORY, { recursive: true });
	const results = (await Promise.all(manifest.rows.map((row) => readResult(row.callId)))).filter((result): result is BenchmarkResult => result !== undefined);
	const mapping = await candidateMapping();
	const mechanical = results.map((result) => {
		const fixture = fixtureFor(result.fixture);
		return { callId: result.callId, fixture: result.fixture, variant: result.variant, outcome: result.outcome, checks: checkOutput(fixture, result.output) };
	});
	await writeAtomic(join(WORK_DIRECTORY, "mechanical-report.json"), `${JSON.stringify(mechanical, null, 2)}\n`);
	await writeAtomic(join(WORK_DIRECTORY, "blind-review.md"), `${blindReview(results, mapping)}\n`);
	console.log(`Wrote ${join(WORK_DIRECTORY, "blind-review.md")} for ${results.length}/${manifest.rows.length} results.`);
}

async function candidateMapping(): Promise<Record<PromptVariant, string>> {
	const path = join(WORK_DIRECTORY, "blind-map.json");
	try {
		return JSON.parse(await readFile(path, "utf8")) as Record<PromptVariant, string>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const shuffled = [...VARIANTS];
	for (let index = shuffled.length - 1; index > 0; index -= 1) {
		const selected = randomInt(index + 1);
		[shuffled[index], shuffled[selected]] = [shuffled[selected]!, shuffled[index]!];
	}
	const mapping = Object.fromEntries(shuffled.map((variant, index) => [variant, `Candidate ${String(index + 1).padStart(2, "0")}`])) as Record<PromptVariant, string>;
	await writeAtomic(path, `${JSON.stringify(mapping, null, 2)}\n`);
	return mapping;
}

function blindReview(results: BenchmarkResult[], mapping: Record<PromptVariant, string>): string {
	const sections = BENCHMARK_CORPUS.map((fixture) => {
		const candidates = results
			.filter((result) => result.fixture === fixture.id)
			.sort((left, right) => mapping[left.variant].localeCompare(mapping[right.variant]))
			.map((result) => [
				`### ${mapping[result.variant]}`,
				"",
				"````text",
				result.output || "(no output)",
				"````",
				"",
				`- latency: ${result.elapsedMs} ms`,
				`- outcome: ${result.outcome}`,
				"- clarity (0–2):",
				"- fidelity (0–2):",
				"- safety/preservation (0–2):",
				"- mode adherence (0–2):",
				"- notes:",
			].join("\n"));
		return [`## ${fixture.description}`, "", "### Source", "", "````text", fixture.target, "````", "", ...candidates].join("\n");
	});
	return ["# Bro benchmark blind review", "", "Score without opening blind-map.json. One pass is directional evidence, not statistical proof.", "", ...sections].join("\n");
}

async function readResult(callId: string): Promise<BenchmarkResult | undefined> {
	try {
		return JSON.parse(await readFile(resultPath(callId), "utf8")) as BenchmarkResult;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeAtomic(path: string, contents: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, contents, "utf8");
	await rename(temporary, path);
}

function resultPath(callId: string): string {
	return join(WORK_DIRECTORY, `${callId}.json`);
}

function fixtureFor(id: string): BenchmarkFixture {
	const fixture = BENCHMARK_CORPUS.find((item) => item.id === id);
	if (!fixture) throw new Error(`Unknown fixture: ${id}`);
	return fixture;
}

function dryRun(): void {
	const manifest = buildManifest();
	console.log(JSON.stringify({ callCount: manifest.rows.length, model: MODEL, effort: EFFORT, variants: VARIANTS, fixtures: BENCHMARK_CORPUS.map((fixture) => fixture.id), fingerprint: manifest.fingerprint }, null, 2));
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (command === "dry-run") {
		dryRun();
		return;
	}
	if (command === "run") {
		const approvalIndex = args.indexOf("--approve");
		await runMatrix(approvalIndex === -1 ? undefined : args[approvalIndex + 1]);
		return;
	}
	if (command === "report") {
		await writeReport();
		return;
	}
	throw new Error("Use dry-run, run --approve <fingerprint>, or report.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
