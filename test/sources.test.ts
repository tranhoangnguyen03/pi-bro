import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { isIP } from "node:net";
import type { IncomingMessage, ClientRequest } from "node:http";
import {
	extractWebPage,
	fetchPublicHtml,
	isPublicWebAddress,
	type WebTransport,
	MAX_WEB_BYTES,
	MAX_WEB_REDIRECTS,
} from "../sources.ts";

type FakeResponse = {
	statusCode?: number;
	headers?: Record<string, string | string[]>;
	body?: Buffer | string | Array<Buffer | string>;
	streamError?: Error;
};

type FakeRoute = {
	dns?: Array<{ address: string; family: number }>;
	response?: FakeResponse;
	onRequest?: (options: any) => void;
};

function createFakeTransport(routes: Record<string, FakeRoute>) {
	const requestedUrls: string[] = [];
	const boundLookups: Array<{ hostname: string; address: any; family?: number }> = [];
	const requestOptions: any[] = [];
	const destroyedResponses: Array<{ url: string; error?: Error }> = [];

	function handleRequest(protocol: string, url: URL, options: any, onResponse: (res: IncomingMessage) => void): ClientRequest {
		requestedUrls.push(url.href);
		requestOptions.push({ protocol, url: url.href, options });

		if (typeof options.lookup === "function") {
			// Exercise both all: true and default lookup invocations to test the pinning seam
			options.lookup(url.hostname, { all: true }, (err: any, addrs: any) => {
				if (!err && addrs?.[0]) boundLookups.push({ hostname: url.hostname, address: addrs[0].address, family: addrs[0].family });
			});
			options.lookup(url.hostname, {}, (err: any, addr: any, fam: any) => {
				if (!err) boundLookups.push({ hostname: url.hostname, address: addr, family: fam });
			});
		}

		const req = new EventEmitter() as ClientRequest;
		(req as any).end = () => {
			const route = routes[url.href] ?? routes[url.hostname];
			if (!route || !route.response) {
				queueMicrotask(() => req.emit("error", new Error(`No route for ${url.href}`)));
				return req;
			}

			route.onRequest?.(options);

			const fakeRes = route.response;
			const bodyChunks = Array.isArray(fakeRes.body)
				? fakeRes.body.map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(b)))
				: fakeRes.body !== undefined
					? [Buffer.isBuffer(fakeRes.body) ? fakeRes.body : Buffer.from(fakeRes.body)]
					: [];

			let stream: Readable;
			if (fakeRes.streamError) {
				let emitted = false;
				stream = new Readable({
					read() {
						if (!emitted && bodyChunks.length > 0) {
							emitted = true;
							this.push(bodyChunks[0]);
						} else {
							this.destroy(fakeRes.streamError);
						}
					},
				});
			} else {
				stream = Readable.from(bodyChunks, { objectMode: false });
			}

			const originalDestroy = stream.destroy.bind(stream);
			let wasDestroyed = false;
			(stream as any).destroy = (err?: Error) => {
				wasDestroyed = true;
				destroyedResponses.push({ url: url.href, error: err });
				return originalDestroy(err);
			};
			Object.defineProperty(stream, "destroyed", {
				get: () => wasDestroyed,
			});

			const response = Object.assign(stream, {
				statusCode: fakeRes.statusCode ?? 200,
				headers: fakeRes.headers ?? { "content-type": "text/html" },
			});

			queueMicrotask(() => onResponse(response as unknown as IncomingMessage));
			return req;
		};
		return req;
	}

	const transport: WebTransport = {
		lookup: async (hostname: string) => {
			const route = routes[hostname];
			if (route && route.dns) {
				return route.dns;
			}
			const family = isIP(hostname);
			if (family) {
				return [{ address: hostname, family }];
			}
			throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
		},
		httpRequest: (url: any, options: any, onResponse: any) => {
			return handleRequest("http", url as URL, options, onResponse);
		},
		httpsRequest: (url: any, options: any, onResponse: any) => {
			return handleRequest("https", url as URL, options, onResponse);
		},
	};

	return {
		transport,
		requestedUrls,
		boundLookups,
		requestOptions,
		destroyedResponses,
	};
}

