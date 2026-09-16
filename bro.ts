import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, matchesKey, truncateToWidth, visibleWidth, type Focusable } from "@earendil-works/pi-tui";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import mammoth from "mammoth";
import { extractText } from "unpdf";
import { BRO_MODES, DEFAULT_BRO_MODE, buildBtwPrompt, buildDefaultPrompt, buildShowPrompt, parseBroMode, type BroMode } from "./prompt.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const ENV_MODEL = process.env.PI_BRO_MODEL?.trim();
const DEFAULT_MODEL = ENV_MODEL || "gemini-3.7-flash";
const PROMPT_FILE = join(AGENT_DIR, "bro-prompt.md");
const SETTINGS_FILE = join(AGENT_DIR, "bro-settings.json");
const LOADING_TEXT = "Simplifying for my bro…";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_WEB_BYTES = 5 * 1024 * 1024;
const MAX_WEB_ELEMENTS = 100_000;
const MAX_WEB_REDIRECTS = 5;
const WEB_TIMEOUT_MS = 25_000;
const MAX_TEXT_LENGTH = 100_000;
const BTW_CONTEXT_TURNS = 8;
const BTW_CONTEXT_MAX = 40_000;
const DEFAULT_SHOW_TURNS = 1;
const SHOW_HTML_FILE_PATTERN = /^bro-show-[0-9a-f]{8}\.html$/;
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type Theme = ExtensionCommandContext["ui"]["theme"];
type TuiLike = {
	readonly mode: "regular" | "fullscreen";
	readonly terminal?: { write?: (data: string) => void };
	requestRender(): void;
};
type ModalKind = "loading" | "streaming" | "result" | "help" | "empty" | "error";
type BroSource = { text: string; label?: string };
type BroResult = { source: BroSource; text: string };
type ModalResult = { source?: BroSource; text: string; htmlPath?: string };
type BtwTurn = { question: string; answer: string };
type BtwThread = { turns: BtwTurn[]; conversationId?: string; full: boolean };
const EFFORTS = ["default", "low", "medium", "high"] as const;
type BroEffort = (typeof EFFORTS)[number];
type AgyEffort = Exclude<BroEffort, "default">;
type ProviderSelection = { id: string; model: string };
type BroSettings = { model: string; effort: BroEffort; mode: BroMode; showTurns: number; provider?: ProviderSelection };
type AgyModelFamily = {
	id: string;
	label: string;
	efforts: AgyEffort[];
	variants: Array<{ id: string; effort?: AgyEffort }>;
};
type AgyEvent = {
	event?: string;
	conversation_id?: string;
	init?: { model?: string; cwd?: string; permission_mode?: string; tools?: unknown };
	step_update?: { step_type?: string; text_delta?: unknown };
	result?: { status?: string; response?: unknown; error?: unknown; conversation_id?: string };
};

export function wheelDelta(data: string): number {
	const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
	if (!match) return 0;
	const button = Number.parseInt(match[1], 10);
	if ((button & 64) === 0) return 0;
	return (button & 3) === 0 ? -3 : (button & 3) === 1 ? 3 : 0;
}

export function setRegularMouseReporting(tui: Pick<TuiLike, "mode" | "terminal">, enabled: boolean): void {
	if (tui.mode === "regular") tui.terminal?.write?.(`\x1b[?1000${enabled ? "h" : "l"}\x1b[?1006${enabled ? "h" : "l"}`);
}

const COMMANDS = [
	{ value: "text", label: "text", description: "Explain pasted text, or the latest reply when text is omitted" },
	{ value: "file", label: "file", description: "Explain a local document" },
	{ value: "url", label: "url", description: "Explain a public webpage" },
	{ value: "open", label: "open", description: "Reopen the last explanation" },
	{ value: "doctor", label: "doctor", description: "Check whether Bro is ready" },
	{ value: "usage", label: "usage", description: "Show current Agy usage" },
	{ value: "model", label: "model", description: "Choose the Agy model" },
	{ value: "effort", label: "effort", description: "Choose the Agy reasoning effort" },
	{ value: "provider", label: "provider", description: "Use a registered provider and model instead of Agy" },
	{ value: "show", label: "show", description: "Draw what happened in recent session turns as shapes" },
	{ value: "mode", label: "mode", description: "Choose brief, balanced, or faithful explanations" },
	{ value: "btw", label: "btw", description: "Open a side conversation (sandboxed by default; --full edits files)" },
	{ value: "help", label: "help", description: "Learn what Bro does and what it can access" },
];
const KNOWN_ACTIONS = new Set(COMMANDS.map((command) => command.value));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function withDoctor(error: unknown): string {
	const message = errorMessage(error);
	return message.includes("/bro doctor") ? message : `${message}\n\nRun \`/bro doctor\` for setup help.`;
}

function fileError(path: string, error: unknown): Error {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT") return new Error(`File not found: ${path}`);
	if (code === "EACCES" || code === "EPERM") return new Error(`File is not readable: ${path}`);
	return new Error(`Could not read ${path}: ${errorMessage(error)}`);
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
		return value.slice(1, -1);
	}
	return value;
}

export async function extractDocumentText(input: string, cwd: string, signal?: AbortSignal): Promise<string> {
	const requested = unquote(input.trim());
	if (!requested) throw new Error("Use /bro file <path>.");

	let root: string;
	let path: string;
	try {
		root = await realpath(cwd);
		path = await realpath(resolve(cwd, requested));
	} catch (error) {
		throw fileError(requested, error);
	}

	const fromRoot = relative(root, path);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		throw new Error("Bro can read only files inside the current workspace.");
	}

	let info;
	try {
		info = await stat(path);
	} catch (error) {
		throw fileError(requested, error);
	}
	if (!info.isFile()) throw new Error(`Not a regular file: ${requested}`);
	if (info.size > MAX_FILE_BYTES) throw new Error("File is larger than Bro's 10 MiB limit.");

	let buffer: Buffer;
	try {
		buffer = await readFile(path, { signal });
	} catch (error) {
		if (signal?.aborted) throw new Error("Canceled.");
		throw fileError(requested, error);
	}
	if (buffer.byteLength > MAX_FILE_BYTES) throw new Error("File is larger than Bro's 10 MiB limit.");
	if (signal?.aborted) throw new Error("Canceled.");

	const extension = extname(path).toLowerCase();
	let text: string;
	try {
		if (TEXT_EXTENSIONS.has(extension)) {
			text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
		} else if (extension === ".pdf") {
			text = (await extractText(new Uint8Array(buffer), { mergePages: true })).text;
		} else if (extension === ".docx") {
			text = (await mammoth.extractRawText({ buffer })).value;
		} else {
			throw new Error("Unsupported file type. Use .md, .markdown, .txt, .pdf, or .docx.");
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Unsupported file type.")) throw error;
		throw new Error(`Could not extract text from ${requested}: ${errorMessage(error)}`);
	}

	text = text.trim();
	if (!text) throw new Error("No readable text found. Scanned PDFs need OCR, which Bro does not support.");
	if (text.length > MAX_TEXT_LENGTH) throw new Error("Extracted text is longer than Bro's 100,000-character limit.");
	return text;
}

const SNIFFABLE_FILE_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ".pdf", ".docx"]);

async function isWorkspaceFile(input: string, cwd: string): Promise<boolean> {
	// ponytail: duplicates extractDocumentText's workspace guard rather than sharing its error semantics.
	try {
		const path = await realpath(resolve(cwd, input));
		const fromRoot = relative(await realpath(cwd), path);
		if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
			return false;
		}
		const info = await stat(path);
		return info.isFile() && SNIFFABLE_FILE_EXTENSIONS.has(extname(path).toLowerCase());
	} catch {
		return false;
	}
}

const NON_PUBLIC_ADDRESSES = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.31.196.0", 24],
	["192.52.193.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["192.175.48.0", 24],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
	["::", 128],
	["::1", 128],
	["64:ff9b::", 96],
	["64:ff9b:1::", 48],
	["100::", 64],
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
	["5f00::", 16],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

export function isPublicWebAddress(address: string): boolean {
	const family = isIP(address);
	return family === 4
		? !NON_PUBLIC_ADDRESSES.check(address, "ipv4")
		: family === 6
			? !NON_PUBLIC_ADDRESSES.check(address, "ipv6")
			: false;
}

export function parseWebUrl(input: string): URL {
	const requested = unquote(input.trim());
	if (!requested) throw new Error("Use /bro url <url>.");

	let url: URL;
	try {
		url = new URL(requested);
	} catch {
		throw new Error("That is not a valid URL. Use /bro url https://example.com/article.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Bro can read only public HTTP or HTTPS webpages.");
	}
	if (url.username || url.password) {
		throw new Error("Bro does not accept URLs containing usernames or passwords.");
	}
	url.hash = "";
	return url;
}

export function looksLikeWebUrl(input: string): boolean {
	// Structurally http(s) only: credential or syntax problems must surface as url errors, not text leaks.
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return false;
	}
	return url.protocol === "http:" || url.protocol === "https:";
}

export function parseWebRedirect(current: URL, location: string): URL {
	const next = parseWebUrl(new URL(location, current).href);
	if (current.protocol === "https:" && next.protocol !== "https:") {
		throw new Error("Bro refused an insecure HTTPS-to-HTTP redirect.");
	}
	return next;
}

function headerValue(value: string | string[] | undefined): string {
	return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
	const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	let addresses: Array<{ address: string; family: number }>;
	try {
		addresses = await lookup(host, { all: true, verbatim: true });
	} catch (error) {
		throw new Error(`Could not resolve webpage host: ${errorMessage(error)}`);
	}
	if (!addresses.length) throw new Error("The webpage host has no network address.");
	if (addresses.some((item) => !isPublicWebAddress(item.address))) {
		throw new Error("Bro cannot connect to local, private, or reserved network addresses.");
	}
	return { address: addresses[0].address, family: addresses[0].family === 6 ? 6 : 4 };
}

function requestWebPage(url: URL, address: { address: string; family: 4 | 6 }, signal: AbortSignal): Promise<IncomingMessage> {
	return new Promise((resolveResponse, rejectResponse) => {
		const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
			url,
			{
				method: "GET",
				signal,
				headers: {
					Accept: "text/html,application/xhtml+xml",
					"Accept-Encoding": "identity",
					"User-Agent": "pi-bro URL reader (+https://github.com/tranhoangnguyen03/pi-bro)",
				},
				lookup: (_hostname, options, callback) => {
					if (options.all) callback(null, [address]);
					else callback(null, address.address, address.family);
				},
			},
			resolveResponse,
		);
		request.once("error", rejectResponse);
		request.end();
	});
}

