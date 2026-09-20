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
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Container, Editor, Input, Markdown, SettingsList, SelectList, Text, matchesKey, truncateToWidth, visibleWidth, type Component, type EditorTheme, type Focusable, type SelectItem, type SettingItem, type TUI } from "@earendil-works/pi-tui";
import { convertToLlm, copyToClipboard, getMarkdownTheme, getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import mammoth from "mammoth";
import { Type } from "typebox";
import { extractText } from "unpdf";
import { BRO_MODES, DEFAULT_BRO_MODE, buildAdvisorPrompt, buildBtwPrompt, buildDefaultPrompt, buildShowPrompt, parseBroMode, type BroMode } from "./prompt.ts";

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
// "advisor" is a real capability (command, Agy invocation, Doctor check) like the other three;
// see docs/plans/2026-09-19-bro-advisor-design.md. All four share one model/effort resolution,
// override, and Doctor-check path via this single list -- there is no configuration-only tier.
const CAPABILITIES = ["explain", "show", "btw", "advisor"] as const;
type Capability = (typeof CAPABILITIES)[number];
const CAPABILITY_LABELS: Record<Capability, string> = { explain: "Explain", show: "Show", btw: "Btw", advisor: "Advisor" };
type ModelEffortPair = { model: string; effort: BroEffort };
type BroSettings = {
	model: string;
	effort: BroEffort;
	mode: BroMode;
	showTurns: number;
	overrides: Partial<Record<Capability, ModelEffortPair>>;
};
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
	{ value: "show", label: "show", description: "Draw what happened in recent session turns as shapes" },
	{ value: "mode", label: "mode", description: "Choose brief, balanced, or faithful explanations" },
	{ value: "btw", label: "btw", description: "Open a side conversation (sandboxed by default; --full edits files)" },
	{ value: "config", label: "config", description: "Configure shared defaults and per-capability model/effort overrides" },
	{ value: "advisor", label: "advisor", description: "Check whether the executor's advisor tool is available right now" },
	{ value: "advisor-steer", label: "advisor-steer", description: "View, edit, save, or clear the advisor's persistent steering brief" },
	{ value: "help", label: "help", description: "Learn what Bro does and what it can access" },
];
const KNOWN_ACTIONS = new Set(COMMANDS.map((command) => command.value));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parseModelEffortPair(value: unknown, context: string): ModelEffortPair {
	if (!isRecord(value) || typeof value.model !== "string" || !value.model.trim() || !EFFORTS.some((effort) => effort === value.effort)) {
		throw new Error(`${context} must contain a model and effort set to "default", "low", "medium", or "high".`);
	}
	return { model: value.model.trim(), effort: value.effort as BroEffort };
}

function parseOverrides(value: unknown): Partial<Record<Capability, ModelEffortPair>> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error("Settings overrides must be an object.");
	const overrides: Partial<Record<Capability, ModelEffortPair>> = {};
	for (const capability of CAPABILITIES) {
		if (value[capability] === undefined) continue;
		overrides[capability] = parseModelEffortPair(value[capability], `Settings overrides.${capability}`);
	}
	return overrides;
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
	const overrides = parseOverrides(value.overrides);
	return { model: value.model.trim(), effort: value.effort as BroSettings["effort"], mode, showTurns, overrides };
}

function capabilityOverride(settings: BroSettings, capability: Capability): ModelEffortPair | undefined {
	return settings.overrides[capability];
}

function capabilityPair(settings: BroSettings, capability: Capability): ModelEffortPair {
	return capabilityOverride(settings, capability) ?? { model: settings.model, effort: settings.effort };
}

// An override always pins both model and effort together (never just one), so a capability's
// setting is either fully inherited or fully its own — no partial-inheritance edge cases.
//
// An override is cleared ONLY by an explicit "Default" selection (pair === undefined), never
// automatically because it happens to match the shared default: a user who deliberately pins a
// capability to the model that currently IS the shared default must keep that pin — unchanged —
// if the shared default is later changed to something else. Silently dropping an override that
// merely coincides with the default would make that pin impossible to express.
export function withCapabilityOverride(
	settings: BroSettings,
	capability: Capability,
	pair: ModelEffortPair | undefined,
): BroSettings {
	const overrides = { ...settings.overrides };
	if (!pair) delete overrides[capability];
	else overrides[capability] = pair;
	return { ...settings, overrides };
}

export function resolveModelEffort(
	pair: ModelEffortPair,
	families: AgyModelFamily[],
): { pair: ModelEffortPair; family?: AgyModelFamily } {
	const family = families.find((item) => item.id === pair.model || item.variants.some((variant) => variant.id === pair.model));
	if (!family) return { pair };
	const variant = family.variants.find((item) => item.id === pair.model);
	return {
		family,
		pair: { model: family.id, effort: pair.effort === "default" && variant?.effort ? variant.effort : pair.effort },
	};
}

function resolveCapabilitySettings(
	settings: BroSettings,
	capability: Capability,
	families: AgyModelFamily[],
): { pair: ModelEffortPair; family?: AgyModelFamily } {
	return resolveModelEffort(capabilityPair(settings, capability), families);
}

// The steering brief is stored as a session `custom` entry — extension state that never
// participates in LLM context (see docs/plans/2026-09-19-bro-advisor-design.md). Writes go
// through pi.appendEntry(); ctx.sessionManager is read-only and has no append methods.
//
// bro_advisor has no on/off activation state: it is registered once at extension load like any
// other tool and never gated via pi.setActiveTools(). Whether the executor can call it is purely a
// function of this host's own tool restrictions (pi.getAllTools() / pi.getActiveTools()), which
// this code only ever reads, never overrides. A session may still carry historical
// "bro-advisor-active" entries from before this simplification; they are silently ignored.
const ADVISOR_STEERING_ENTRY = "bro-advisor-steering";
export const ADVISOR_TOOL_NAME = "bro_advisor";
// setStatus() key for mirroring live advisor progress to the footer/status bar -- see the execute()
// handler below for why this fallback surface exists alongside onUpdate's tool-card renderResult.
const ADVISOR_STATUS_BAR_KEY = "bro-advisor";
const ADVISOR_COMPATIBILITY = "Pi >=0.84.2; Agy >=1.1.15";

export type AdvisorState = { steering: string };

// getBranch() walks root-to-leaf (see latestAssistant above for the same convention), so a forward
// scan taking the last match of ADVISOR_STEERING_ENTRY resolves "latest wins". Forking clones the
// branch's entries into a new session file, so this same resolution gives fork inheritance and
// independent post-fork edits for free, with no special-case fork logic.
export function resolveAdvisorState(branch: readonly SessionEntry[]): AdvisorState {
	let steering = "";
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== ADVISOR_STEERING_ENTRY) continue;
		if (isRecord(entry.data) && typeof entry.data.text === "string") steering = entry.data.text;
	}
	return { steering };
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

// Exported so persistence stays testable without touching the filesystem. This only ever omits
// the `overrides` key itself when there are no overrides at all — it does NOT deduplicate or drop
// any individual override that happens to match the shared default; see withCapabilityOverride
// for why an explicit override is always kept until the user clears it back to "Default".
export function settingsPayload(settings: BroSettings): Record<string, unknown> {
	const { overrides, ...rest } = settings;
	return Object.keys(overrides).length ? { ...rest, overrides } : rest;
}