test("offline transport: mixed public and private DNS answers fail closed before request", async () => {
	const harness = createFakeTransport({
		"mixed.example.com": {
			dns: [
				{ address: "93.184.216.34", family: 4 },
				{ address: "10.0.0.1", family: 4 },
			],
			response: { statusCode: 200 },
		},
	});

	await assert.rejects(
		fetchPublicHtml(new URL("https://mixed.example.com/"), new AbortController().signal, harness.transport),
		/local, private, or reserved network addresses/,
	);
	assert.equal(harness.requestedUrls.length, 0, "no HTTP request made when DNS contains private address");
});

test("offline transport: mixed public and IPv6 loopback fail closed", async () => {
	const harness = createFakeTransport({
		"mixed-ipv6.example.com": {
			dns: [
				{ address: "93.184.216.34", family: 4 },
				{ address: "::1", family: 6 },
			],
			response: { statusCode: 200 },
		},
	});

	await assert.rejects(
		fetchPublicHtml(new URL("https://mixed-ipv6.example.com/"), new AbortController().signal, harness.transport),
		/local, private, or reserved network addresses/,
	);
	assert.equal(harness.requestedUrls.length, 0, "no request made on mixed IPv6 loopback");
});

test("offline transport: IPv4-compatible IPv6 and site-local addresses are rejected", () => {
	assert.equal(isPublicWebAddress("::127.0.0.1"), false, "IPv4-compatible loopback");
	assert.equal(isPublicWebAddress("::169.254.169.254"), false, "IPv4-compatible link-local");
	assert.equal(isPublicWebAddress("::7f00:1"), false, "IPv4-compatible loopback hex");
	assert.equal(isPublicWebAddress("::a9fe:a9fe"), false, "IPv4-compatible IMDS hex");
	assert.equal(isPublicWebAddress("fec0::1"), false, "Site-Local unicast IPv6");
});

test("offline transport: socket lookup pinning and agent: false enforcement", async () => {
	const html = "<!doctype html><html><head><title>Safe</title></head><body><p>Article body</p></body></html>";
	const harness = createFakeTransport({
		"safe.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: {
				statusCode: 200,
				headers: { "content-type": "text/html" },
				body: html,
			},
		},
	});

	const result = await fetchPublicHtml(new URL("https://safe.example.com/page"), new AbortController().signal, harness.transport);
	assert.equal(result.html, html);
	assert.equal(harness.requestedUrls.length, 1);

	// Verify agent: false is set to disable pooled socket reuse
	assert.equal(harness.requestOptions[0].options.agent, false, "connection pooling disabled");

	// Verify socket lookup pinning received the resolved address
	assert.ok(harness.boundLookups.length >= 1, "options.lookup was called");
	for (const lookup of harness.boundLookups) {
		assert.equal(lookup.address, "93.184.216.34");
		assert.equal(lookup.family, 4);
	}
});

test("offline transport: redirect to private address fails closed without contacting private target", async () => {
	const harness = createFakeTransport({
		"public.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: {
				statusCode: 302,
				headers: { location: "https://169.254.169.254/latest/meta-data" },
			},
		},
	});

	await assert.rejects(
		fetchPublicHtml(new URL("https://public.example.com/start"), new AbortController().signal, harness.transport),
		/local, private, or reserved network addresses/,
	);

	assert.deepEqual(harness.requestedUrls, ["https://public.example.com/start"]);
	assert.ok(!harness.requestedUrls.some((u) => u.includes("169.254.169.254")), "private destination never contacted");
});

test("offline transport: redirect to private hostname fails closed after resolving", async () => {
	const harness = createFakeTransport({
		"public.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: {
				statusCode: 302,
				headers: { location: "https://internal.corp.local/admin" },
			},
		},
		"internal.corp.local": {
			dns: [{ address: "10.0.0.50", family: 4 }],
			response: { statusCode: 200 },
		},
	});

	await assert.rejects(
		fetchPublicHtml(new URL("https://public.example.com/start"), new AbortController().signal, harness.transport),
		/local, private, or reserved network addresses/,
	);

	assert.deepEqual(harness.requestedUrls, ["https://public.example.com/start"]);
	assert.ok(!harness.requestedUrls.some((u) => u.includes("internal.corp.local")), "private host never contacted");
});

test("offline transport: HTTPS to HTTP downgrade redirect is refused", async () => {
	const harness = createFakeTransport({
		"secure.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: {
				statusCode: 302,
				headers: { location: "http://secure.example.com/insecure" },
			},
		},
	});

	await assert.rejects(
		fetchPublicHtml(new URL("https://secure.example.com/secure"), new AbortController().signal, harness.transport),
		/insecure HTTPS-to-HTTP redirect/,
	);

	assert.deepEqual(harness.requestedUrls, ["https://secure.example.com/secure"]);
	assert.ok(harness.requestOptions.every((r) => r.protocol === "https"), "http request never made");
});