async function readWebBody(response: IncomingMessage): Promise<Buffer> {
	const contentEncoding = headerValue(response.headers["content-encoding"]).trim().toLowerCase();
	if (contentEncoding && contentEncoding !== "identity") {
		response.destroy();
		throw new Error(`Bro cannot read this page's ${contentEncoding} response encoding.`);
	}

	const contentLength = Number.parseInt(headerValue(response.headers["content-length"]), 10);
	if (Number.isFinite(contentLength) && contentLength > MAX_WEB_BYTES) {
		response.destroy();
		throw new Error("Webpage is larger than Bro's 5 MiB download limit.");
	}

	const chunks: Buffer[] = [];
	let size = 0;
	try {
		for await (const chunk of response) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.byteLength;
			if (size > MAX_WEB_BYTES) throw new Error("Webpage is larger than Bro's 5 MiB download limit.");
			chunks.push(buffer);
		}
	} catch (error) {
		response.destroy();
		throw error;
	}
	return Buffer.concat(chunks, size);
}

function decodeWebHtml(buffer: Buffer, contentType: string): string {
	const headerCharset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
	const head = new TextDecoder("latin1").decode(buffer.subarray(0, 2048));
	const metaCharset = /<meta[^>]+charset\s*=\s*["']?([^\s;"'>]+)/i.exec(head)?.[1]
		?? /<meta[^>]+content\s*=\s*["'][^"']*charset=([^\s;"']+)/i.exec(head)?.[1];
	const charset = headerCharset ?? metaCharset ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(buffer);
	} catch {
		throw new Error(`Bro does not support this page's ${charset} character encoding.`);
	}
}

function assertWebElementLimit(html: string): void {
	let count = 0;
	for (let index = 0; index < html.length - 1; index++) {
		if (html.charCodeAt(index) !== 60) continue;
		const next = html.charCodeAt(index + 1) | 32;
		if (next >= 97 && next <= 122 && ++count > MAX_WEB_ELEMENTS) {
			throw new Error("Webpage is too complex for Bro to read safely.");
		}
	}
}

async function fetchPublicHtml(startUrl: URL, signal: AbortSignal): Promise<{ html: string; url: URL }> {
	let url = startUrl;
	const visited = new Set<string>();

	for (let redirects = 0; ; redirects++) {
		if (visited.has(url.href)) throw new Error("Webpage redirect loop detected.");
		visited.add(url.href);
		const address = await resolvePublicAddress(url.hostname);
		let response: IncomingMessage;
		try {
			response = await requestWebPage(url, address, signal);
		} catch (error) {
			throw new Error(`Could not fetch webpage: ${errorMessage(error)}`);
		}
		const status = response.statusCode ?? 0;

		if (REDIRECT_STATUSES.has(status)) {
			response.destroy();
			if (redirects >= MAX_WEB_REDIRECTS) throw new Error("Webpage redirected too many times.");
			const location = headerValue(response.headers.location);
			if (!location) throw new Error(`Webpage returned HTTP ${status} without a redirect location.`);
			url = parseWebRedirect(url, location);
			continue;
		}

		if (status < 200 || status >= 300) {
			response.destroy();
			if (status === 401 || status === 403) {
				throw new Error(`Webpage returned HTTP ${status}. It may require a login or block automated readers.`);
			}
			if (status === 429) throw new Error("Webpage returned HTTP 429 and is limiting automated requests.");
			throw new Error(`Webpage returned HTTP ${status}.`);
		}

		const contentType = headerValue(response.headers["content-type"]);
		const mime = contentType.split(";", 1)[0].trim().toLowerCase();
		if (mime !== "text/html" && mime !== "application/xhtml+xml") {
			response.destroy();
			throw new Error(`Unsupported webpage content type: ${mime || "missing"}.`);
		}

		const html = decodeWebHtml(await readWebBody(response), contentType);
		assertWebElementLimit(html);
		return { html, url };
	}
}

export async function extractWebHtml(html: string, url: string): Promise<BroSource> {
	assertWebElementLimit(html);
	const parsedUrl = parseWebUrl(url);
	const { document } = parseHTML(html);
	const result = await Defuddle(document, parsedUrl.href, {
		markdown: true,
		removeImages: true,
		includeReplies: false,
		useAsync: false,
	});
	const text = (result.contentMarkdown || result.content || "").trim();
	if (!text) {
		throw new Error("Bro found no readable page content. The page may require JavaScript, a login, or block automated readers.");
	}
	if (text.length > MAX_TEXT_LENGTH) {
		throw new Error("Extracted webpage text is longer than Bro's 100,000-character limit.");
	}
	const title = result.title
		? stripVTControlCharacters(result.title).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)
		: undefined;
	return { text, label: [parsedUrl.hostname, title].filter(Boolean).join(" · ") };
}

export async function extractWebPage(input: string, signal?: AbortSignal): Promise<BroSource> {
	const timeout = AbortSignal.timeout(WEB_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	try {
		const fetched = await fetchPublicHtml(parseWebUrl(input), combinedSignal);
		return await extractWebHtml(fetched.html, fetched.url.href);
	} catch (error) {
		if (signal?.aborted) throw new Error("Canceled.");
		if (timeout.aborted) throw new Error("Webpage took longer than 25 seconds to respond.");
		throw error;
	}
}

export function agyFailureMessage(
	action: string,
	result: { code: number; killed: boolean; stderr: string },
): string {
	if (result.killed) return `Agy timed out while trying to ${action}. Run \`/bro doctor\` for setup help.`;
	const detail = result.stderr.trim();
	if (detail) return `Agy could not ${action}: ${detail}\n\nRun \`/bro doctor\` for setup help.`;
	return `Agy could not ${action}. Make sure Agy is installed and signed in, then run \`/bro doctor\`.`;
}

export function parseProviderSelection(value: unknown): ProviderSelection | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error('Settings "provider" must be an object with "id" and "model".');
	const id = typeof value.id === "string" ? value.id.trim() : "";
	const model = typeof value.model === "string" ? value.model.trim() : "";
	if (!id || !model) throw new Error('Settings "provider" must contain a non-empty "id" and "model".');
	return { id, model };
}

export function parseBroSettings(value: unknown): BroSettings {
	if (
		!isRecord(value) ||
		typeof value.model !== "string" ||
		!value.model.trim() ||
		!EFFORTS.some((effort) => effort === value.effort)
	) {
		throw new Error('Settings must contain a model and effort set to "default", "low", "medium", or "high".');
	}
	const mode = value.mode === undefined ? DEFAULT_BRO_MODE : parseBroMode(value.mode);
	if (!mode) throw new Error('Settings mode must be "brief", "balanced", or "faithful".');
	const showTurns = value.showTurns === undefined ? DEFAULT_SHOW_TURNS : value.showTurns;
	if (typeof showTurns !== "number" || !Number.isInteger(showTurns) || showTurns < 1) {
		throw new Error("Settings showTurns must be a positive whole number of turns.");
	}
	const provider = parseProviderSelection(value.provider);
	return { model: value.model.trim(), effort: value.effort as BroSettings["effort"], mode, showTurns, ...(provider ? { provider } : {}) };
}