async function writeSettings(settings: BroSettings): Promise<void> {
	// ponytail: last writer wins across concurrent Pi processes; add locking only if that becomes a common workflow.
	await writeFile(SETTINGS_FILE, `${JSON.stringify(settingsPayload(settings), null, 2)}\n`, "utf8");
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

export function advisorAgyCompatible(version: string): boolean | undefined {
	const match = /(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(version);
	if (!match) return undefined;
	const installed = match.slice(1, 4).map(Number);
	const minimum = [1, 1, 15];
	for (let index = 0; index < minimum.length; index++) {
		if (installed[index]! !== minimum[index]!) return installed[index]! > minimum[index]!;
	}
	return true;
}

function resolveCatalogSettings(
	settings: BroSettings,
	families: AgyModelFamily[],
): { settings: BroSettings; family?: AgyModelFamily } {
	const resolved = resolveModelEffort({ model: settings.model, effort: settings.effort }, families);
	if (!resolved.family) return { settings };
	return { family: resolved.family, settings: { ...settings, ...resolved.pair } };
}

function preferredEffort(family: AgyModelFamily): BroEffort {
	return family.efforts.includes("low") ? "low" : (family.efforts[0] ?? "default");
}

export function agySelection(pair: ModelEffortPair): { model: string; effort?: AgyEffort } {
	if (pair.effort === "default") return { model: pair.model };
	const suffix = (["low", "medium", "high"] as const).find((effort) => pair.model.endsWith(`-${effort}`));
	return {
		model: suffix ? pair.model.slice(0, -suffix.length - 1) : pair.model,
		effort: pair.effort,
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

async function doctorReport(pi: ExtensionAPI, ctx: ExtensionCommandContext, signal: AbortSignal): Promise<string> {
	const lines: string[] = [];
	let failed = false;
	let settings: BroSettings | undefined;
	let models: AgyModelFamily[] | undefined;
	let agyVersion: string | undefined;
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
		agyVersion = await checkAgyVersion(pi, signal);
		pass("Agy", agyVersion);
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

		for (const capability of CAPABILITIES) {
			const label = CAPABILITY_LABELS[capability];
			const override = capabilityOverride(settings, capability);
			const resolved = resolveCapabilitySettings(settings, capability, models);
			if (!resolved.family) {
				fail(label, `\`${resolved.pair.model}\` is unavailable. Run \`/bro config\` to fix this override.`);
				continue;
			}
			const effortOk = !resolved.family.efforts.length
				? resolved.pair.effort === "default"
				: resolved.pair.effort !== "default" && resolved.family.efforts.includes(resolved.pair.effort);
			if (!effortOk) {
				fail(label, `\`${resolved.pair.effort}\` is unsupported for \`${resolved.family.id}\`. Run \`/bro config\` to fix this.`);
				continue;
			}
			pass(
				label,
				override
					? `override \`${resolved.family.id}\`${resolved.pair.effort === "default" ? "" : ` (${resolved.pair.effort})`}`
					: "using the shared default",
			);
		}
	}

	// bro_advisor has no on/off preference to compare against -- it is only ever gated by this
	// host's own tool restrictions, which this reads via pi.getAllTools()/pi.getActiveTools() and
	// never overrides. Exposed-but-inactive is the one genuine anomaly worth failing on.
	const advisorExposed = pi.getAllTools().some((tool) => tool.name === ADVISOR_TOOL_NAME);
	const advisorActive = pi.getActiveTools().includes(ADVISOR_TOOL_NAME);
	if (advisorExposed && !advisorActive) fail("Advisor tool", "bro_advisor is exposed but not active in this session. Run /reload.");
	else pass("Advisor tool", advisorExposed ? "bro_advisor is exposed and active" : "bro_advisor is not exposed by this host (tool restriction, or the extension has not finished loading)");
	pass("Advisor steering", resolveAdvisorState(ctx.sessionManager.getBranch()).steering.trim() ? "present" : "none");
	if (agyVersion && advisorAgyCompatible(agyVersion)) pass("Advisor compatibility", ADVISOR_COMPATIBILITY);
	else if (agyVersion) fail("Advisor compatibility", `installed \`${agyVersion}\`; requires Agy >=1.1.15. Run \`agy update\`.`);

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

async function simplify(
	response: string,
	signal: AbortSignal,
	settings: BroSettings,
	onProgress?: (text: string) => void,
): Promise<string> {
	return runAgyText((await promptFor(response, settings.mode)).text, agySelection(capabilityPair(settings, "explain")), signal, onProgress);
}

async function runShowExplanation(
	transcript: string,
	steering: string,
	signal: AbortSignal,
	settings: BroSettings,
	onProgress?: (text: string) => void,
): Promise<string> {
	return runAgyText(buildShowPrompt(transcript, steering), agySelection(capabilityPair(settings, "show")), signal, onProgress);
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

// Harness-neutral advisor context snapshot: plain role/text/tool-name+args/tool-result-text, not
// Pi's internal message objects serialized as-is, so the shape isn't a Pi-specific contract. Every
// piece of free-text message content is JSON-quoted (the same "quote the source as data" convention
// SOURCE_GUARD/buildShowPrompt/buildBtwPrompt already use in prompt.ts) rather than pasted in raw
// after a bare "## role" heading: unquoted text under a heading would let pasted text or tool output
// forge a fake "## user"/"## assistant" section that looks like a real turn boundary. See
// docs/plans/2026-09-19-bro-advisor-design.md, "Context snapshot".
type AdvisorMessageLike = { role?: unknown; content?: unknown; toolName?: unknown; toolCallId?: unknown; isError?: unknown };

// Parameter element type of Pi's own AgentMessage → LLM converter (core/messages.ts), reused below
// instead of redeclaring BashExecutionMessage's shape (it isn't exported from the package root).
type AdvisorAgentMessage = Parameters<typeof convertToLlm>[0][number];

function advisorQuoted(text: string): string {
	return JSON.stringify(text);
}

// `resolvedToolCallIds` lets a still-pending bro_advisor call (the one currently in flight for this
// very consultation, which by definition has no result yet) be dropped instead of rendered as an
// orphaned, unresolved call — a past, completed bro_advisor call is unaffected and renders normally.
function advisorContentText(content: unknown, resolvedToolCallIds: ReadonlySet<string>): string {
	if (typeof content === "string") {
		const text = content.trim();
		return text ? advisorQuoted(text) : "";
	}
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const type = (part as { type?: string }).type;
		if (type === "text" && typeof (part as { text?: unknown }).text === "string") {
			const text = (part as { text: string }).text.trim();
			if (text) parts.push(advisorQuoted(text));
		} else if (type === "image") {
			parts.push("[image omitted]");
		} else if (type === "thinking") {
			parts.push("[reasoning omitted]");
		} else if (type === "toolCall") {
			const call = part as { id?: unknown; name?: unknown; arguments?: unknown };
			const id = typeof call.id === "string" ? call.id : undefined;
			const name = typeof call.name === "string" ? call.name : "(unknown)";
			if (name === ADVISOR_TOOL_NAME && (!id || !resolvedToolCallIds.has(id))) continue;
			parts.push(`[tool call${id ? ` #${id}` : ""}] ${name}(${JSON.stringify(call.arguments ?? {})})`);
		}
	}
	return parts.join("\n").trim();
}

function renderAdvisorMessage(message: AdvisorMessageLike, resolvedToolCallIds: ReadonlySet<string>): string {
	if (message.role === "user") {
		const text = advisorContentText(message.content, resolvedToolCallIds);
		return text ? `## user\n${text}` : "";
	}
	if (message.role === "assistant") {
		const text = advisorContentText(message.content, resolvedToolCallIds);
		return text ? `## assistant\n${text}` : "";
	}
	if (message.role === "toolResult") {
		const name = typeof message.toolName === "string" ? message.toolName : "(unknown)";
		const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
		const header = `## tool result${id ? ` [#${id}]` : ""}: ${name}${message.isError ? " · error" : ""}`;
		const text = advisorContentText(message.content, resolvedToolCallIds);
		return text ? `${header}\n${text}` : header;
	}
	if (message.role === "bashExecution") {
		// Reuse Pi's own AgentMessage -> LLM conversion instead of hand-rolling one: it already
		// drops a command run with the `!!` prefix (excludeFromContext) and formats the rest exactly
		// as Pi's own context builder would, so a `!`-run command an executor can see is not silently
		// missing from what the advisor sees.
		const [converted] = convertToLlm([message as AdvisorAgentMessage]);
		if (!converted) return "";
		const text = advisorContentText(converted.content, resolvedToolCallIds);
		return text ? `## bash execution\n${text}` : "";
	}
	return "";
}

export function buildAdvisorSnapshot(ctx: ExtensionContext, pi: ExtensionAPI): { text: string; hadCompaction: boolean } {
	const systemPrompt = ctx.getSystemPrompt().trim();

	const activeToolNames = new Set(pi.getActiveTools().filter((name) => name !== ADVISOR_TOOL_NAME));
	const tools = pi.getAllTools().filter((tool) => activeToolNames.has(tool.name)).sort((a, b) => a.name.localeCompare(b.name));
	// No truncation of tool descriptions: Bro imposes no size cap on the snapshot (see the design
	// doc) and an arbitrary slice would silently drop part of a tool's actual behavior contract.
	const toolsSection = tools.length
		? tools.map((tool) => `- ${tool.name}: ${tool.description.replace(/\s+/g, " ").trim()}`).join("\n")
		: "(none)";

	const entries = ctx.sessionManager.buildContextEntries();
	const resolvedToolCallIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as AdvisorMessageLike;
		if (message.role === "toolResult" && typeof message.toolCallId === "string") resolvedToolCallIds.add(message.toolCallId);
	}

	const lines: string[] = [];
	// Tracked from the actual entry type, not a substring search over the rendered snapshot text --
	// free-text content (a file the executor read, a pasted paragraph) is JSON-quoted but not
	// stripped of "#", so a substring check could be forged by source data that happens to contain
	// the literal heading text. Only a real `compaction` entry may set this.
	let hadCompaction = false;
	for (const entry of entries) {
		if (entry.type === "message") {
			const rendered = renderAdvisorMessage(entry.message as AdvisorMessageLike, resolvedToolCallIds);
			if (rendered) lines.push(rendered);
		} else if (entry.type === "compaction") {
			// buildContextEntries() already includes every real entry after the compaction point;
			// the summary is all there is to represent for what it replaced.
			hadCompaction = true;
			lines.push(`## compacted earlier context\n${advisorQuoted(entry.summary)}`);
		} else if (entry.type === "branch_summary") {
			lines.push(`## abandoned branch summary\n${advisorQuoted(entry.summary)}`);
		} else if (entry.type === "custom_message") {
			const text = advisorContentText(entry.content, resolvedToolCallIds);
			if (text) lines.push(`## extension message: ${entry.customType}\n${text}`);
		}
		// "custom" entries (including our own advisor activation/steering state) are intentionally
		// skipped — they never participate in LLM context and must not leak into the snapshot either.
	}
	const conversationSection = lines.length ? lines.join("\n\n") : "(no conversation content captured)";

	const text = `## Executor's system instructions\n\n${systemPrompt ? advisorQuoted(systemPrompt) : "(none)"}\n\n## Executor's active tools\n\n${toolsSection}\n\n## Conversation so far (message text is quoted as JSON strings; includes tool calls and results, correlated by call id; image and reasoning content is noted but omitted; the still-pending advisor call for this very consultation is omitted)\n\n${conversationSection}`;
	return { text, hadCompaction };
}

// Advisor stdin/stream-json transport, confirmed against pi-flow-external's tested agy backend
// (src/core/agy.ts, test/agy-backend.test.ts): --input-format stream-json reads one NDJSON
// "user" message from stdin instead of a --print argv value (unbounded snapshot size would
// otherwise risk ARG_MAX), and --dangerously-skip-permissions gives the advisor real, unprompted
// tool access. See docs/plans/2026-09-19-bro-advisor-design.md, "Transport".
type AdvisorAgyEvent = {
	event?: string;
	step_update?: { tool_name?: unknown; step_type?: unknown; text_delta?: unknown };
	result?: { status?: unknown; response?: unknown; error?: unknown };
};

// Guards only against a single runaway line with no newline (a protocol break, not a real
// response size) — agy's real NDJSON lines are far smaller than this.
const ADVISOR_MAX_STDOUT_LINE_CHARS = 2_000_000;

function parseAdvisorLine(line: string): AdvisorAgyEvent {
	try {
		return JSON.parse(line) as AdvisorAgyEvent;
	} catch {
		throw new Error("Agy emitted invalid stream-json output.");
	}
}

// Only a tool_name or a user-facing agent_response/assistant text_delta becomes an activity label
// -- hidden reasoning/thinking step_types and any other shape stay unreported, never leaked into
// progress.
function advisorActivityFromEvent(event: AdvisorAgyEvent): string | undefined {
	if (event.event !== "step_update" || !event.step_update || typeof event.step_update !== "object") return undefined;
	const update = event.step_update;
	if (typeof update.tool_name === "string" && update.tool_name.trim()) return update.tool_name.trim();
	const isUserFacingText = update.step_type === "agent_response" || update.step_type === "assistant";
	if (isUserFacingText && typeof update.text_delta === "string" && update.text_delta.trim()) {
		return update.text_delta.split("\n").find((line) => line.trim())?.trim();
	}
	return undefined;
}

const MAX_ADVISOR_ACTIVITY_LINES = 4;
const ADVISOR_ACTIVITY_PREVIEW_CHARS = 100;

function advisorActivityPreview(label: string): string {
	return label.length > ADVISOR_ACTIVITY_PREVIEW_CHARS ? `${label.slice(0, ADVISOR_ACTIVITY_PREVIEW_CHARS).trimEnd()}…` : label;
}

// Older agy CLIs reject --input-format with Go's flag-package usage dump and exit before running
// the agent at all (no terminal result event). Turn that into an actionable version hint instead
// of a bare "no terminal result" error.
export function advisorFlagErrorHint(stderr: string): string | undefined {
	const match = /flags? provided but not defined: -([a-z0-9-]+)/i.exec(stderr);
	if (!match) return undefined;
	return `flag provided but not defined: -${match[1]} (installed Agy CLI is too old; the advisor needs Agy 1.1.15+ for --input-format stream-json — run \`agy update\`, then \`/bro doctor\`)`;
}

export type AdvisorActivityCallback = (label: string, timestamp: number) => void;

export async function runAdvisorConsultation(
	prompt: string,
	selection: ReturnType<typeof agySelection>,
	cwd: string,
	signal: AbortSignal,
	killEscalationMs = 5_000,
	onActivity?: AdvisorActivityCallback,
): Promise<string> {
	const child = spawn(
		"agy",
		[
			"--dangerously-skip-permissions",
			"--disable-slash-commands",
			"--output-format", "stream-json",
			"--input-format", "stream-json",
			"--model", selection.model,
			...(selection.effort ? ["--effort", selection.effort] : []),
			"--print-timeout", "10m",
		],
		{ cwd, timeout: 610_000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
	);

	let processError: Error | undefined;
	let stderr = "";
	let final: string | undefined;
	let terminalError: string | undefined;
	let protocolError: string | undefined;
	let sawTerminal = false;
	let stdoutBuffer = "";

	// Relying on spawn({signal}) alone only ever sends one SIGTERM and gives up if the child (or a
	// misbehaving grandchild it spawned) ignores it, hanging this promise forever. Escalate to
	// SIGKILL -- which cannot be ignored -- if the child hasn't exited shortly after.
	let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => {
		child.kill("SIGTERM");
		killEscalationTimer = setTimeout(() => {
			child.kill("SIGKILL");
		}, killEscalationMs);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.once("error", (error) => {
		processError = error;
	});
	child.stdin.on("error", () => {
		// agy exiting before it reads stdin is reported through the close/error path below.
	});
	child.stdin.end(`${JSON.stringify({ event: "user", message: { content: prompt } })}\n`);

	const handleLine = (line: string) => {
		if (!line.trim() || sawTerminal) return;
		const event = parseAdvisorLine(line);
		const activity = advisorActivityFromEvent(event);
		if (activity) onActivity?.(activity, Date.now());
		if (event.event !== "result") return;
		sawTerminal = true;
		const result = event.result;
		const status = typeof result?.status === "string" ? result.status.trim().toUpperCase() : undefined;
		if (status === "SUCCESS" && typeof result?.response === "string") {
			final = result.response;
		} else {
			const detail = typeof result?.error === "string" && result.error.trim() ? `: ${result.error.trim()}` : "";
			terminalError = `Agy failed with status ${status ?? "(missing)"}${detail}`;
		}
	};

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdoutBuffer += chunk;
		const parts = stdoutBuffer.split(/\r?\n/);
		stdoutBuffer = parts.pop() ?? "";
		if (stdoutBuffer.length > ADVISOR_MAX_STDOUT_LINE_CHARS || parts.some((line) => line.length > ADVISOR_MAX_STDOUT_LINE_CHARS)) {
			protocolError ??= `Agy emitted a stdout line over ${ADVISOR_MAX_STDOUT_LINE_CHARS} characters; the stream is unparseable.`;
			stdoutBuffer = "";
			child.kill();
			return;
		}
		for (const line of parts) {
			try {
				handleLine(line);
			} catch (error) {
				protocolError ??= errorMessage(error);
				child.kill();
				return;
			}
		}
	});

	const { code, exitSignal } = await new Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>((resolve) => {
		child.once("close", (code, exitSignal) => {
			if (stdoutBuffer.trim() && !sawTerminal) {
				try {
					handleLine(stdoutBuffer);
				} catch (error) {
					protocolError ??= errorMessage(error);
				}
			}
			resolve({ code, exitSignal });
		});
	});
	signal.removeEventListener("abort", onAbort);
	if (killEscalationTimer) clearTimeout(killEscalationTimer);

	if (signal.aborted) throw new Error("Canceled.");
	if (protocolError) throw new Error(withDoctor(protocolError));
	if (processError) {
		const missing = (processError as NodeJS.ErrnoException).code === "ENOENT";
		throw new Error(
			missing
				? "Agy could not start. Make sure Agy is installed and on PATH, then run `/bro doctor`."
				: `Agy could not start: ${processError.message}\n\nRun \`/bro doctor\` for setup help.`,
		);
	}
	if (exitSignal || code === null) {
		throw new Error("Agy timed out during the advisor consultation. Run `/bro doctor` for setup help.");
	}
	if (!sawTerminal) {
		const hint = advisorFlagErrorHint(stderr);
		throw new Error(withDoctor(hint ?? (stderr.trim() ? `Agy exited without a terminal result event: ${stderr.trim()}` : "Agy exited without a terminal result event.")));
	}
	if (terminalError) throw new Error(withDoctor(terminalError));
	if (code !== 0) throw new Error(agyFailureMessage("complete the advisor consultation", { code, killed: false, stderr }));

	const text = final?.trim();
	if (!text) throw new Error(withDoctor(stderr.trim() || "Agy returned no advice."));
	return text;
}

function advisorDelay(ms: number, signal: AbortSignal, onTick?: (remainingMs: number) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Canceled."));
			return;
		}
		const startedAt = Date.now();
		const interval = onTick ? setInterval(() => onTick(Math.max(0, ms - (Date.now() - startedAt))), 1_000) : undefined;
		interval?.unref();
		const cleanup = () => {
			clearTimeout(timer);
			if (interval) clearInterval(interval);
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error("Canceled."));
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export type AdvisorConsult = (
	prompt: string,
	selection: ReturnType<typeof agySelection>,
	cwd: string,
	signal: AbortSignal,
	killEscalationMs?: number,
	onActivity?: AdvisorActivityCallback,
) => Promise<string>;
export type AdvisorDelayFn = (ms: number, signal: AbortSignal, onTick?: (remainingMs: number) => void) => Promise<void>;
export type AdvisorToolDetails = {
	status: "investigating" | "retrying" | "done";
	attempt: number;
	of: number;
	elapsedMs: number;
	error?: string;
	retryInMs?: number;
	model?: string;
	effort?: string;
	durationMs?: number;
	cwd?: string;
	steeringIncluded?: boolean;
	snapshotChars?: number;
	broTruncated?: false;
	omissions?: string;
	// Real Agy-reported activity for the current attempt only -- reset to empty whenever a new
	// attempt (including a retry) starts, never carried over from a prior failed attempt.
	activity?: string[];
	lastActivityAt?: number;
	// Total count of accepted activity events (tool calls AND user-facing text deltas -- "activity"
	// is the honest label, not "tool calls") observed across the whole consultation, including every
	// retry attempt. Unlike `activity` above, this never resets on a retry; the final "done" details
	// carry the same running total.
	activityCount?: number;
};
export type AdvisorProgressCallback = (details: AdvisorToolDetails) => void;
export type AdvisorRunResult = { advice: string; attempts: number; durationMs: number; activityCount: number };

// Bursts of chunked NDJSON activity events are coalesced to this cadence so a fast stream of tool
// calls/text deltas doesn't flood onProgress; the 1s elapsed-time heartbeat below is unaffected and
// keeps ticking independently.
const ADVISOR_ACTIVITY_THROTTLE_MS = 250;

// `consult`/`delayFn` are injectable so tests can swap in a fake agy spawn and a fake clock
// instead of spawning real processes and waiting 15 real seconds. Every attempt sends the
// identical prompt/selection/cwd to a fresh, standalone Agy process — never resumed via
// --conversation, even across retries.
export async function runAdvisorWithRetries(
	prompt: string,
	selection: ReturnType<typeof agySelection>,
	cwd: string,
	signal: AbortSignal,
	consult: AdvisorConsult = runAdvisorConsultation,
	delayFn: AdvisorDelayFn = advisorDelay,
	onProgress?: AdvisorProgressCallback,
	progressIntervalMs = 1_000,
	activityThrottleMs = ADVISOR_ACTIVITY_THROTTLE_MS,
): Promise<AdvisorRunResult> {
	const delays = [5_000, 10_000];
	const totalAttempts = delays.length + 1;
	const startedAt = Date.now();
	let lastError: unknown;
	// Cumulative across every attempt in this consultation, including retries -- unlike `activity`
	// below, a retry must never reset this back to zero.
	let totalActivityCount = 0;
	for (let attempt = 0; attempt <= delays.length; attempt++) {
		if (signal.aborted) throw new Error("Canceled.");
		// Fresh per attempt: a retry must never show the previous attempt's activity trail.
		const activity: string[] = [];
		let lastActivityAt: number | undefined;
		let lastActivityEmitAt = 0;
		let pendingActivityTimer: ReturnType<typeof setTimeout> | undefined;

		const running = (): AdvisorToolDetails => ({
			status: "investigating",
			attempt: attempt + 1,
			of: totalAttempts,
			elapsedMs: Date.now() - startedAt,
			activity: [...activity],
			lastActivityAt,
			activityCount: totalActivityCount,
		});
		const emitRunning = () => onProgress?.(running());
		emitRunning();
		const progressTimer = onProgress ? setInterval(emitRunning, progressIntervalMs) : undefined;
		progressTimer?.unref();

		const stopActivityThrottle = () => {
			if (pendingActivityTimer) {
				clearTimeout(pendingActivityTimer);
				pendingActivityTimer = undefined;
			}
		};
		const onActivity: AdvisorActivityCallback = (label, timestamp) => {
			const normalized = label.replace(/\s+/g, " ").trim();
			if (!normalized) return;
			activity.push(normalized);
			if (activity.length > MAX_ADVISOR_ACTIVITY_LINES) activity.splice(0, activity.length - MAX_ADVISOR_ACTIVITY_LINES);
			totalActivityCount += 1;
			lastActivityAt = timestamp;
			if (!onProgress) return;
			const elapsed = Date.now() - lastActivityEmitAt;
			if (elapsed >= activityThrottleMs) {
				lastActivityEmitAt = Date.now();
				emitRunning();
				return;
			}
			if (!pendingActivityTimer) {
				pendingActivityTimer = setTimeout(() => {
					pendingActivityTimer = undefined;
					lastActivityEmitAt = Date.now();
					emitRunning();
				}, activityThrottleMs - elapsed);
				pendingActivityTimer.unref?.();
			}
		};

		try {
			const advice = await consult(prompt, selection, cwd, signal, undefined, onActivity);
			// `totalActivityCount` is read directly here rather than from the last onProgress snapshot,
			// which may lag behind by up to `activityThrottleMs` -- the final count must be exact.
			return { advice, attempts: attempt + 1, durationMs: Date.now() - startedAt, activityCount: totalActivityCount };
		} catch (error) {
			if (progressTimer) clearInterval(progressTimer);
			stopActivityThrottle();
			if (signal.aborted || errorMessage(error) === "Canceled.") throw error;
			lastError = error;
			if (attempt === delays.length) break;
			const delay = delays[attempt]!;
			const retrying = (remainingMs: number): AdvisorToolDetails => ({
				status: "retrying",
				attempt: attempt + 2,
				of: totalAttempts,
				elapsedMs: Date.now() - startedAt,
				error: errorMessage(error),
				retryInMs: remainingMs,
				activityCount: totalActivityCount,
			});
			onProgress?.(retrying(delay));
			await delayFn(delay, signal, (remainingMs) => onProgress?.(retrying(remainingMs)));
		} finally {
			if (progressTimer) clearInterval(progressTimer);
			stopActivityThrottle();
		}
	}
	throw lastError;
}

export function advisorAttemptLabel(details: AdvisorToolDetails): string {
	if (details.status === "retrying") {
		return `Bro advisor · retrying in ${Math.ceil((details.retryInMs ?? 0) / 1_000)}s · attempt ${details.attempt}/${details.of}${details.error ? ` — ${details.error}` : ""}`;
	}
	if (details.status === "done") {
		return `Bro advisor · ${details.model ?? "unknown model"} · ${details.attempt} attempt${details.attempt === 1 ? "" : "s"} · ${Math.ceil((details.durationMs ?? details.elapsedMs) / 1_000)}s`;
	}
	const latest = details.activity?.at(-1);
	// "last reported" + freshness, never a claim about what Agy is doing right now and never
	// "stalled" -- silence since lastActivityAt is not itself evidence of a stuck run.
	const activityLabel = latest
		? `last reported: ${advisorActivityPreview(latest)} (${Math.max(0, Math.floor((Date.now() - (details.lastActivityAt ?? Date.now())) / 1_000))}s ago)`
		: "awaiting first activity from Agy";
	return `Bro advisor · running · ${Math.floor(details.elapsedMs / 1_000)}s · attempt ${details.attempt}/${details.of} · ${activityLabel}`;
}

const SHOW_TURNS_PRESETS = [1, 2, 3, 5, 8];

function showTurnsValues(current: number): string[] {
	return [...new Set([...SHOW_TURNS_PRESETS, current])].sort((a, b) => a - b).map(String);
}

// A resolved pair's display string: distinguishes a model that is genuinely fixed-effort from
// one that simply isn't in the current catalog (both used to render as "fixed", which read as
// falsely healthy for an unavailable model), and flags a stored effort that isn't one of the
// resolved family's supported efforts instead of silently showing it as if it were valid.
function effortDisplay(resolved: { pair: ModelEffortPair; family?: AgyModelFamily }): string {
	if (!resolved.family) return "unavailable";
	const fixed = !resolved.family.efforts.length;
	const valid = fixed ? resolved.pair.effort === "default" : resolved.family.efforts.includes(resolved.pair.effort as AgyEffort);
	if (!valid) return `${resolved.pair.effort} (unsupported)`;
	return fixed ? "fixed" : resolved.pair.effort;
}

// Testable core: takes settings/catalog/persist as plain arguments so smoke tests can drive
// the exact interaction (submenus, cancel, cycling, save failure) without a real Agy process
// or settings file. showBroConfigModal below wires this to the real ctx/pi/filesystem.
export function createConfigModal(
	initialSettings: BroSettings,
	families: AgyModelFamily[],
	persistSettings: (settings: BroSettings) => Promise<void>,
): (tui: TuiLike, theme: Theme, keybindings: unknown, done: (value?: void) => void) => Component & { dispose?(): void } {
	return (tui, theme, _keybindings, done) => {
		let settings = initialSettings;
		// The last settings actually confirmed on disk. A failed save reverts `settings` (and the
		// whole displayed row set) back to this, so the screen never shows state that doesn't exist.
		let savedSettings = initialSettings;
		// Only one persistSettings call is ever in flight. A change that arrives while one is
		// already running is coalesced into `queued` (overwriting any earlier queued change) rather
		// than firing a second concurrent write — this is what keeps writes serialized and makes
		// sure the on-disk file always converges on the latest intent instead of a stale one that
		// happened to finish last.
		let saving = false;
		let queued: BroSettings | undefined;
		// Esc while a save is in flight must not close past an unshown result: it requests a close
		// that only actually happens once the in-flight (and any coalesced) save has settled, and
		// only if it succeeded — a failure cancels the pending close so its notice stays visible.
		let closeRequested = false;

		const findFamily = (modelId: string) =>
			families.find((item) => item.id === modelId || item.variants.some((variant) => variant.id === modelId));

		const modelPicker = (current: string, pickerDone: (value?: string) => void, capability?: Capability) => {
			const defaultResolved = resolveModelEffort({ model: settings.model, effort: settings.effort }, families);
			const options: SelectItem[] = [
				...(capability ? [{ value: "__default__", label: `Default (${defaultResolved.family?.label ?? settings.model})` }] : []),
				...families.map((family) => ({
					value: family.id,
					label: `${family.label}${family.efforts.length ? "" : " · fixed effort"}`,
				})),
			];
			const picker = new SelectList(options, Math.min(options.length, 8), getSelectListTheme());
			const selectedIndex = capability && current === "Default" ? 0 : options.findIndex((option) => option.value === current);
			picker.setSelectedIndex(Math.max(0, selectedIndex));
			picker.onSelect = (item) => pickerDone(item.value);
			picker.onCancel = () => pickerDone();
			return picker;
		};

		const modelItem: SettingItem = { id: "model", label: "Default model", currentValue: settings.model, submenu: modelPicker };
		const effortItem: SettingItem = { id: "effort", label: "Default effort", currentValue: "" };
		const modeItem: SettingItem = { id: "mode", label: "Explain mode", currentValue: settings.mode, values: [...BRO_MODES] };
		const showTurnsItem: SettingItem = {
			id: "showTurns",
			label: "Show turns",
			currentValue: String(settings.showTurns),
			values: showTurnsValues(settings.showTurns),
		};
		const capabilityItems = Object.fromEntries(
			CAPABILITIES.map((capability) => [
				capability,
				{
					model: {
						id: `${capability}Model`,
						label: `${CAPABILITY_LABELS[capability]} model`,
						currentValue: "Default",
						submenu: (current: string, pickerDone: (value?: string) => void) => modelPicker(current, pickerDone, capability),
					} as SettingItem,
					effort: {
						id: `${capability}Effort`,
						label: `${CAPABILITY_LABELS[capability]} effort`,
						currentValue: "",
					} as SettingItem,
				},
			]),
		) as Record<Capability, { model: SettingItem; effort: SettingItem }>;

		function refresh(): void {
			const def = resolveModelEffort({ model: settings.model, effort: settings.effort }, families);
			modelItem.currentValue = def.family?.id ?? settings.model;
			effortItem.currentValue = effortDisplay(def);
			effortItem.values = def.family?.efforts.length ? [...def.family.efforts] : undefined;
			modeItem.currentValue = settings.mode;
			showTurnsItem.currentValue = String(settings.showTurns);
			showTurnsItem.values = showTurnsValues(settings.showTurns);

			for (const capability of CAPABILITIES) {
				const override = capabilityOverride(settings, capability);
				const resolved = resolveModelEffort(capabilityPair(settings, capability), families);
				const rows = capabilityItems[capability];
				rows.model.currentValue = override ? (resolved.family?.id ?? override.model) : "Default";
				rows.effort.currentValue = effortDisplay(resolved);
				rows.effort.values = resolved.family?.efforts.length ? [...resolved.family.efforts] : undefined;
			}
		}
		refresh();

		const items: SettingItem[] = [
			modelItem,
			effortItem,
			modeItem,
			showTurnsItem,
			...CAPABILITIES.flatMap((capability) => [capabilityItems[capability].model, capabilityItems[capability].effort]),
		];

		const noticeText = new Text("");

		function runSave(toSave: BroSettings): void {
			saving = true;
			void persistSettings(toSave)
				.then(() => {
					savedSettings = toSave;
					noticeText.setText("");
				})
				.catch((error: unknown) => {
					// Restore the last state that is actually on disk: showing the failed, unsaved
					// value would let the screen claim a setting that doesn't really exist.
					settings = savedSettings;
					queued = undefined;
					closeRequested = false;
					refresh();
					noticeText.setText(theme.fg("warning", `Could not save settings: ${errorMessage(error)}. Reverted to the last saved settings.`));
				})
				.finally(() => {
					saving = false;
					tui.requestRender();
					if (queued !== undefined) {
						const next = queued;
						queued = undefined;
						runSave(next);
					} else if (closeRequested) {
						closeRequested = false;
						done(undefined);
					}
				});
		}

		function persist(toSave: BroSettings): void {
			if (saving) {
				queued = toSave;
				return;
			}
			runSave(toSave);
		}

		const onChange = (id: string, newValue: string) => {
			if (id === "model") {
				const family = findFamily(newValue);
				if (!family) return;
				const keepCurrent = settings.effort === "default" ? !family.efforts.length : family.efforts.includes(settings.effort as AgyEffort);
				settings = { ...settings, model: family.id, effort: keepCurrent ? settings.effort : preferredEffort(family) };
			} else if (id === "effort") {
				// Effort-only edit: pin the resolved family's canonical id, same reasoning as the
				// capability-override effort-only edit below -- otherwise a shared default created
				// from a suffixed variant id (e.g. "gemini-x-low") would end up paired with an
				// unrelated effort instead of its actual family id.
				const resolved = resolveModelEffort({ model: settings.model, effort: settings.effort }, families);
				settings = { ...settings, model: resolved.family?.id ?? settings.model, effort: newValue as BroEffort };
			} else if (id === "mode") {
				const mode = parseBroMode(newValue);
				if (!mode) return;
				settings = { ...settings, mode };
			} else if (id === "showTurns") {
				const turns = Number(newValue);
				if (!Number.isInteger(turns) || turns < 1) return;
				settings = { ...settings, showTurns: turns };
			} else {
				const capability = CAPABILITIES.find((item) => id === `${item}Model` || id === `${item}Effort`);
				if (!capability) return;
				if (id === `${capability}Model`) {
					if (newValue === "__default__") {
						settings = withCapabilityOverride(settings, capability, undefined);
					} else {
						const family = findFamily(newValue);
						if (!family) return;
						const currentEffort = capabilityPair(settings, capability).effort;
						const keepCurrent = currentEffort === "default" ? !family.efforts.length : family.efforts.includes(currentEffort as AgyEffort);
						settings = withCapabilityOverride(settings, capability, {
							model: family.id,
							effort: keepCurrent ? currentEffort : preferredEffort(family),
						});
					}
				} else {
					// Effort-only edit: pin the resolved family's canonical id, never whatever raw
					// string happens to sit in settings.model/override.model (which — for a shared
					// default created from a suffixed variant id such as "gemini-x-low" with
					// effort "default" — is not the family id). Storing the raw string here would
					// pair a mismatched model/effort (e.g. a "-low"-suffixed id with effort "high").
					const resolved = resolveModelEffort(capabilityPair(settings, capability), families);
					const existing = capabilityOverride(settings, capability);
					const model = resolved.family?.id ?? existing?.model ?? settings.model;
					settings = withCapabilityOverride(settings, capability, { model, effort: newValue as BroEffort });
				}
			}
			refresh();
			tui.requestRender();
			persist(settings);
		};

		const requestClose = () => {
			if (saving) {
				closeRequested = true;
				return;
			}
			done(undefined);
		};

		const settingsList = new SettingsList(items, Math.min(items.length + 2, 18), getSettingsListTheme(), onChange, requestClose);
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Bro · config"))));
		container.addChild(new Text(theme.fg("dim", "Shared defaults, with optional overrides per capability")));
		container.addChild(settingsList);
		container.addChild(noticeText);
		container.addChild(new Text(theme.fg("dim", "↑/↓ navigate · Enter select/change · Esc back/close")));

		return {
			render: (w: number) => {
				const inner = Math.max(1, w - 4);
				const border = (left: string, right: string) => theme.fg("border", left + "─".repeat(inner + 2) + right);
				return [border("┌", "┐"), ...container.render(inner).map(line => {
					const text = truncateToWidth(line, inner, "");
					return theme.fg("border", "│") + " " + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + " " + theme.fg("border", "│");
				}), border("└", "┘")];
			},
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	};
}

export async function showBroConfigModal(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Use /bro config in Pi's interactive UI.", "warning");
		return;
	}
	let settings: BroSettings;
	let families: AgyModelFamily[];
	try {
		settings = await readSettings();
		families = await listAgyModels(pi);
	} catch (error) {
		ctx.ui.notify(withDoctor(error), "error");
		return;
	}
	await ctx.ui.custom<void>(createConfigModal(settings, families, writeSettings), {
		overlay: true,
		overlayOptions: {
			width: "78%",
			minWidth: 48,
			maxHeight: "78%",
			anchor: "top-center",
			margin: { top: 1, left: 2, right: 2 },
		},
	});
}

// Testable core for /bro advisor-steer: persistence only happens on Ctrl+S/Ctrl+K.
// Esc leaves the stored brief untouched; only the in-memory draft is discarded.
export function createAdvisorSteerModal(
	initialText: string,
	onSave: (text: string) => void,
	onClear: () => void,
	copy: (text: string) => Promise<void> = copyToClipboard,
): (tui: TUI, theme: Theme, keybindings: unknown, done: (value?: void) => void) => Component & { dispose?(): void } {
	return (tui, theme, _keybindings, done) => {
		const editorTheme: EditorTheme = { borderColor: (s: string) => theme.fg("border", s), selectList: getSelectListTheme() };
		const editor = new Editor(tui, editorTheme);
		editor.focused = true;
		editor.setText(initialText);
		let disposed = false;
		const notice = new Text("");
		const showNotice = (message: string, color: "success" | "error") => {
			if (disposed) return;
			notice.setText(theme.fg(color, message));
			tui.requestRender();
		};
		editor.onChange = () => notice.setText("");

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Bro · advisor steer"))));
		container.addChild(new Text(theme.fg("dim", "One persistent steering brief the advisor always sees — never sent to the main model.")));
		container.addChild(editor);
		container.addChild(notice);
		container.addChild(new Text(theme.fg("dim", "Ctrl+S save · Enter newline · Ctrl+K clear · Ctrl+C copy · Esc close")));

		return {
			render: (w: number) => {
				const inner = Math.max(1, w - 4);
				const border = (left: string, right: string) => theme.fg("border", left + "─".repeat(inner + 2) + right);
				return [border("┌", "┐"), ...container.render(inner).map((line) => {
					const text = truncateToWidth(line, inner, "");
					return theme.fg("border", "│") + " " + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + " " + theme.fg("border", "│");
				}), border("└", "┘")];
			},
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "escape")) {
					disposed = true;
					done(undefined);
					return;
				}
				if (matchesKey(data, "ctrl+s")) {
					try {
						onSave(editor.getExpandedText());
						showNotice("Saved", "success");
					} catch (error) {
						showNotice(`Save failed: ${errorMessage(error)}`, "error");
					}
					return;
				}
				if (matchesKey(data, "ctrl+k")) {
					try {
						onClear();
						editor.setText("");
						showNotice("Cleared", "success");
					} catch (error) {
						showNotice(`Clear failed: ${errorMessage(error)}`, "error");
					}
					return;
				}
				if (matchesKey(data, "ctrl+c")) {
					const text = editor.getExpandedText();
					void Promise.resolve()
						.then(() => copy(text))
						.then(() => showNotice("Copied", "success"))
						.catch((error) => showNotice(`Copy failed: ${errorMessage(error)}`, "error"));
					return;
				}
				if (matchesKey(data, "enter")) {
					editor.insertTextAtCursor("\n");
					tui.requestRender();
					return;
				}
				editor.handleInput(data);
				tui.requestRender();
			},
			dispose: () => { disposed = true; },
		};
	};
}

export async function showAdvisorSteerModal(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Use /bro advisor-steer in Pi's interactive UI.", "warning");
		return;
	}
	const { steering } = resolveAdvisorState(ctx.sessionManager.getBranch());
	await ctx.ui.custom<void>(
		createAdvisorSteerModal(
			steering,
			(text) => pi.appendEntry(ADVISOR_STEERING_ENTRY, { text }),
			() => pi.appendEntry(ADVISOR_STEERING_ENTRY, { text: "" }),
		),
		{
			overlay: true,
			overlayOptions: { width: "78%", minWidth: 48, maxHeight: "60%", anchor: "top-center", margin: { top: 1, left: 2, right: 2 } },
		},
	);
}

export function helpText(settings?: BroSettings, settingsError?: string): string {
	const overrideLines = settings
		? CAPABILITIES.map((capability) => {
				const override = capabilityOverride(settings, capability);
				return override
					? `- **${CAPABILITY_LABELS[capability]} override:** \`${override.model}\`${override.effort === "default" ? "" : ` (${override.effort})`}`
					: undefined;
			}).filter((line): line is string => line !== undefined)
		: [];
	const settingsSummary = settings
		? `- **Model:** \`${settings.model}\`\n- **Reasoning effort:** ${settings.effort === "default" ? "built into the selected model" : settings.effort}\n- **Mode:** ${settings.mode}\n- **Show turns:** ${settings.showTurns}${overrideLines.length ? `\n${overrideLines.join("\n")}` : ""}`
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

- \`/bro doctor\` — check settings, Agy, account, model, effort, and mode
- \`/bro usage [--provider agy]\` — show current Agy limits
- \`/bro model [id]\` — view or choose the shared default Agy model
- \`/bro effort [low|medium|high]\` — view or choose the shared default reasoning effort
- \`/bro mode [brief|balanced|faithful]\` — view or choose explanation mode
- \`/bro config\` — open an interactive settings screen for the shared default model/effort, explain mode, show turns, and per-capability (explain/show/btw/advisor) model and effort overrides. Changes save immediately; Esc on a picker cancels without changing anything, Esc on the screen closes it and keeps whatever was already saved.

\`/bro model\` and \`/bro effort\` always change the shared default that explain, show, btw, and advisor fall back to when they have no override. Use \`/bro config\` to give one of them its own model or effort.

## Side conversation

- \`/bro btw [--fresh] [--full] [question]\` — open a side conversation. Sandboxed (read-only) by default; add \`--full\` to let it read and edit the workspace, and \`--fresh\` to start without main-session context. Inside the side thread, type questions and press Enter (empty Enter re-asks); \`/copy\` copies the latest answer to the main editor without submitting (use \`/copy!\` to replace an existing draft), \`/copy-all\` the full thread, \`/retry\` re-asks the last question, and \`/clear\` resets the thread. Esc closes.

## Advisor

- \`bro_advisor\` — a tool the executor agent can voluntarily call mid-task for a second opinion from a fresh Agy process before or after a non-trivial decision. It is registered like any other tool and has no on/off switch of its own; whether the executor can actually call it depends entirely on this host's own tool restrictions
- \`/bro advisor\` — a quick notice of whether \`bro_advisor\` is available right now, pointing at \`/bro config\`, \`/bro advisor-steer\`, and \`/bro doctor\`
- \`/bro advisor-steer\` — open an editor for one persistent steering brief the advisor always sees. **Ctrl+S** saves, **Enter**/**Shift+Enter** insert newlines, **Ctrl+K** clears the saved brief and draft, **Ctrl+C** copies the full draft, and **Esc** closes without saving unsaved edits
- \`/bro doctor\` — the full advisor diagnostic: whether this host exposes and activates \`bro_advisor\`, its resolved model/effort, steering presence, and the Agy compatibility floor

Each consultation is a fresh, standalone Agy process — never resumed, never looping, never automatically triggered. Bro captures the context snapshot (system instructions, active tools, and the conversation so far) automatically; the executor never has to assemble one. The advisor has real tool access in the workspace, running with permissions auto-approved, so it can verify claims itself — it only ever returns advice, and the executor stays responsible for any actual change. The steering brief persists in the session (not sent to the model) and is restored on resume or reload; forking a session inherits it, and edits after the fork are independent of the original branch.

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
- Advisor consultations run with real tool access and auto-approved permissions (\`--dangerously-skip-permissions\`) — there is no enforced read-only isolation, only the advisor's own instructions to advise rather than implement. On invocation failure (not a completed answer), Bro retries with the identical snapshot, steering, and question: once after 5 seconds, once more after 10 seconds, then returns Agy's own diagnostic as the failure.

## Privacy and safety

Bro sends the selected assistant reply, pasted text, locally extracted document or webpage text, or recent session conversation text (tool calls, tool results, reasoning, and images omitted) to Agy and your model provider. They may retain request data under their own policies.

Bro never adds the explanation to Pi's conversation, session file, or main-agent context. The captured source and latest explanation stay in process memory until you change sessions, reload extensions, or exit Pi.

Bro's explain, show, file, and url commands never modify project files. \`/bro btw\` runs sandboxed (read-only) by default; with \`--full\` it can read and edit the workspace, so use \`--full\` only when you want the side conversation to touch your project.
For webpages, it connects directly to the site without browser cookies; the site sees your IP address and Bro's user agent. Do not use private or signed URLs.

Usage and Doctor checks contact Agy but do not send source text or run a model turn. Pressing **C** sends the explanation to your system clipboard.

Each advisor consultation sends the executor's system instructions, active tool list, ordered conversation (including tool calls and results, since the advisor needs to verify claims), your steering brief, and the executor's optional question to Agy and your model provider; the advisor process itself can read and edit the workspace with no permission prompts. The steering brief and activation state are stored as session-only extension data — never added to the main conversation Pi or the model sees.

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

export function formatBtwTranscript(turns: readonly BtwTurn[]): string {
	return turns
		.map((turn) => {
			const question = turn.question.split(/\r?\n/).map((line) => (line ? `> ${line}` : ">")).join("\n");
			// A turn aborted mid-stream can end inside an unclosed code fence, which would swallow the
			// separator and every later turn; close it so each turn renders as its own block.
			const answer = (turn.answer.match(/^```/gm)?.length ?? 0) % 2 === 1 ? `${turn.answer}\n\`\`\`` : turn.answer;
			return `> **You**\n>\n${question}\n\n**Bro**\n\n${answer}`;
		})
		.join("\n\n---\n\n");
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