test("offline transport: protocol smuggling in redirect is rejected", async () => {
	const harness = createFakeTransport({
		"public.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: {
				statusCode: 302,
				headers: { location: "file:///etc/passwd" },
			},
		},
	});

	await assert.rejects(
		fetchPublicHtml(new URL("https://public.example.com/"), new AbortController().signal, harness.transport),
		/only public HTTP or HTTPS webpages/,
	);
});

test("offline transport: redirect loops are detected and bounded", async () => {
	const harness = createFakeTransport({
		"loop.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
		},
		"https://loop.example.com/a": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: { statusCode: 302, headers: { location: "/b" } },
		},
		"https://loop.example.com/b": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: { statusCode: 302, headers: { location: "/a" } },
		},
	});

	await assert.rejects(
		fetchPublicHtml(new URL("https://loop.example.com/a"), new AbortController().signal, harness.transport),
		/Webpage redirect loop detected/,
	);
	assert.equal(harness.requestedUrls.length, 2, "stops on cycle");
});

test("offline transport: redirect count exceeding MAX_WEB_REDIRECTS fails closed", async () => {
	const routes: Record<string, FakeRoute> = {
		"chain.example.com": { dns: [{ address: "93.184.216.34", family: 4 }] },
	};
	for (let i = 0; i <= MAX_WEB_REDIRECTS; i++) {
		routes[`https://chain.example.com/step${i}`] = {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: { statusCode: 302, headers: { location: `/step${i + 1}` } },
		};
	}
	const harness = createFakeTransport(routes);

	await assert.rejects(
		fetchPublicHtml(new URL("https://chain.example.com/step0"), new AbortController().signal, harness.transport),
		/Webpage redirected too many times/,
	);
	assert.equal(harness.requestedUrls.length, MAX_WEB_REDIRECTS + 1, "exactly 6 requests made");
});

test("offline transport: redirect without location header fails closed", async () => {
	const harness = createFakeTransport({
		"nolocation.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: { statusCode: 302 },
		},
	});

	await assert.rejects(
		fetchPublicHtml(new URL("https://nolocation.example.com/"), new AbortController().signal, harness.transport),
		/Webpage returned HTTP 302 without a redirect location/,
	);
});

test("offline transport: advertised Content-Length exceeding 5 MiB destroys stream immediately", async () => {
	const harness = createFakeTransport({
		"big.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: {
				statusCode: 200,
				headers: { "content-length": String(MAX_WEB_BYTES + 1), "content-type": "text/html" },
				body: "should not be read",
			},
		},
	});

	await assert.rejects(
		fetchPublicHtml(new URL("https://big.example.com/"), new AbortController().signal, harness.transport),
		/Webpage is larger than Bro's 5 MiB download limit/,
	);
	assert.equal(harness.destroyedResponses.length, 1, "response was destroyed");
});

test("offline transport: chunked stream exceeding 5 MiB destroys stream mid-flight", async () => {
	const half = Buffer.alloc(3 * 1024 * 1024, "a");
	const harness = createFakeTransport({
		"stream.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: {
				statusCode: 200,
				headers: { "content-type": "text/html" }, // no content-length
				body: [half, half], // 6 MiB total
			},
		},
	});

	await assert.rejects(
		fetchPublicHtml(new URL("https://stream.example.com/"), new AbortController().signal, harness.transport),
		/Webpage is larger than Bro's 5 MiB download limit/,
	);
	assert.ok(harness.destroyedResponses.length >= 1, "response was destroyed mid-stream");
});