async function ensureSettingsFile(): Promise<void> {
	await mkdir(AGENT_DIR, { recursive: true });
	try {
		await writeFile(
			SETTINGS_FILE,
			`${JSON.stringify({ model: DEFAULT_MODEL, effort: ENV_MODEL ? "default" : "low", mode: DEFAULT_BRO_MODE, showTurns: DEFAULT_SHOW_TURNS }, null, 2)}\n`,
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

async function readSettings(): Promise<BroSettings> {
	await ensureSettingsFile();
	try {
		return parseBroSettings(JSON.parse(await readFile(SETTINGS_FILE, "utf8")));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`${SETTINGS_FILE} is not valid JSON.`);
		if (error instanceof Error) throw new Error(`${SETTINGS_FILE}: ${error.message}`);
		throw error;
	}
}

async function writeSettings(settings: BroSettings): Promise<void> {
	// ponytail: last writer wins across concurrent Pi processes; add locking only if that becomes a common workflow.
	await writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

// Reads only the provider selection, without creating the settings file and without throwing on a
// missing or malformed file: the Agy-only command guards must have no side effects of their own.
async function readProviderSelection(): Promise<ProviderSelection | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
		return isRecord(parsed) ? parseProviderSelection(parsed.provider) : undefined;
	} catch {
		return undefined;
	}
}

export function formatAgyUsage(value: unknown): string {
	if (!isRecord(value) || value.status !== "SUCCESS" || typeof value.response !== "string") {
		throw new Error("Agy returned invalid usage data.");
	}

	const groups = new Map<string, string[]>();
	for (const line of value.response.trim().split("\n")) {
		const [group, limit, remaining, resetTime] = line.split("\t");
		if (!group || !limit || !remaining) throw new Error("Agy returned invalid usage data.");
		const reset = resetTime ? new Date(resetTime) : undefined;
		const resetText = reset && !Number.isNaN(reset.getTime()) ? ` — resets ${reset.toLocaleString()}` : "";
		const items = groups.get(group) ?? [];
		items.push(`- **${limit}:** ${remaining}${resetText}`);
		groups.set(group, items);
	}
	if (!groups.size) throw new Error("Agy returned no usage information.");

	const sections = [...groups].map(([group, items]) => `## ${group}\n\n${items.join("\n")}`);
	return `# Agy usage\n\n${sections.join("\n\n")}`;
}

export function parseAgyModels(output: string): AgyModelFamily[] {
	// ponytail: Agy 1.1.13 exposes a tab-separated variant list; use structured catalog data when available here.
	const families = new Map<string, AgyModelFamily>();
	for (const line of output.split(/\r?\n/)) {
		const [rawId, ...rawLabel] = line.split("\t");
		if (!rawId?.trim() || !rawLabel.length) continue;
		const id = rawId.trim();
		const label = rawLabel.join(" ").trim();
		const effort = (["low", "medium", "high"] as const).find(
			(value) => id.endsWith(`-${value}`) && label.endsWith(`(${value[0].toUpperCase()}${value.slice(1)})`),
		);
		const familyId = effort ? id.slice(0, -effort.length - 1) : id;
		const family = families.get(familyId) ?? {
			id: familyId,
			label: effort ? label.replace(/\s+\((Low|Medium|High)\)$/, "") : label,
			efforts: [],
			variants: [],
		};
		if (effort && !family.efforts.includes(effort)) family.efforts.push(effort);
		family.variants.push({ id, effort });
		families.set(familyId, family);
	}
	if (!families.size) throw new Error("Agy returned no available models.");
	for (const family of families.values()) {
		family.efforts.sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
	}
	return [...families.values()];
}

async function listAgyModels(pi: ExtensionAPI, signal?: AbortSignal): Promise<AgyModelFamily[]> {
	const runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
	try {
		const result = await pi.exec("agy", ["models"], { cwd: runDirectory, signal, timeout: 30_000 });
		if (signal?.aborted) throw new Error("Canceled.");
		if (result.killed || result.code !== 0) throw new Error(agyFailureMessage("list models", result));
		try {
			return parseAgyModels(result.stdout);
		} catch (error) {
			throw new Error(withDoctor(error));
		}
	} finally {
		await rm(runDirectory, { recursive: true, force: true });
	}
}

async function checkAgyVersion(pi: ExtensionAPI, signal: AbortSignal): Promise<string> {
	const runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
	try {
		const result = await pi.exec("agy", ["--version"], { cwd: runDirectory, signal, timeout: 10_000 });
		if (signal.aborted) throw new Error("Canceled.");
		if (result.killed || result.code !== 0) throw new Error(agyFailureMessage("start", result));
		const version = result.stdout.trim() || result.stderr.trim();
		if (!version) throw new Error("Agy returned no version information. Update Agy, then run `/bro doctor` again.");
		return version;
	} finally {
		await rm(runDirectory, { recursive: true, force: true });
	}
}

function resolveCatalogSettings(
	settings: BroSettings,
	families: AgyModelFamily[],
): { settings: BroSettings; family?: AgyModelFamily } {
	const family = families.find(
		(item) => item.id === settings.model || item.variants.some((variant) => variant.id === settings.model),
	);
	if (!family) return { settings };
	const variant = family.variants.find((item) => item.id === settings.model);
	return {
		family,
		settings: {
			...settings,
			model: family.id,
			effort: settings.effort === "default" && variant?.effort ? variant.effort : settings.effort,
		},
	};
}

function preferredEffort(family: AgyModelFamily): BroEffort {
	return family.efforts.includes("low") ? "low" : (family.efforts[0] ?? "default");
}

export function agySelection(settings: BroSettings): { model: string; effort?: AgyEffort } {
	if (settings.effort === "default") return { model: settings.model };
	const suffix = (["low", "medium", "high"] as const).find((effort) => settings.model.endsWith(`-${effort}`));
	return {
		model: suffix ? settings.model.slice(0, -suffix.length - 1) : settings.model,
		effort: settings.effort,
	};
}

async function checkAgyUsage(pi: ExtensionAPI, signal: AbortSignal): Promise<string> {
	const runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
	try {
		const result = await pi.exec(
			"agy",
			["-p", "/usage", "--output-format", "json", "--print-timeout", "30s", "--sandbox"],
			{ cwd: runDirectory, signal, timeout: 35_000 },
		);
		if (signal.aborted) throw new Error("Canceled.");
		if (result.killed || result.code !== 0) throw new Error(agyFailureMessage("check account usage", result));
		try {
			return formatAgyUsage(JSON.parse(result.stdout));
		} catch (error) {
			throw new Error(withDoctor(error instanceof SyntaxError ? "Agy returned invalid usage data." : error));
		}
	} finally {
		await rm(runDirectory, { recursive: true, force: true });
	}
}

async function doctorReport(pi: ExtensionAPI, signal: AbortSignal): Promise<string> {
	const lines: string[] = [];
	let failed = false;
	let settings: BroSettings | undefined;
	let models: AgyModelFamily[] | undefined;
	const pass = (name: string, detail: string) => lines.push(`- ✓ **${name}:** ${detail}`);
	const fail = (name: string, error: unknown) => {
		failed = true;
		lines.push(`- ✗ **${name}:** ${errorMessage(error)}`);
	};

	try {
		settings = await readSettings();
		pass("Settings", `valid · mode: ${settings.mode}`);
	} catch (error) {
		fail("Settings", error);
	}

	try {
		const prompt = await promptFor("", settings?.mode ?? DEFAULT_BRO_MODE);
		pass("Prompt", prompt.custom ? "valid custom override" : `valid built-in ${settings?.mode ?? DEFAULT_BRO_MODE} mode`);
	} catch (error) {
		fail("Prompt", error);
	}

	let agyStarted = false;
	try {
		pass("Agy", await checkAgyVersion(pi, signal));
		agyStarted = true;
	} catch (error) {
		if (signal.aborted) throw error;
		fail("Agy", error);
	}

	if (agyStarted) {
		try {
			models = await listAgyModels(pi, signal);
			pass("Model catalog", `${models.length} model${models.length === 1 ? "" : "s"} available`);
		} catch (error) {
			if (signal.aborted) throw error;
			fail("Model catalog", error);
		}

		try {
			await checkAgyUsage(pi, signal);
			pass("Account", "connected");
		} catch (error) {
			if (signal.aborted) throw error;
			fail("Account", error);
		}
	}

	if (settings && models) {
		const current = resolveCatalogSettings(settings, models);
		if (!current.family) {
			fail("Selected model", `\`${settings.model}\` is unavailable. Run \`/bro model\` to choose another.`);
		} else {
			pass("Selected model", `\`${current.family.id}\``);
			const effort = current.settings.effort;
			if (!current.family.efforts.length && effort === "default") {
				pass("Reasoning effort", "built into the selected model");
			} else if (effort !== "default" && current.family.efforts.includes(effort)) {
				pass("Reasoning effort", effort);
			} else {
				fail("Reasoning effort", `\`${effort}\` is unsupported. Run \`/bro effort\` to choose another.`);
			}
		}
	}

	return `# Bro doctor\n\n${lines.join("\n")}\n\n**${failed ? "Bro needs attention." : "Bro is ready."}**\n\n${
		failed ? "Fix the failed items, then press **R** to check again." : "No assistant response was sent and no model turn was run."
	}`;
}

function latestAssistant(ctx: ExtensionCommandContext): BroSource | undefined {
	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason !== "stop") {
			continue;
		}

		const text = entry.message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();

		if (text) return { text };
	}
}

// /bro show: capture only the user- and assistant-visible conversation text of
// recent session turns and let the show prompt draw it as shapes. Tool calls,
// tool results, reasoning, and images never leave the session -- this is a
// structural role/content-type filter, not semantic or keyword-based. See
// docs/plans/2026-09-07-bro-show-visual-design.md (predates this change).
type ShowTurn = { entries: string[]; startsTurn: boolean };

function showTextContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			text += `${(part as { text?: string }).text ?? ""}\n`;
		}
	}
	return text.trim();
}

export function showEntriesForMessage(message: { role?: string; content?: unknown }): string[] {
	if (message.role === "user") {
		const text = showTextContent(message.content);
		return text ? [`## user\n${JSON.stringify(text)}`] : [];
	}
	if (message.role === "assistant") {
		const text = showTextContent(message.content);
		return text ? [`## assistant\n${JSON.stringify(text)}`] : [];
	}
	return [];
}

function serializeShowTurns(turns: readonly ShowTurn[]): string {
	return turns.flatMap((turn) => turn.entries).join("\n\n");
}

export function captureShowTranscript(ctx: ExtensionCommandContext, turnsRequested: number): BroSource | undefined {
	const turns: ShowTurn[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; stopReason?: string };
		// Aborted assistant text is a half-written claim, not a report.
		if (message.role === "assistant" && message.stopReason === "abort") continue;
		const entries = showEntriesForMessage(message);
		// A user message always marks a turn boundary even when it has no
		// capturable text (image-only, whitespace-only): the turn must still
		// count, or /bro show 1 would silently over-capture earlier turns.
		if (message.role === "user") turns.push({ entries, startsTurn: true });
		else if (entries.length) turns.push({ entries, startsTurn: false });
	}

	let start = 0;
	let seen = 0;
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		if (!turns[index]!.startsTurn) continue;
		seen += 1;
		if (seen === turnsRequested) {
			start = index;
			break;
		}
	}
	if (seen === 0) return undefined;

	let text = serializeShowTurns(turns.slice(start));
	while (text.length > MAX_TEXT_LENGTH && start < turns.length - 1) {
		let next = turns.length;
		for (let index = start + 1; index < turns.length; index += 1) {
			if (turns[index]!.startsTurn) {
				next = index;
				break;
			}
		}
		if (next >= turns.length) break;
		start = next;
		text = serializeShowTurns(turns.slice(start));
	}
	if (text.length > MAX_TEXT_LENGTH) text = `${text.slice(0, MAX_TEXT_LENGTH)}\n[… transcript truncated …]`;
	const kept = turns.slice(start).filter((turn) => turn.startsTurn).length;
	return { text: text.trim(), label: `last ${Math.max(1, kept)} turn${kept > 1 ? "s" : ""} · conversation only` };
}

export interface ParsedShowArguments {
	// undefined means "use the configured default"; invalid leading numeric tokens report `invalid` instead.
	requested?: string;
	steering: string;
	invalid: boolean;
}

// A leading token is only ever treated as the turn count, never as the start of the query — so
// "/bro show 1 404 handler" is count 1, query "404 handler", not an ambiguous double-numeric query.
export function parseShowArguments(value: string): ParsedShowArguments {
	const firstSpace = value.search(/\s/);
	const firstToken = firstSpace === -1 ? value : value.slice(0, firstSpace);
	const looksLikeCount = firstToken !== "" && /^-?\d+(?:\.\d+)?$/.test(firstToken);
	if (!looksLikeCount) return { steering: value, invalid: false };

	// Slicing the raw remainder (instead of split(/\s+/).join(" ")) keeps the query's original spacing intact.
	const steering = firstSpace === -1 ? "" : value.slice(firstSpace).replace(/^\s+/, "");
	const valid = /^[1-9]\d*$/.test(firstToken) && Number.isSafeInteger(Number(firstToken));
	return { requested: valid ? firstToken : undefined, steering, invalid: !valid };
}