export type BtwComposerAction =
	| { kind: "clear" }
	| { kind: "retry" }
	| { kind: "copy"; all: boolean; force: boolean }
	| { kind: "question"; text: string };

export function parseBtwComposerCommand(value: string): BtwComposerAction {
	const command = value.trim();
	if (command === "/clear") return { kind: "clear" };
	if (command === "/retry" || command === "") return { kind: "retry" };
	if (
		command === "/copy" ||
		command === "/copy!" ||
		command === "/copy-all" ||
		command === "/copy-all!" ||
		command === "/copy all" ||
		command === "/copy all!" ||
		command === "/send" ||
		command === "/send!" ||
		command === "/send all" ||
		command === "/send all!"
	) {
		const all =
			command.startsWith("/copy-all") ||
			command.startsWith("/copy all") ||
			command.startsWith("/send all");
		return { kind: "copy", all, force: command.endsWith("!") };
	}
	return { kind: "question", text: command };
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
			: this.theme.fg("dim", "Enter ask · Esc close · /copy · /copy-all · /clear · /retry");

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

			const transcript = () => formatBtwTranscript(thread.turns);

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
						agySelection(capabilityPair(settings, "btw")),
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
					modal.setNotice("Nothing to copy yet.");
					return;
				}
				if (ctx.ui.getEditorText().trim() && !force) {
					modal.setNotice("Main editor has a draft. Use /copy! (or /copy-all!) to replace it.");
					return;
				}
				ctx.ui.setEditorText(text);
				modal.setNotice(all ? "Copied the full thread to the editor." : "Copied the latest answer to the editor.");
			};

			function submit(value: string): void {
				const action = parseBtwComposerCommand(value);
				if (action.kind === "clear") {
					modal.clearComposer();
					clear();
					return;
				}
				if (action.kind === "copy") {
					modal.clearComposer();
					handoff(action.all, action.force);
					return;
				}
				if (action.kind === "retry") {
					modal.clearComposer();
					retry();
					return;
				}
				void runTurn(action.text);
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

	pi.on("session_start", async (_event, _ctx) => {
		lastResult = undefined;
		btwThread = undefined;
	});

	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: "Bro advisor",
		description:
			"Consult a fresh, independent Agy process for a second opinion mid-task. It has real, unsandboxed tool access in the current workspace (read files, search, run commands) with permissions auto-approved, and is instructed to investigate before advising and to leave edits to you — that is a behavioral instruction to the advisor, not an enforced restriction, so treat its findings as advice rather than a delegated implementation. You never need to prepare a summary or evidence first: Bro automatically captures your system instructions, active tools, and the conversation so far, plus any human-set steering priorities, and sends them to the advisor.",
		promptSnippet: "bro_advisor({question?}): consult a fresh Agy process for a second opinion; it investigates the workspace itself and returns advice",
		promptGuidelines: [
			"Call bro_advisor before or after a non-trivial design or scope decision, or when genuinely uncertain, for a second opinion from a fresh, independent Agy process.",
			"question is optional — never delay a call to first prepare a summary or evidence; Bro captures your context automatically.",
			"Any human-set steering priorities are applied automatically by the advisor; you don't need to relay or repeat them.",
			"The advisor is instructed to only return advice and leave edits to you — that instruction is not enforced, so verify its findings yourself rather than treating them as a completed implementation.",
		],
		parameters: Type.Object({
			question: Type.Optional(
				Type.String({ description: "Optional question to focus the consultation on. Leave unset to ask for general advice on the current state." }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const state = resolveAdvisorState(ctx.sessionManager.getBranch());
			const settings = await readSettings();
			const selection = agySelection(capabilityPair(settings, "advisor"));
			const snapshot = buildAdvisorSnapshot(ctx, pi);
			const prompt = buildAdvisorPrompt(state.steering, snapshot.text, params.question);
			let lastAttempt: AdvisorToolDetails = { status: "investigating", attempt: 1, of: 3, elapsedMs: 0 };
			try {
				const run = await runAdvisorWithRetries(
					prompt,
					selection,
					ctx.cwd,
					signal ?? new AbortController().signal,
					undefined,
					undefined,
					(details) => {
						lastAttempt = details;
						const label = advisorAttemptLabel(lastAttempt);
						onUpdate?.({
							content: [{ type: "text", text: label }],
							details: lastAttempt,
						});
						// A host's tool-card renderer may replace onUpdate's partial renderResult with its
						// own generic placeholder for the whole run (observed with pi-cc-extensions' default
						// mode, which hardcodes "Pending…" for every isPartial tool result unless the tool
						// is opted into its excludeRenderers list). The footer/status bar is a separate,
						// host-owned surface that no such tool-card override touches, so mirror progress
						// there too as a fallback the user can see regardless of that renderer choice.
						ctx.ui.setStatus(ADVISOR_STATUS_BAR_KEY, label);
					},
				);
				const effort = selection.effort ?? "model default";
				const omissions = `image/reasoning bodies omitted when present; ${snapshot.hadCompaction ? "Pi compaction summaries replace earlier turns" : "no Pi compaction summary present"}`;
				const details: AdvisorToolDetails = {
					...lastAttempt,
					status: "done",
					attempt: run.attempts,
					model: selection.model,
					effort,
					durationMs: run.durationMs,
					cwd: ctx.cwd,
					steeringIncluded: Boolean(state.steering.trim()),
					snapshotChars: snapshot.text.length,
					broTruncated: false,
					omissions,
					// run.activityCount is the exact final total; lastAttempt's may lag behind by up to
					// the activity throttle window.
					activityCount: run.activityCount,
				};
				const header = `Bro advisor · model: ${selection.model} · effort: ${effort} · ${run.attempts} attempt${run.attempts === 1 ? "" : "s"} · ${Math.ceil(run.durationMs / 1_000)}s`;
				const context = `Context · cwd: ${JSON.stringify(ctx.cwd)} · steering: ${details.steeringIncluded ? "included" : "none"} · snapshot: ${snapshot.text.length} chars · Bro truncation: none · omissions: ${omissions}`;
				return { content: [{ type: "text", text: `${header}\n${context}\n\n${run.advice}` }], details };
			} finally {
				ctx.ui.setStatus(ADVISOR_STATUS_BAR_KEY, undefined);
			}
		},
		renderCall(args, theme) {
			const question = args.question?.trim();
			return new Text(theme.fg("dim", question ? `Bro advisor · ${question}` : "Bro advisor · consulting…"));
		},
		renderResult(result, options, theme) {
			const details = result.details as AdvisorToolDetails | undefined;
			if (options.isPartial) {
				const label = new Text(theme.fg("dim", details ? advisorAttemptLabel(details) : "Bro advisor · investigating…"));
				// Expanded + running: the simplest native tail -- one dim line per bounded recent
				// activity label, nothing fancier than the compact renderer above.
				if (!options.expanded || !details?.activity?.length) return label;
				const container = new Container();
				container.addChild(label);
				for (const line of details.activity) {
					container.addChild(new Text(theme.fg("dim", `  ${advisorActivityPreview(line)}`)));
				}
				return container;
			}
			if (!options.expanded && details?.status === "done") return new Text(theme.fg("accent", advisorAttemptLabel(details)));
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (!options.expanded) {
				const firstLine = text.split("\n").find((line) => line.trim()) ?? "(no advice)";
				return new Text(`${theme.fg("accent", "Bro advisor")}${theme.fg("dim", ` · ${firstLine}`)}`);
			}
			return new Markdown(text, 0, 0, getMarkdownTheme());
		},
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
						text = await runShowExplanation(captured.text, steering, signal, await readSettings(), onProgress);
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
							text: await simplify(target.text, signal, await readSettings(), onProgress),
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
						run: async (signal) => ({ text: await doctorReport(pi, ctx, signal) }),
					});
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
				return;
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

			if (action === "config") {
				if (parts.length !== 1) {
					ctx.ui.notify("Use /bro config.", "warning");
					return;
				}
				await showBroConfigModal(ctx, pi);
				return;
			}

			if (action === "advisor") {
				// bro_advisor has no on/off/status controls of its own anymore -- it is always registered
				// and gated only by this host's own tool restrictions. An old on/off/status argument gets
				// an actionable notice pointing at the commands that replaced it, not a silent no-op.
				if (parts.length > 1) {
					ctx.ui.notify(
						"/bro advisor no longer has on/off/status controls -- bro_advisor is always registered and available whenever this host exposes and activates it. Use /bro config for its model/effort, /bro advisor-steer for its steering brief, or /bro doctor for full diagnostics.",
						"warning",
					);
					return;
				}
				const active = pi.getActiveTools().includes(ADVISOR_TOOL_NAME);
				ctx.ui.notify(
					active
						? "Bro advisor is available -- the executor agent can call bro_advisor. Use /bro config for its model/effort, /bro advisor-steer for its steering brief, or /bro doctor for full diagnostics."
						: "Bro advisor is unavailable in this runtime. Use /bro doctor for full diagnostics, /bro config for its model/effort, or /bro advisor-steer for its steering brief.",
					active ? "info" : "warning",
				);
				return;
			}

			if (action === "advisor-steer") {
				if (parts.length !== 1) {
					ctx.ui.notify("Use /bro advisor-steer.", "warning");
					return;
				}
				await showAdvisorSteerModal(ctx, pi);
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
						text: await simplify(target.text, signal, settings, onProgress),
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