test("offline transport: exact 5 MiB boundary succeeds and 5 MiB + 1 fails", async () => {
	const prefix = "<!doctype html><html><body><p>";
	const suffix = "</p></body></html>";
	const exactly5Mb = prefix + "x".repeat(MAX_WEB_BYTES - prefix.length - suffix.length) + suffix;
	assert.equal(Buffer.byteLength(exactly5Mb), MAX_WEB_BYTES);

	const harnessSuccess = createFakeTransport({
		"boundary.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: {
				statusCode: 200,
				headers: { "content-type": "text/html", "content-length": String(Buffer.byteLength(exactly5Mb)) },
				body: exactly5Mb,
			},
		},
	});
	const res = await fetchPublicHtml(new URL("https://boundary.example.com/"), new AbortController().signal, harnessSuccess.transport);
	assert.equal(res.html.length, exactly5Mb.length);

	const oneByteOver = Buffer.alloc(MAX_WEB_BYTES + 1, "x");
	const harnessFail = createFakeTransport({
		"boundary-fail.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: {
				statusCode: 200,
				headers: { "content-type": "text/html", "content-length": String(MAX_WEB_BYTES + 1) },
				body: oneByteOver,
			},
		},
	});
	await assert.rejects(
		fetchPublicHtml(new URL("https://boundary-fail.example.com/"), new AbortController().signal, harnessFail.transport),
		/Webpage is larger than Bro's 5 MiB download limit/,
	);
});

test("offline transport: unsupported Content-Encoding and Content-Type fail closed", async () => {
	const harnessGzip = createFakeTransport({
		"gzip.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: {
				statusCode: 200,
				headers: { "content-encoding": "gzip", "content-type": "text/html" },
				body: "compressed",
			},
		},
	});
	await assert.rejects(
		fetchPublicHtml(new URL("https://gzip.example.com/"), new AbortController().signal, harnessGzip.transport),
		/Bro cannot read this page's gzip response encoding/,
	);
	assert.equal(harnessGzip.destroyedResponses.length, 1);

	const harnessPdf = createFakeTransport({
		"pdf.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: {
				statusCode: 200,
				headers: { "content-type": "application/pdf" },
				body: "%PDF-1.4",
			},
		},
	});
	await assert.rejects(
		fetchPublicHtml(new URL("https://pdf.example.com/"), new AbortController().signal, harnessPdf.transport),
		/Unsupported webpage content type: application\/pdf/,
	);
	assert.equal(harnessPdf.destroyedResponses.length, 1);
});

test("offline transport: HTTP error status codes return clear messages", async () => {
	for (const [code, expected] of [
		[401, /Webpage returned HTTP 401/],
		[403, /Webpage returned HTTP 403/],
		[429, /Webpage returned HTTP 429 and is limiting automated requests/],
		[500, /Webpage returned HTTP 500/],
	] as const) {
		const harness = createFakeTransport({
			"err.example.com": {
				dns: [{ address: "93.184.216.34", family: 4 }],
				response: { statusCode: code },
			},
		});
		await assert.rejects(
			fetchPublicHtml(new URL("https://err.example.com/"), new AbortController().signal, harness.transport),
			expected,
		);
		assert.equal(harness.destroyedResponses.length, 1);
	}
});

test("offline transport: mid-stream error rejects cleanly without returning partial content", async () => {
	const harness = createFakeTransport({
		"broken.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: {
				statusCode: 200,
				headers: { "content-type": "text/html" },
				body: "<p>Beginning of HTML...",
				streamError: new Error("network reset"),
			},
		},
	});

	await assert.rejects(
		fetchPublicHtml(new URL("https://broken.example.com/"), new AbortController().signal, harness.transport),
		/network reset/,
	);
});

test("offline transport: cancellation and extractWebPage integration", async () => {
	const html = "<!doctype html><html><head><title>Article Title</title></head><body><main><article><p>This is a real public article body with enough text to extract cleanly.</p></article></main></body></html>";
	const harness = createFakeTransport({
		"read.example.com": {
			dns: [{ address: "93.184.216.34", family: 4 }],
			response: {
				statusCode: 200,
				headers: { "content-type": "text/html" },
				body: html,
			},
		},
	});

	const source = await extractWebPage("https://read.example.com/story", undefined, harness.transport);
	assert.match(source.text, /real public article body/);
	assert.equal(source.label, "read.example.com · Article Title");

	const preAborted = new AbortController();
	preAborted.abort();
	await assert.rejects(
		extractWebPage("https://read.example.com/story", preAborted.signal, harness.transport),
		/Canceled/,
	);

	// Test cancellation interrupting a stalled/hanging DNS lookup
	const hangingController = new AbortController();
	const hangingTransport: WebTransport = {
		lookup: () => new Promise(() => {}), // never resolves
	};
	setTimeout(() => hangingController.abort(), 10);
	await assert.rejects(
		fetchPublicHtml(new URL("https://hanging.example.com/"), hangingController.signal, hangingTransport),
		/Canceled/,
	);
});