export function extractShowHtml(text: string): string | undefined {
	const fences = [...text.matchAll(/^```html[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gm)];
	return fences.at(-1)?.[1]?.trim();
}

export function stripShowHtmlFence(text: string): string {
	const matches = [...text.matchAll(/^```html[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gm)];
	const last = matches.at(-1);
	if (!last || last.index === undefined) return text;
	return text.slice(0, last.index) + "[HTML diagram saved — press O to open]" + text.slice(last.index + last[0].length);
}

export function showHtmlDirectory(): string {
	// ponytail: per-uid directory so keep-one cleanup never touches other
	// users' files in a shared /tmp, and readdir stays small.
	return join(tmpdir(), `pi-bro-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
}

function withShowCsp(html: string): string {
	// Defense in depth: the prompt forbids external resources and scripts;
	// a meta CSP blocks them anyway if the model slips.
	const meta = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:;">';
	if (/http-equiv=["']?Content-Security-Policy/i.test(html)) return html;
	return html.replace(/^(\s*(?:<!doctype[^>]*>\s*)?)/i, `$1\n${meta}\n`);
}

export async function writeShowHtml(html: string): Promise<string> {
	const slug = createHash("sha256").update(html).digest("hex").slice(0, 8);
	const directory = showHtmlDirectory();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	for (const name of await readdir(directory)) {
		if (SHOW_HTML_FILE_PATTERN.test(name)) await rm(join(directory, name), { force: true });
	}
	const path = join(directory, `bro-show-${slug}.html`);
	await writeFile(path, `${withShowCsp(html)}\n`, "utf8");
	return path;
}

function openShowHtml(path: string): boolean {
	if (process.platform === "win32") {
		const result = spawnSync("cmd", ["/c", "start", "", path], { stdio: "ignore", timeout: 5_000 });
		return result.status === 0;
	}
	const opener = process.platform === "darwin" ? "open" : "xdg-open";
	const result = spawnSync(opener, [path], { stdio: "ignore", timeout: 5_000 });
	return result.status === 0;
}

async function promptFor(response: string, mode: BroMode): Promise<{ text: string; custom: boolean }> {
	let template: string;
	try {
		template = await readFile(PROMPT_FILE, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { text: buildDefaultPrompt(response, mode), custom: false };
		}
		throw error;
	}

	const parts = template.split("{{response}}");
	if (parts.length !== 2) throw new Error(`${PROMPT_FILE} must contain {{response}} exactly once.`);
	return { text: parts.join(JSON.stringify(response)), custom: true };
}

function parseAgyLine(line: string): { delta?: string; result?: string } {
	let event: AgyEvent;
	try {
		event = JSON.parse(line) as AgyEvent;
	} catch {
		throw new Error("Agy returned invalid streaming data.");
	}

	if (
		event.event === "step_update" &&
		event.step_update?.step_type === "agent_response" &&
		typeof event.step_update.text_delta === "string"
	) {
		return { delta: event.step_update.text_delta };
	}

	if (event.event === "result") {
		if (event.result?.status !== "SUCCESS" || typeof event.result.response !== "string") {
			throw new Error("Agy did not complete the explanation successfully.");
		}
		return { result: event.result.response };
	}

	return {};
}

async function runProviderText(
	registry: ModelRegistry,
	selection: ProviderSelection,
	prompt: string,
	signal: AbortSignal,
	onProgress?: (text: string) => void,
): Promise<string> {
	const model = registry.find(selection.id, selection.model);
	if (!model) {
		throw new Error(
			`Provider \`${selection.id}\` has no model \`${selection.model}\`. Run \`/bro provider\` to choose another.\n\nRun \`/bro doctor\` for setup help.`,
		);
	}
	if (!registry.hasConfiguredAuth(model)) {
		throw new Error(
			`Provider \`${selection.id}\` has no credentials for \`${selection.model}\`. Sign in or set its API key, then run \`/bro doctor\`.`,
		);
	}
	const provider = registry.getProvider(selection.id);
	if (!provider) {
		throw new Error(
			`Provider \`${selection.id}\` exposes no runtime for \`${selection.model}\`. Run \`/bro doctor\` for setup help.`,
		);
	}
	let partial = "";
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	const report = (text: string) => {
		partial = text;
		if (onProgress && !updateTimer) {
			updateTimer = setTimeout(() => {
				updateTimer = undefined;
				if (!signal.aborted) onProgress(partial);
			}, 75);
		}
	};
	let final = "";
	try {
		const stream = provider.streamSimple(
			model,
			{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
			{ signal },
		);
		for await (const event of stream) {
			if (event.type === "text_delta" && event.delta) report(`${partial}${event.delta}`);
		}
		const message = await stream.result();
		final = message.content
			.filter((block) => block.type === "text")
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("");
	} catch (error) {
		if (signal.aborted) throw new Error("Canceled.");
		throw new Error(
			`Provider \`${selection.id}\` could not explain the text: ${errorMessage(error)}\n\nRun \`/bro doctor\` for setup help.`,
		);
	} finally {
		if (updateTimer) clearTimeout(updateTimer);
	}
	const result = (final || partial).trim();
	if (!result) throw new Error(`Provider \`${selection.id}\` returned an empty explanation.`);
	return result;
}

async function runText(
	registry: ModelRegistry,
	prompt: string,
	settings: BroSettings,
	signal: AbortSignal,
	onProgress?: (text: string) => void,
): Promise<string> {
	if (!settings.provider) return runAgyText(prompt, agySelection(settings), signal, onProgress);
	return runProviderText(registry, settings.provider, prompt, signal, onProgress);
}

function providerDoctorReport(registry: ModelRegistry, settings: BroSettings): string {
	const lines: string[] = [];
	let failed = false;
	const pass = (name: string, detail: string) => lines.push(`- ✓ **${name}:** ${detail}`);
	const fail = (name: string, error: unknown) => {
		failed = true;
		lines.push(`- ✗ **${name}:** ${errorMessage(error)}`);
	};
	const selection = settings.provider;
	if (!selection) {
		fail("Provider", "no provider is selected. Run `/bro provider`.");
	} else {
		pass("Backend", `provider — \`${selection.id}\` (Agy is not used)`);
		const model = registry.find(selection.id, selection.model);
		if (!model) {
			fail("Model", `\`${selection.id}\` has no model \`${selection.model}\`. Run \`/bro provider\` to choose one.`);
		} else {
			pass("Model", `\`${model.id}\``);
			if (registry.hasConfiguredAuth(model)) pass("Credentials", "configured");
			else fail("Credentials", `none for \`${model.id}\`; sign in or set the provider's API key`);
		}
		const catalogError = registry.getError();
		if (catalogError) fail("Provider catalog", catalogError);
	}
	pass("Catalog", `${registry.getAvailable().length} model(s) available through Pi's registry`);
	return `# Bro doctor\n\n${lines.join("\n")}\n\n**${failed ? "Bro needs attention." : "Bro is ready."}**\n\nProvider explanations stream through Pi's model registry. \`/bro usage\`, \`/bro effort\`, and \`/bro btw\` still require Agy.`;
}

async function simplify(
	registry: ModelRegistry,
	response: string,
	signal: AbortSignal,
	settings: BroSettings,
	onProgress?: (text: string) => void,
): Promise<string> {
	return runText(registry, (await promptFor(response, settings.mode)).text, settings, signal, onProgress);
}

async function runShowExplanation(
	registry: ModelRegistry,
	transcript: string,
	steering: string,
	signal: AbortSignal,
	settings: BroSettings,
	onProgress?: (text: string) => void,
): Promise<string> {
	return runText(registry, buildShowPrompt(transcript, steering), settings, signal, onProgress);
}

async function runAgyText(
	prompt: string,
	selection: ReturnType<typeof agySelection>,
	signal: AbortSignal,
	onProgress?: (text: string) => void,
): Promise<string> {
	const runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
	let updateTimer: ReturnType<typeof setTimeout> | undefined;

	try {
		const child = spawn(
			"agy",
			[
				"--sandbox",
				"--disable-slash-commands",
				"--output-format",
				"stream-json",
				"--model",
				selection.model,
				...(selection.effort ? ["--effort", selection.effort] : []),
				"--print-timeout",
				"2m",
				"--print",
				prompt,
			],
			{
				cwd: runDirectory,
				signal,
				timeout: 125_000,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);

		let processError: Error | undefined;
		let stderr = "";
		let partial = "";
		let final = "";
		let parseError: Error | undefined;

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			processError = error;
		});

		const closed = new Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>((resolve) => {
			child.once("close", (code, exitSignal) => resolve({ code, exitSignal }));
		});

		const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
		try {
			for await (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = parseAgyLine(line);
					if (event.delta) {
						partial += event.delta;
						if (onProgress && !updateTimer) {
							updateTimer = setTimeout(() => {
								updateTimer = undefined;
								if (!signal.aborted) onProgress(partial);
							}, 75);
						}
					}
					if (event.result !== undefined) final = event.result;
				} catch (error) {
					parseError = error instanceof Error ? error : new Error(String(error));
					child.kill();
					break;
				}
			}
		} finally {
			lines.close();
		}

		const { code, exitSignal } = await closed;
		if (signal.aborted) throw new Error("Canceled.");
		if (parseError) throw new Error(withDoctor(parseError));
		if (processError) {
			const missing = (processError as NodeJS.ErrnoException).code === "ENOENT";
			throw new Error(
				missing
					? "Agy could not start. Make sure Agy is installed and on PATH, then run `/bro doctor`."
					: `Agy could not start: ${processError.message}\n\nRun \`/bro doctor\` for setup help.`,
			);
		}
		if (exitSignal || code === null) {
			throw new Error("Agy timed out while simplifying the response. Run `/bro doctor` for setup help.");
		}
		if (code !== 0) {
			throw new Error(agyFailureMessage("simplify the response", { code, killed: false, stderr }));
		}

		const text = final.trim();
		if (!text) {
			throw new Error(withDoctor(stderr.trim() || "Agy returned no final explanation."));
		}

		return text;
	} finally {
		if (updateTimer) clearTimeout(updateTimer);
		await rm(runDirectory, { recursive: true, force: true });
	}
}

