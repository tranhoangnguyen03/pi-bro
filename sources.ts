import { readFile, stat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, extname, sep } from "node:path";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { stripVTControlCharacters } from "node:util";
import { extractText } from "unpdf";
import mammoth from "mammoth";
import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";
import { errorMessage, fileError, unquote } from "./util.ts";

export type BroSource = { text: string; label?: string };

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_WEB_BYTES = 5 * 1024 * 1024;
export const MAX_WEB_ELEMENTS = 100_000;
export const MAX_WEB_REDIRECTS = 5;
export const WEB_TIMEOUT_MS = 25_000;
export const MAX_TEXT_LENGTH = 100_000;
export const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
export const SNIFFABLE_FILE_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ".pdf", ".docx"]);
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

export async function isWorkspaceFile(input: string, cwd: string): Promise<boolean> {
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
