import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runBackendText } from "./backend.ts";
import { buildShowPrompt } from "./prompt.ts";
import { type BroSettings, readPreferences, selectionForCapability, selectionLabel } from "./settings.ts";
import { type BroSource, MAX_TEXT_LENGTH } from "./sources.ts";
import { errorMessage, isRenderableSequence } from "./util.ts";

const SHOW_HTML_FILE_PATTERN = /^bro-show-[0-9a-f]{8}\.html$/;

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

export function captureShowTranscript(ctx: ExtensionCommandContext, turnsRequested: number, maxLength = MAX_TEXT_LENGTH): BroSource | undefined {
	if (!Number.isSafeInteger(maxLength) || maxLength < 128) throw new Error("Transcript limit must be an integer of at least 128 characters.");
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
	while (text.length > maxLength && start < turns.length - 1) {
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
	if (text.length > maxLength) {
		// Prefer the newest complete messages even within an oversized single turn.
		const entries = turns.slice(start).flatMap(turn => turn.entries);
		const notice = "[… earlier messages truncated …]\n";
		while (entries.length > 1 && entries.join("\n\n").length + notice.length > maxLength) entries.shift();
		text = entries.join("\n\n");
		if (text.length + notice.length > maxLength) {
			const newline = text.indexOf("\n");
			const header = text.slice(0, newline);
			const content = JSON.parse(text.slice(newline + 1)) as string;
			const marker = "[… earlier text truncated …] ";
			let tail = content.slice(-(maxLength - header.length - marker.length - 8));
			while (`${header}\n${JSON.stringify(marker + tail)}`.length > maxLength) tail = tail.slice(Math.max(1, Math.floor(tail.length / 10)));
			text = `${header}\n${JSON.stringify(marker + tail)}`;
		} else text = notice + text;
	}
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

export type ShowDiagram = { kind: "html" | "mermaid"; source: string };
const SHOW_DIAGRAM_FENCE = /^```(html|mermaid)[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gm;

export function extractShowDiagram(text: string): ShowDiagram | undefined {
	const last = [...text.matchAll(SHOW_DIAGRAM_FENCE)].at(-1);
	if (!last) return undefined;
	const diagram = { kind: last[1] as ShowDiagram["kind"], source: last[2]!.trim() };
	// Any other Mermaid stays in the modal as a plain text block, visible rather than hidden.
	return diagram.kind === "html" || isRenderableSequence(diagram.source) ? diagram : undefined;
}

export function stripShowDiagramFence(text: string): string {
	const last = [...text.matchAll(SHOW_DIAGRAM_FENCE)].at(-1);
	if (!last || last.index === undefined) return text;
	const shown = last[1] === "mermaid" ? `${last[0]}\n[Diagram saved — press O to render]` : "[HTML diagram saved — press O to open]";
	return text.slice(0, last.index) + shown + text.slice(last.index + last[0].length);
}

export function showHtmlDirectory(): string {
	// ponytail: per-uid directory so keep-one cleanup never touches other
	// users' files in a shared /tmp, and readdir stays small.
	return join(tmpdir(), `pi-bro-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
}

function withShowCsp(html: string): string {
	// Defense in depth: the prompt forbids external resources and scripts;
	// a meta CSP blocks them anyway if the model slips. Always inserted: multiple
	// policies are enforced together, so a model-supplied CSP can only tighten it.
	// Skip only simple leading comments: browsers accept comment terminators that
	// a general regex misses. Ambiguous markup gets the policy prepended instead.
	const meta = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:;">';
	return html.replace(/^(\s*(?:<!--[^<>]*-->\s*)*(?:<!doctype[^>]*>\s*)?)/i, `$1\n${meta}\n`);
}

// Bro, not the model, owns every script on a Mermaid page: the CSP allows only these two exact
// scripts by hash, and the model's source is inserted as escaped text that Mermaid parses itself.
const MERMAID_INIT = 'mermaid.initialize({startOnLoad:true,securityLevel:"strict",htmlLabels:false,flowchart:{htmlLabels:false}});';

async function vendoredMermaid(): Promise<string> {
	const library = await readFile(new URL("./vendor/mermaid.min.js", import.meta.url), "utf8");
	// Inlined in <script>: "<!--" or "<script" would change how HTML parses the element. Every
	// occurrence sits inside a JS string or regex literal, where \x3C is the same character.
	return library.replace(/<(?=!--|\/?script)/gi, "\\x3C");
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
}

export async function mermaidShowPage(source: string): Promise<string> {
	const library = await vendoredMermaid();
	const hash = (script: string) => `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
	const escaped = escapeHtml(source);
	return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src ${hash(library)} ${hash(MERMAID_INIT)}">
<title>Bro diagram</title>
<body style="margin:16px;font-family:system-ui,sans-serif">
<style>pre.mermaid svg{max-height:calc(100vh - 64px)}</style>
<pre class="mermaid">${escaped}</pre>
<details><summary>Diagram source</summary><pre>${escaped}</pre></details>
<script>${library}</script>
<script>${MERMAID_INIT}</script>
</body>`;
}

export async function writeShowDiagram(diagram: ShowDiagram): Promise<string> {
	const page = diagram.kind === "mermaid" ? await mermaidShowPage(diagram.source) : withShowCsp(diagram.source);
	const slug = createHash("sha256").update(page).digest("hex").slice(0, 8);
	const directory = showHtmlDirectory();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	for (const name of await readdir(directory)) {
		if (SHOW_HTML_FILE_PATTERN.test(name)) await rm(join(directory, name), { force: true });
	}
	const path = join(directory, `bro-show-${slug}.html`);
	await writeFile(path, `${page}\n`, "utf8");
	return path;
}

// A diagram that cannot be written must not cost the reply: keep the text and warn instead.
export async function showDiagramPath(text: string, warn: (message: string) => void): Promise<string | undefined> {
	const diagram = extractShowDiagram(text);
	if (!diagram) return undefined;
	try { return await writeShowDiagram(diagram); }
	catch (error) {
		warn(`Diagram file unavailable: ${errorMessage(error)}`);
		return undefined;
	}
}

export function openShowHtml(path: string): boolean {
	if (process.platform === "win32") {
		const result = spawnSync("cmd", ["/c", "start", "", path], { stdio: "ignore", timeout: 5_000 });
		return result.status === 0;
	}
	const opener = process.platform === "darwin" ? "open" : "xdg-open";
	const result = spawnSync(opener, [path], { stdio: "ignore", timeout: 5_000 });
	return result.status === 0;
}

export async function runShowExplanation(
	transcript: string,
	steering: string,
	signal: AbortSignal,
	settings: BroSettings,
	onProgress?: (text: string) => void,
): Promise<{ text: string; model: string; preferences: boolean }> {
	const selection = selectionForCapability(settings, "show");
	const preferences = await readPreferences();
	const text = await runBackendText(buildShowPrompt(transcript, steering, preferences), selection, signal, onProgress, "show");
	return { text, model: selectionLabel(selection), preferences: Boolean(preferences) };
}