function helpText(settings?: BroSettings, settingsError?: string): string {
	const settingsSummary = settings
		? `- **Model:** \`${settings.model}\`\n- **Reasoning effort:** ${settings.effort === "default" ? "built into the selected model" : settings.effort}\n- **Mode:** ${settings.mode}\n- **Show turns:** ${settings.showTurns}${settings.provider ? `\n- **Provider backend:** \`${settings.provider.id}\` · \`${settings.provider.model}\`` : ""}`
		: `Bro could not read its settings: ${settingsError}\n\nRun \`/bro doctor\` for setup help.`;
	return `# Bro

Bro explains a dense assistant reply, pasted text, local document, or public webpage in plain language, draws recent session turns as shapes, or opens a sandboxed side conversation with \`/bro btw\` — without adding anything to Pi's conversation.

## Explain

- \`/bro\` — explain the latest completed assistant reply
- \`/bro text [text]\` — explain pasted text, or the latest reply when text is omitted
- \`/bro file <path>\` — explain a Markdown, text, PDF, or DOCX file
- \`/bro url <url>\` — explain one public webpage
- \`/bro open\` — reopen the latest explanation
- \`/bro show [n-turns] [query]\` — draw the last few session turns (default 1) as shapes, from user and assistant conversation text only (tool calls, tool results, reasoning, and images are omitted); add a query to steer what the shapes focus on

Any other input is the source itself: a lone URL explains that webpage, an existing workspace file with a supported extension explains that file, and anything else is explained as pasted text. Quoted paths with spaces are routed too when the file exists.

Press **R** to simplify the captured source again. Run a new \`/bro text\`, \`/bro file\`, \`/bro url\`, or \`/bro show\` command — or give \`/bro\` the input directly — to capture a new source.

## Check and configure

- \`/bro doctor\` — check settings, the active backend, account, model, effort, and mode
- \`/bro usage [--provider agy]\` — show current Agy limits
- \`/bro model [id]\` — view or choose the Agy model
- \`/bro effort [low|medium|high]\` — view or choose reasoning effort
- \`/bro provider [id model]\` — use a registered provider and model instead of Agy; \`/bro provider none\` returns to Agy
- \`/bro mode [brief|balanced|faithful]\` — view or choose explanation mode

## Side conversation

- \`/bro btw [--fresh] [--full] [question]\` — open a side conversation. Sandboxed (read-only) by default; add \`--full\` to let it read and edit the workspace, and \`--fresh\` to start without main-session context. Inside the side thread, type questions and press Enter (empty Enter re-asks); \`/send\` copies the latest answer to the main editor without submitting (use \`/send!\` to replace an existing draft), \`/send all\` the full thread, \`/retry\` re-asks the last question, and \`/clear\` resets the thread. Esc closes.

## Current settings

${settingsSummary}

Saved in \`${SETTINGS_FILE}\`. Use the commands above or edit the file directly. Changes apply to future explanations. \`showTurns\` has no setter command — edit the file directly, or override it per run with \`/bro show <n-turns>\`. Add a query after the count — or on its own, e.g. \`/bro show what changed in the auth flow\` — to steer what the shapes focus on.

## Explanation modes

- brief — the main point and next action, with no fixed word target
- balanced — default; material detail with clearer structure
- faithful — closest to the source, with no fixed word limit
/bro show uses its own built-in draw prompt; the modes and \`bro-prompt.md\` do not affect it.
If \`${PROMPT_FILE}\` exists and is valid, the selected mode stays saved but inactive because the custom prompt fully overrides it. Remove or rename \`bro-prompt.md\` to use the saved built-in mode again.

## Controls

- **Mouse wheel / trackpad** — scroll
- **↑ / ↓** — scroll
- **C** — copy the full explanation
- **R** — repeat the current action\n- **O** — open the HTML diagram when a show reply contains one
- **Esc** — close, or cancel while Bro is working

Bro temporarily captures mouse input while the modal is open. Native mouse selection may be unavailable or extend outside the modal; press **C** to copy everything reliably.

## Important limits

- Documents must be inside the current workspace, are limited to 10 MiB and 100,000 extracted characters, and must be \`.md\`, \`.markdown\`, \`.txt\`, \`.pdf\`, or \`.docx\`. Scanned PDFs need OCR first.
- Web input is limited to one public HTML page. Bro cannot sign in, run page JavaScript, bypass paywalls or blocks, follow pagination, or understand images and video.
- If a webpage fails, copy it into a text file or save it as a PDF, then use \`/bro file\`.
- Show draws only what already happened in this session — the conversation text of the last few turns, with tool calls, tool results, reasoning, and images always omitted — and cannot read the repository or other files on its own. On a remote or headless session with no display, pressing **O** reports a failure instead of opening the diagram.
- Show reflects what was reported in the conversation, not independent verification against the actual code or system state.
- Btw threads are memory-only and do not survive reloads or restarts. A turn is capped at 2 minutes in sandbox mode and 10 minutes in full mode; the side conversation resumes through Agy's \`--conversation\` support.
- With a provider backend selected, \`/bro text\`, \`/bro file\`, \`/bro url\`, and \`/bro show\` stream through Pi's model registry. \`/bro usage\`, \`/bro effort\`, and \`/bro btw\` still require Agy.

## Privacy and safety

Bro sends the selected assistant reply, pasted text, locally extracted document or webpage text, or recent session conversation text (tool calls, tool results, reasoning, and images omitted) to Agy, or to the provider and model you selected with \`/bro provider\`. They may retain request data under their own policies.

Bro never adds the explanation to Pi's conversation, session file, or main-agent context. The captured source and latest explanation stay in process memory until you change sessions, reload extensions, or exit Pi.

Bro's explain, show, file, and url commands never modify project files. \`/bro btw\` runs sandboxed (read-only) by default; with \`--full\` it can read and edit the workspace, so use \`--full\` only when you want the side conversation to touch your project.
For webpages, it connects directly to the site without browser cookies; the site sees your IP address and Bro's user agent. Do not use private or signed URLs.

Usage and Doctor checks contact Agy but do not send source text or run a model turn. Pressing **C** sends the explanation to your system clipboard.

## Custom prompt

Create or edit \`${PROMPT_FILE}\` and include \`{{response}}\` exactly once. Bro reads it on the next explanation and never modifies it. Existing valid custom prompts continue working unchanged.

A valid custom prompt fully overrides all built-in mode instructions. \`/bro mode\` still changes the saved mode, but that mode remains inactive until you remove or rename \`bro-prompt.md\`. An invalid custom prompt blocks explanations; run \`/bro doctor\` for the exact problem.`;
}

// The overlay framing pattern is adapted from pi-btw (MIT); see THIRD_PARTY_NOTICES.md.
class BroModal implements Focusable {
	focused = false;
	private readonly markdown = new Markdown("", 0, 0, getMarkdownTheme());
	private kind: ModalKind = "loading";
	private rawText = "";
	private sourceLabel = "";
	private notice = "";
	private offset = 0;
	private maxOffset = 0;
	private bodyHeight = 1;
	private copyable = false;
	private retryable = false;
	private disposed = false;
	private htmlPath = "";

	constructor(
		private readonly tui: TuiLike,
		private readonly theme: Theme,
		private readonly onClose: () => void,
		private readonly onRetry: () => void,
		private readonly onDispose: () => void,
		private readonly retryLabel: string,
	) {
		setRegularMouseReporting(this.tui, true);
	}

	setLoading(text = LOADING_TEXT): void {
		this.setContent("loading", `**${text}**`, "", false, false);
	}

	setStreaming(text: string): void {
		this.setContent("streaming", text, "", false, false);
	}

	setResult(text: string, retryable: boolean, notice = "", sourceLabel = "", rawText = text): void {
		this.setContent("result", text, rawText, true, retryable, notice, sourceLabel);
	}

	setHtmlPath(path: string): void {
		this.htmlPath = path;
		this.tui.requestRender();
	}

	setStatic(kind: "help" | "empty", text: string, copyable: boolean): void {
		this.setContent(kind, text, text, copyable, false);
	}

	setError(message: string): void {
		this.setContent("error", `# Bro ran into a problem\n\n${message}`, "", false, true);
	}

	private setContent(
		kind: ModalKind,
		text: string,
		rawText: string,
		copyable: boolean,
		retryable: boolean,
		notice = "",
		sourceLabel = "",
	): void {
		this.kind = kind;
		if (kind !== "result") this.htmlPath = "";
		this.rawText = rawText;
		this.copyable = copyable;
		this.retryable = retryable;
		this.notice = notice;
		this.sourceLabel = stripVTControlCharacters(sourceLabel)
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (kind !== "streaming") this.offset = 0;
		this.markdown.setText(text);
		this.tui.requestRender();
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	private ruleLine(innerWidth: number): string {
		return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
	}

	private controls(): string {
		if (this.kind === "loading") return "Esc cancel";
		if (this.kind === "streaming") return "Simplifying… · ↑/↓ scroll · Esc cancel";
		if (this.kind === "result") {
			return `↑/↓ scroll · C copy${this.htmlPath ? " · O open diagram" : ""}${this.retryable ? ` · R ${this.retryLabel}` : ""} · Esc close`;
		}
		if (this.kind === "help") return "↑/↓ scroll · C copy · Esc close";
		if (this.kind === "error") return "R try again · Esc close";
		return "Esc close";
	}

	render(width: number): string[] {
		const dialogWidth = Math.max(24, width);
		const innerWidth = Math.max(22, dialogWidth - 2);
		const terminalRows = process.stdout.rows ?? 30;
		const dialogHeight = Math.min(32, Math.max(7, Math.floor(terminalRows * 0.78)));
		this.bodyHeight = Math.max(1, dialogHeight - 6);

		const rendered = this.markdown.render(innerWidth);
		this.maxOffset = Math.max(0, rendered.length - this.bodyHeight);
		this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));
		const visible = rendered.slice(this.offset, this.offset + this.bodyHeight);
		const hiddenBelow = Math.max(0, this.maxOffset - this.offset);
		const scroll = this.maxOffset > 0 ? ` · ↑${this.offset} ↓${hiddenBelow}` : "";
		const controls = this.notice ? `${this.notice} · ${this.controls()}` : this.controls();

		const lines = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(this.theme.fg("accent", this.theme.bold(`Bro${this.sourceLabel ? ` · ${this.sourceLabel}` : ""}${scroll}`)), innerWidth),
			this.ruleLine(innerWidth),
		];

		for (const line of visible) lines.push(this.frameLine(line, innerWidth));
		for (let i = visible.length; i < this.bodyHeight; i++) lines.push(this.frameLine("", innerWidth));

		lines.push(this.ruleLine(innerWidth));
		lines.push(this.frameLine(this.theme.fg("dim", controls), innerWidth));
		lines.push(this.borderLine(innerWidth, "bottom"));
		return lines;
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onClose();
			return;
		}

		const delta = wheelDelta(data) || (matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0);
		if (delta) {
			this.offset = Math.max(0, Math.min(this.offset + delta, this.maxOffset));
			this.notice = "";
			this.tui.requestRender();
			return;
		}

		if ((matchesKey(data, "c") || matchesKey(data, "shift+c")) && this.copyable && this.rawText) {
			void copyToClipboard(this.rawText)
				.then(() => {
					if (!this.disposed) {
						this.notice = "Copied";
						this.tui.requestRender();
					}
				})
				.catch((error) => {
					if (!this.disposed) {
						this.notice = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
						this.tui.requestRender();
					}
				});
			return;
		}

		if (
			(matchesKey(data, "r") || matchesKey(data, "shift+r")) &&
			this.retryable &&
			this.kind !== "loading"
		) {
			this.onRetry();
			return;
		}

		if ((matchesKey(data, "o") || matchesKey(data, "shift+o")) && this.htmlPath && this.kind === "result") {
			this.notice = openShowHtml(this.htmlPath)
				? "Opening diagram"
				: `Could not open ${this.htmlPath}`;
			this.tui.requestRender();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		setRegularMouseReporting(this.tui, false);
		this.onDispose();
	}
}

interface BroModalOptions {
	text?: string;
	kind?: "help" | "empty";
	copyable?: boolean;
	result?: ModalResult;
	run?: (
		signal: AbortSignal,
		source?: BroSource,
		onProgress?: (text: string) => void,
	) => Promise<ModalResult>;
	onResult?: (result: ModalResult) => void;
	loadingText?: string;
	retryable?: boolean;
	retryLabel?: string;
}

async function showBroModal(ctx: ExtensionCommandContext, options: BroModalOptions): Promise<void> {
	if (ctx.mode !== "tui") {
		if (options.run && !options.result && options.text === undefined) {
			const result = await options.run(new AbortController().signal);
			options.onResult?.(result);
		}
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let closed = false;
			let controller: AbortController | undefined;
			let current = options.result;
			let execute: (source?: BroSource) => void = () => {};

			const close = () => {
				if (closed) return;
				closed = true;
				controller?.abort();
				done(undefined);
			};

			const modal = new BroModal(
				tui,
				theme,
				close,
				() => execute(current?.source),
				() => {
					closed = true;
					controller?.abort();
				},
				options.retryLabel ?? "simplify again",
			);

			execute = (source?: BroSource) => {
				if (!options.run || controller || closed) return;
				const previous = current;
				const nextController = new AbortController();
				controller = nextController;
				modal.setLoading(options.loadingText);

				void options
					.run(nextController.signal, source, (text) => {
						if (closed || nextController.signal.aborted || controller !== nextController) return;
						modal.setStreaming(text);
					})
					.then((result) => {
						if (closed || nextController.signal.aborted) return;
						current = result;
						options.onResult?.(result);
						const display = result.htmlPath ? stripShowHtmlFence(result.text) : result.text;
						modal.setResult(display, options.retryable ?? true, "", result.source?.label, result.text);
						if (result.htmlPath) modal.setHtmlPath(result.htmlPath);
					})
					.catch((error) => {
						if (closed || nextController.signal.aborted) return;
						const message = error instanceof Error ? error.message : String(error);
						if (previous) {
							current = previous;
							modal.setResult(previous.text, options.retryable ?? true, `Retry failed: ${message}`, previous.source?.label);
						} else {
							modal.setError(message);
						}
					})
					.finally(() => {
						if (controller === nextController) controller = undefined;
					});
			};

			if (options.text !== undefined) {
				modal.setStatic(options.kind ?? "help", options.text, options.copyable ?? false);
			} else if (current) {
				modal.setResult(current.text, options.retryable ?? Boolean(options.run), "", current.source?.label);
			} else {
				execute();
			}

			return modal;
		},
		{
			overlay: true,
			overlayOptions: {
				width: "78%",
				minWidth: 48,
				maxHeight: "78%",
				anchor: "top-center",
				margin: { top: 1, left: 2, right: 2 },
			},
		},
	);
}

export function parseBtwArguments(value: string): { fresh: boolean; full?: boolean; question: string; invalid?: string } {
	let rest = value.trim();
	let fresh = false;
	let full: boolean | undefined;
	while (rest.startsWith("--")) {
		const space = rest.search(/\s/);
		const token = space === -1 ? rest : rest.slice(0, space);
		if (token === "--fresh") fresh = true;
		else if (token === "--full") full = true;
		else if (token === "--sandbox") full = false;
		else return { fresh, full, question: "", invalid: `Unknown /bro btw flag: ${token}` };
		rest = space === -1 ? "" : rest.slice(space).replace(/^\s+/, "");
	}
	return { fresh, full, question: rest };
}

export function resolveBtwThread(existing: BtwThread | undefined, parsed: { fresh: boolean; full?: boolean }): BtwThread {
	const targetFull = parsed.full ?? existing?.full ?? false;
	const startFresh = parsed.fresh || (parsed.full !== undefined && existing !== undefined && existing.full !== parsed.full);
	return !existing || startFresh ? { turns: [], full: targetFull } : existing;
}

export function parseBtwAgyLine(line: string): { delta?: string; result?: string; conversationId?: string; error?: string } {
	let event: AgyEvent;
	try {
		event = JSON.parse(line) as AgyEvent;
	} catch {
		throw new Error("Agy returned invalid streaming data.");
	}
	const conversationId = event.conversation_id ?? event.result?.conversation_id;
	if (event.event === "step_update" && event.step_update?.step_type === "agent_response" && typeof event.step_update.text_delta === "string") {
		return { delta: event.step_update.text_delta, conversationId };
	}
	if (event.event === "result") {
		if (event.result?.status !== "SUCCESS" || typeof event.result.response !== "string") {
			const detail = typeof event.result?.error === "string" ? event.result.error : "Agy did not complete the turn successfully.";
			return { error: detail, conversationId };
		}
		return { result: event.result.response, conversationId };
	}
	return { conversationId };
}

async function runBtwTurn(
	prompt: string,
	selection: ReturnType<typeof agySelection>,
	options: { full: boolean; cwd: string; conversationId?: string },
	signal: AbortSignal,
	onProgress?: (text: string) => void,
): Promise<{ text: string; conversationId?: string }> {
	const runDirectory = options.full ? undefined : await mkdtemp(join(tmpdir(), "pi-bro-"));
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		const args = [
			"--output-format", "stream-json",
			"--disable-slash-commands",
			"--model", selection.model,
			...(selection.effort ? ["--effort", selection.effort] : []),
			"--print-timeout", options.full ? "10m" : "2m",
			...(options.conversationId ? ["--conversation", options.conversationId] : []),
			...(options.full ? ["--dangerously-skip-permissions"] : ["--sandbox"]),
			"--print", prompt,
		];
		const child = spawn("agy", args, {
			cwd: options.full ? options.cwd : runDirectory,
			signal,
			timeout: options.full ? 610_000 : 130_000,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let processError: Error | undefined;
		let stderr = "";
		let partial = "";
		let final = "";
		let conversationId = options.conversationId;
		let parseError: Error | undefined;

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			processError = error;
		});

		const closed = new Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>((resolve) => {
			child.once("close", (code, exitSignal) => resolve({ code, exitSignal }));
		});

		const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
		try {
			for await (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = parseBtwAgyLine(line);
					if (event.conversationId) conversationId = event.conversationId;
					if (event.error) {
						parseError = new Error(event.error);
						child.kill();
						break;
					}
					if (event.delta) {
						partial += event.delta;
						if (onProgress && !updateTimer) {
							updateTimer = setTimeout(() => {
								updateTimer = undefined;
								if (!signal.aborted) onProgress(partial);
							}, 75);
						}
					}
					if (event.result !== undefined) final = event.result;
				} catch (error) {
					parseError = error instanceof Error ? error : new Error(String(error));
					child.kill();
					break;
				}
			}
		} finally {
			lines.close();
		}

		const { code, exitSignal } = await closed;
		if (signal.aborted) throw new Error("Canceled.");
		if (parseError) throw new Error(withDoctor(parseError));
		if (processError) {
			const missing = (processError as NodeJS.ErrnoException).code === "ENOENT";
			throw new Error(
				missing
					? "Agy could not start. Make sure Agy is installed and on PATH, then run `/bro doctor`."
					: `Agy could not start: ${processError.message}\n\nRun \`/bro doctor\` for setup help.`,
			);
		}
		if (exitSignal || code === null) {
			throw new Error("Agy timed out during the side conversation. Run `/bro doctor` for setup help.");
		}
		if (code !== 0) {
			throw new Error(agyFailureMessage("answer the side question", { code, killed: false, stderr }));
		}

		const text = final.trim();
		if (!text) {
			throw new Error(withDoctor(stderr.trim() || "Agy returned no answer for the side question."));
		}

		return { text, conversationId };
	} finally {
		if (updateTimer) clearTimeout(updateTimer);
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
	}
}

class BtwModal implements Focusable {
	private _focused = false;
	private readonly markdown = new Markdown("", 0, 0, getMarkdownTheme());
	private readonly input = new Input();
	private notice = "";
	private offset = 0;
	private maxOffset = 0;
	private bodyHeight = 1;
	private running = false;
	private full = false;
	private disposed = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private readonly tui: TuiLike,
		private readonly theme: Theme,
		private readonly onClose: () => void,
		private readonly onSubmit: (value: string) => void,
		private readonly onDispose: () => void,
	) {
		setRegularMouseReporting(this.tui, true);
		this.input.onSubmit = (value) => {
			if (!this.running) this.onSubmit(value);
		};
	}

	setText(text: string): void {
		this.markdown.setText(text);
		if (!this.running) this.offset = 0;
		this.tui.requestRender();
	}

	setNotice(notice: string): void {
		this.notice = notice;
		this.tui.requestRender();
	}

	setRunning(running: boolean): void {
		this.running = running;
		this.tui.requestRender();
	}

	setFull(full: boolean): void {
		this.full = full;
		this.tui.requestRender();
	}

	clearComposer(): void {
		this.input.setValue("");
		this.tui.requestRender();
	}

	invalidate(): void {
		this.markdown.invalidate();
		this.input.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onClose();
			return;
		}
		const delta = wheelDelta(data) || (matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0);
		if (delta) {
			this.offset = Math.max(0, Math.min(this.offset + delta, this.maxOffset));
			this.notice = "";
			this.tui.requestRender();
			return;
		}
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	private ruleLine(innerWidth: number): string {
		return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
	}

	render(width: number): string[] {
		const dialogWidth = Math.max(24, width);
		const innerWidth = Math.max(22, dialogWidth - 2);
		const terminalRows = process.stdout.rows ?? 30;
		const dialogHeight = Math.min(34, Math.max(8, Math.floor(terminalRows * 0.82)));
		this.bodyHeight = Math.max(1, dialogHeight - 7);

		const rendered = this.markdown.render(innerWidth);
		this.maxOffset = Math.max(0, rendered.length - this.bodyHeight);
		this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));
		const visible = rendered.slice(this.offset, this.offset + this.bodyHeight);
		const hiddenBelow = Math.max(0, this.maxOffset - this.offset);
		const scroll = this.maxOffset > 0 ? ` · ↑${this.offset} ↓${hiddenBelow}` : "";

		const mode = this.full
			? this.theme.fg("accent", this.theme.bold("full · edits repo"))
			: this.theme.fg("dim", "sandbox");
		const header = this.theme.fg("accent", this.theme.bold("Bro · btw")) + this.theme.fg("dim", ` · ${mode}${scroll}`);

		const composer = this.input.render(innerWidth)[0] ?? "";

		const controls = this.running
			? this.theme.fg("dim", "Thinking… · Esc cancel")
			: this.theme.fg("dim", "Enter ask · Esc close · /send · /send all · /clear · /retry");

		const lines = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(header, innerWidth),
			this.ruleLine(innerWidth),
		];
		for (const line of visible) lines.push(this.frameLine(line, innerWidth));
		for (let i = visible.length; i < this.bodyHeight; i++) lines.push(this.frameLine("", innerWidth));
		lines.push(this.ruleLine(innerWidth));
		lines.push(this.frameLine(composer, innerWidth));
		lines.push(this.frameLine(this.notice ? this.theme.fg("accent", this.notice) : controls, innerWidth));
		lines.push(this.borderLine(innerWidth, "bottom"));
		return lines;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		setRegularMouseReporting(this.tui, false);
		this.onDispose();
	}
}

async function openBtwModal(
	ctx: ExtensionCommandContext,
	options: { thread: BtwThread; initialQuestion?: string; seed: boolean },
): Promise<void> {
	const thread = options.thread;

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let closed = false;
			let controller: AbortController | undefined;

			const transcript = () => thread.turns.map((turn) => `## you\n${turn.question}\n\n${turn.answer}`).join("\n\n");

			const close = () => {
				if (closed) return;
				closed = true;
				controller?.abort();
				done(undefined);
			};

			const modal = new BtwModal(tui, theme, close, submit, () => {
				closed = true;
				controller?.abort();
			});

			const runTurn = async (question: string) => {
				if (controller) return;
				const turnController = new AbortController();
				controller = turnController;
				modal.setRunning(true);
				modal.clearComposer();

				const first = thread.turns.length === 0;
				let context: string | undefined;
				if (first && options.seed) {
					const captured = captureShowTranscript(ctx, BTW_CONTEXT_TURNS);
					context = captured?.text;
					if (context && context.length > BTW_CONTEXT_MAX) {
						context = `${context.slice(0, BTW_CONTEXT_MAX)}\n[… context truncated …]`;
					}
				}

				thread.turns.push({ question, answer: "…" });
				modal.setText(transcript());

				try {
					const settings = await readSettings();
					const result = await runBtwTurn(
						buildBtwPrompt(context, question),
						agySelection(settings),
						{ full: thread.full, cwd: ctx.cwd, conversationId: thread.conversationId },
						turnController.signal,
						(partial) => {
							if (closed || turnController.signal.aborted) return;
							thread.turns[thread.turns.length - 1]!.answer = partial;
							modal.setText(transcript());
						},
					);
					if (turnController.signal.aborted) return;
					if (result.conversationId) thread.conversationId = result.conversationId;
					thread.turns[thread.turns.length - 1]!.answer = result.text;
				} catch (error) {
					if (turnController.signal.aborted || closed) return;
					thread.turns[thread.turns.length - 1]!.answer = `_${errorMessage(error)}_`;
					modal.setNotice(errorMessage(error));
				} finally {
					if (controller === turnController) controller = undefined;
					if (!closed) {
						modal.setRunning(false);
						modal.setText(transcript());
					}
				}
			};

			const clear = () => {
				thread.turns = [];
				thread.conversationId = undefined;
				modal.clearComposer();
				modal.setNotice("");
				modal.setText("");
			};

			const retry = () => {
				if (controller) return;
				const last = thread.turns.at(-1);
				if (!last) {
					modal.setNotice("Nothing to retry yet.");
					return;
				}
				thread.turns.pop();
				void runTurn(last.question);
			};

			const handoff = (all: boolean, force: boolean) => {
				const text = all ? transcript() : (thread.turns.at(-1)?.answer ?? "");
				if (!text.trim()) {
					modal.setNotice("Nothing to send yet.");
					return;
				}
				if (ctx.ui.getEditorText().trim() && !force) {
					modal.setNotice("Main editor has a draft. Use /send! (or /send all!) to replace it.");
					return;
				}
				ctx.ui.setEditorText(text);
				modal.setNotice(all ? "Sent the full thread to the editor." : "Sent the latest answer to the editor.");
			};

			function submit(value: string): void {
				const command = value.trim();
				if (command === "/clear") {
					modal.clearComposer();
					clear();
					return;
				}
				if (command === "/send" || command === "/send all" || command === "/send!" || command === "/send all!") {
					modal.clearComposer();
					handoff(command === "/send all" || command === "/send all!", command.endsWith("!"));
					return;
				}
				if (command === "/retry" || command === "") {
					modal.clearComposer();
					retry();
					return;
				}
				void runTurn(command);
			}

			modal.setFull(thread.full);
			modal.setText(transcript());

			if (options.initialQuestion) void runTurn(options.initialQuestion);

			return modal;
		},
		{
			overlay: true,
			overlayOptions: {
				width: "78%",
				minWidth: 48,
				maxHeight: "82%",
				anchor: "top-center",
				margin: { top: 1, left: 2, right: 2 },
			},
		},
	);
}

export default async function bro(pi: ExtensionAPI) {
	let lastResult: BroResult | undefined;
	let btwThread: BtwThread | undefined;
	const remember = (result: ModalResult) => {
		if (result.source) lastResult = { source: result.source, text: result.text };
	};

	pi.on("session_start", async () => {
		lastResult = undefined;
		btwThread = undefined;
	});

	pi.registerCommand("bro", {
		description: "Explain replies, pasted text, documents, and webpages, draw recent session turns, or open a sandboxed side conversation with /bro btw",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = COMMANDS.filter((command) => command.value.startsWith(normalized));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const normalized = raw.toLowerCase();
			const parts = normalized ? normalized.split(/\s+/) : [];
			let action = parts[0] ?? "";
			let value = raw.slice(raw.split(/\s+/, 1)[0]?.length ?? 0).trim();

			// An unknown first word means the whole input is the source: route it by shape.
			if (action && !KNOWN_ACTIONS.has(action)) {
				const candidate = unquote(raw);
				const quoted = candidate !== raw;
				action = quoted || !/\s/.test(candidate)
					? looksLikeWebUrl(candidate)
						? "url"
						: (await isWorkspaceFile(candidate, ctx.cwd))
							? "file"
							: "text"
					: "text";
				value = raw;
			}

			if (action === "show") {
				const { requested, steering, invalid } = parseShowArguments(value);
				if (invalid) {
					ctx.ui.notify("Use /bro show [n-turns] [query].", "warning");
					return;
				}
				const runShow = async (
					signal: AbortSignal,
					source?: BroSource,
					onProgress?: (text: string) => void,
				): Promise<ModalResult> => {
					const captured =
						source ?? captureShowTranscript(ctx, requested ? Number(requested) : (await readSettings()).showTurns);
					if (!captured) {
						return { text: "**Nothing to show yet**\n\nThis session has no conversation turns to draw. Run something first, then press **R**." };
					}
					let text: string;
					try {
						text = await runShowExplanation(ctx.modelRegistry, captured.text, steering, signal, await readSettings(), onProgress);
					} catch (error) {
						throw new Error(withDoctor(error));
					}
					const html = extractShowHtml(text);
					return { source: captured, text, ...(html ? { htmlPath: await writeShowHtml(html) } : {}) };
				};
				try {
					await showBroModal(ctx, {
						loadingText: "Drawing what happened…",
						retryLabel: "show again",
						run: runShow,
						onResult: remember,
					});
				} catch (error) {
					ctx.ui.notify(withDoctor(error), "error");
				}
				return;
			}

			if (action === "file" || action === "url") {
				if (!value) {
					ctx.ui.notify(`Use /bro ${action} <${action === "file" ? "path" : "url"}>.`, "warning");
					return;
				}
				const runInput = async (
					signal: AbortSignal,
					source?: BroSource,
					onProgress?: (text: string) => void,
				): Promise<BroResult> => {
					const target = source ?? (action === "url"
						? await extractWebPage(value, signal)
						: { text: await extractDocumentText(value, ctx.cwd, signal), label: unquote(value) });
					try {
						return {
							source: target,
							text: await simplify(ctx.modelRegistry, target.text, signal, await readSettings(), onProgress),
						};
					} catch (error) {
						throw new Error(withDoctor(error));
					}
				};
				try {
					await showBroModal(ctx, {
						loadingText: action === "url" ? "Fetching and simplifying webpage…" : "Reading and simplifying document…",
						run: runInput,
						onResult: remember,
					});
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
				return;
			}

			if (action === "doctor") {
				if (parts.length !== 1) {
					ctx.ui.notify("Use /bro doctor.", "warning");
					return;
				}
				try {
					await showBroModal(ctx, {
						loadingText: "Checking Bro setup…",
						retryable: true,
						retryLabel: "check again",
						run: async (signal) => {
							const settings = await readSettings();
							if (settings.provider) return { text: providerDoctorReport(ctx.modelRegistry, settings) };
							return { text: await doctorReport(pi, signal) };
						},
					});
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
				return;
			}

			if (action === "usage" || action === "model" || action === "effort") {
				const provider = await readProviderSelection();
				if (provider) {
					ctx.ui.notify(
						`Bro is using provider \`${provider.id}\` · \`${provider.model}\`. Use /bro provider to change it, or /bro provider none to go back to Agy.`,
						"warning",
					);
					return;
				}
			}

			if (action === "usage") {
				const valid = parts.length === 1 || (parts.length === 3 && parts[1] === "--provider" && parts[2] === "agy");
				if (!valid) {
					ctx.ui.notify("Use /bro usage or /bro usage --provider agy.", "warning");
					return;
				}
				try {
					await showBroModal(ctx, {
						loadingText: "Checking Agy usage…",
						retryable: false,
						run: async (signal) => ({ text: await checkAgyUsage(pi, signal) }),
					});
				} catch (error) {
					ctx.ui.notify(withDoctor(error), "error");
				}
				return;
			}

			if (action === "provider") {
				try {
					const settings = await readSettings();
					let selected: ProviderSelection | undefined;
					if (parts[1] === "none") {
						if (parts.length > 2) {
							ctx.ui.notify("Use /bro provider, /bro provider <id> <model>, or /bro provider none.", "warning");
							return;
						}
					} else if (parts.length === 3 && parts[1] && parts[2]) {
						selected = { id: parts[1], model: parts[2] };
					} else if (parts.length > 1) {
						ctx.ui.notify("Use /bro provider, /bro provider <id> <model>, or /bro provider none.", "warning");
						return;
					} else {
						const available = ctx.modelRegistry.getAvailable();
						if (!available.length) {
							const catalogError = ctx.modelRegistry.getError();
							ctx.ui.notify(
								catalogError
									? `No provider models are available: ${catalogError}`
									: "No provider models are available. Add a provider to Pi's models.json first.",
								"warning",
							);
							return;
						}
						const byProvider = new Map<string, string[]>();
						for (const model of available) {
							const list = byProvider.get(model.provider) ?? [];
							list.push(model.id);
							byProvider.set(model.provider, list);
						}
						const ids = [...byProvider.keys()].sort();
						if (ctx.mode !== "tui") {
							ctx.ui.notify(`Providers: ${ids.join(", ")}. Use /bro provider <id> <model>.`, "info");
							return;
						}
						const providerId = await ctx.ui.select("Provider", ids);
						if (!providerId) return;
						const models = (byProvider.get(providerId) ?? []).sort();
						const modelId = models.length === 1 ? models[0] : await ctx.ui.select(`Model for ${providerId}`, models);
						if (!modelId) return;
						selected = { id: providerId, model: modelId };
					}
					const model = selected ? ctx.modelRegistry.find(selected.id, selected.model) : undefined;
					if (selected && !model) {
						ctx.ui.notify(
							`Provider "${selected.id}" has no model "${selected.model}". Run /bro provider to choose one.`,
							"warning",
						);
						return;
					}
					if (selected && model && !ctx.modelRegistry.hasConfiguredAuth(model)) {
						ctx.ui.notify(
							`Provider "${selected.id}" has no credentials for "${selected.model}". Sign in or set its API key, then run /bro doctor.`,
							"warning",
						);
						return;
					}
					const next: BroSettings = { ...settings };
					if (selected) next.provider = selected;
					else delete next.provider;
					await writeSettings(next);
					ctx.ui.notify(
						selected ? `Bro provider: ${selected.id} · ${selected.model}` : "Bro provider: none (using Agy)",
						"info",
					);
				} catch (error) {
					ctx.ui.notify(withDoctor(error), "error");
				}
				return;
			}

			if (action === "mode") {
				const requested = parts[1];
				if (parts.length > 2 || (requested && !parseBroMode(requested))) {
					ctx.ui.notify("Use /bro mode, or choose brief, balanced, or faithful.", "warning");
					return;
				}
				try {
					const settings = await readSettings();
					let selected = parseBroMode(requested);
					if (!selected) {
						if (ctx.mode !== "tui") {
							ctx.ui.notify("Use /bro mode <brief|balanced|faithful> outside Pi's interactive UI.", "warning");
							return;
						}
						const modes = [...BRO_MODES].sort((a, b) => Number(b === settings.mode) - Number(a === settings.mode));
						const choices = modes.map((mode) => `${mode}${mode === settings.mode ? " (current)" : ""}`);
						const choice = await ctx.ui.select(`Bro mode (current: ${settings.mode})`, choices);
						if (!choice) return;
						selected = modes[choices.indexOf(choice)];
					}
					if (!selected) return;
					await writeSettings({ ...settings, mode: selected });
					ctx.ui.notify(`Bro mode: ${selected}`, "info");
				} catch (error) {
					ctx.ui.notify(withDoctor(error), "error");
				}
				return;
			}

			if (action === "model") {
				if (parts.length > 2) {
					ctx.ui.notify("Use /bro model or /bro model <id>.", "warning");
					return;
				}
				try {
					const settings = await readSettings();
					const models = await listAgyModels(pi);
					const current = resolveCatalogSettings(settings, models);
					const requested = parts[1];
					let selected: AgyModelFamily | undefined;
					let selectedEffort: BroEffort | undefined;
					if (requested) {
						selected = models.find((item) => item.id.toLowerCase() === requested);
						if (!selected) {
							for (const family of models) {
								const variant = family.variants.find((item) => item.id.toLowerCase() === requested);
								if (variant) {
									selected = family;
									selectedEffort = variant.effort ?? "default";
									break;
								}
							}
						}
						if (!selected) {
							ctx.ui.notify(`Unknown Agy model "${requested}". Run /bro model to see available choices.`, "warning");
							return;
						}
					} else {
						if (ctx.mode !== "tui") {
							ctx.ui.notify("Use /bro model <id> outside Pi's interactive UI.", "warning");
							return;
						}
						const ordered = [...models].sort((a, b) => Number(b.id === current.family?.id) - Number(a.id === current.family?.id));
						const choices = ordered.map(
							(item) =>
								`${item.id} — ${item.label} · ${item.efforts.length ? item.efforts.join("/") : "fixed effort"}${item.id === current.family?.id ? " (current)" : ""}`,
						);
						const choice = await ctx.ui.select(`Agy model (current: ${current.settings.model})`, choices);
						if (!choice) return;
						selected = ordered[choices.indexOf(choice)];
					}
					if (!selectedEffort) {
						const currentEffort = current.settings.effort;
						const canKeepCurrent =
							current.family?.id === selected.id &&
							(currentEffort === "default" ? !selected.efforts.length : selected.efforts.includes(currentEffort));
						selectedEffort = canKeepCurrent ? currentEffort : preferredEffort(selected);
					}
					await writeSettings({ ...settings, model: selected.id, effort: selectedEffort });
					ctx.ui.notify(
						`Bro model: ${selected.id}${selectedEffort === "default" ? "" : ` (${selectedEffort})`}`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(withDoctor(error), "error");
				}
				return;
			}

			if (action === "effort") {
				const requested = parts[1];
				if (parts.length > 2 || (requested && !EFFORTS.some((effort) => effort === requested))) {
					ctx.ui.notify("Use /bro effort, or choose low, medium, or high.", "warning");
					return;
				}
				try {
					const settings = await readSettings();
					const current = resolveCatalogSettings(settings, await listAgyModels(pi));
					if (!current.family) {
						ctx.ui.notify(`Model "${settings.model}" is not in Agy's current model list. Run /bro model first.`, "warning");
						return;
					}
					if (!current.family.efforts.length) {
						if (requested && requested !== "default") {
							ctx.ui.notify(`${current.family.label} uses a fixed effort level.`, "warning");
							return;
						}
						await writeSettings({ ...current.settings, model: current.family.id, effort: "default" });
						ctx.ui.notify(`${current.family.label} uses its built-in effort level.`, "info");
						return;
					}
					if (requested === "default" || (requested && !current.family.efforts.includes(requested as AgyEffort))) {
						ctx.ui.notify(
							`${current.family.label} supports ${current.family.efforts.join(" or ")} effort.`,
							"warning",
						);
						return;
					}
					let selected = requested as AgyEffort | undefined;
					if (!selected) {
						if (ctx.mode !== "tui") {
							ctx.ui.notify("Use /bro effort <low|medium|high> outside Pi's interactive UI.", "warning");
							return;
						}
						const efforts = [...current.family.efforts].sort(
							(a, b) => Number(b === current.settings.effort) - Number(a === current.settings.effort),
						);
						const choices = efforts.map((effort) => `${effort}${effort === current.settings.effort ? " (current)" : ""}`);
						const choice = await ctx.ui.select(`Agy reasoning effort (current: ${current.settings.effort})`, choices);
						if (!choice) return;
						selected = efforts[choices.indexOf(choice)];
					}
					await writeSettings({ ...current.settings, model: current.family.id, effort: selected });
					ctx.ui.notify(`Bro reasoning effort: ${selected}`, "info");
				} catch (error) {
					ctx.ui.notify(withDoctor(error), "error");
				}
				return;
			}

			if (action === "btw") {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("Use /bro btw in Pi's interactive UI.", "warning");
					return;
				}
				const parsed = parseBtwArguments(value);
				if (parsed.invalid) {
					ctx.ui.notify(parsed.invalid, "warning");
					return;
				}
				try {
					const thread = resolveBtwThread(btwThread, parsed);
					btwThread = thread;
					await openBtwModal(ctx, { thread, initialQuestion: parsed.question, seed: !parsed.fresh });
				} catch (error) {
					ctx.ui.notify(withDoctor(error), "error");
				}
				return;
			}

			if (action === "help") {
				if (parts.length !== 1) {
					ctx.ui.notify("Use /bro help.", "warning");
					return;
				}
				let settings: BroSettings | undefined;
				let settingsError: string | undefined;
				try {
					settings = await readSettings();
				} catch (error) {
					settingsError = errorMessage(error);
				}
				await showBroModal(ctx, { text: helpText(settings, settingsError), kind: "help", copyable: true });
				return;
			}

			const run = async (
				signal: AbortSignal,
				source?: BroSource,
				onProgress?: (text: string) => void,
			): Promise<BroResult> => {
				let target = source ?? (action === "text" && value ? { text: value } : undefined);
				if (!target) {
					await ctx.waitForIdle();
					target = latestAssistant(ctx);
				}
				if (!target) throw new Error("No completed assistant response found.");
				try {
					const settings = await readSettings();
					return {
						source: target,
						text: await simplify(ctx.modelRegistry, target.text, signal, settings, onProgress),
					};
				} catch (error) {
					throw new Error(withDoctor(error));
				}
			};

			if (action === "open") {
				if (parts.length !== 1) {
					ctx.ui.notify("Use /bro open.", "warning");
					return;
				}
				if (!lastResult) {
					await showBroModal(ctx, {
						text: "# Nothing to open yet\n\nUse `/bro text <text>`, run `/bro` after an assistant response, use `/bro file <path>`, use `/bro url <url>`, or run `/bro show` to draw recent turns.",
						kind: "empty",
					});
					return;
				}

				await showBroModal(ctx, {
					result: lastResult,
					run,
					onResult: remember,
				});
				return;
			}

			try {
				await showBroModal(ctx, {
					run,
					onResult: remember,
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	// Keep the command available even when Bro cannot create its settings file; Doctor can then explain the problem.
	await ensureSettingsFile().catch(() => undefined);
}
