// One contract for every Bro overlay: it fits what Pi will show, swallows the wheel over it,
// and leaves terminal mouse reporting the way it found it. Add a row when you add a surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Editor, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { btw, buildDir, configUi, elevate, explainModal, settings as settingsModule } from "./test-build.mjs";
import { rm } from "node:fs/promises";

const load = (name) => import(pathToFileURL(join(buildDir, name)).href);
const kit = await load("modal-kit.js");
const { openGuidedReview } = await load("review-ui.js");
const { newReviewView } = await load("review-modal.js");
const { saveReview } = await load("review.js");
initTheme();

// Guided Review: a saved record to reopen, and a `gh` that fails at once so acquisition stays offline.
const reviewRoot = join(getAgentDir(), "bro-reviews");
await saveReview(reviewRoot, {
	version: 1,
	id: "8".repeat(64),
	snapshot: { target: { repository: "a/b", number: 88, head: "abcdef", base: "base" }, mergeBase: "merge", gitDir: reviewRoot, checkout: reviewRoot, files: [], diff: "" },
	turns: [],
	ui: newReviewView(),
});
const fakeBin = join(buildDir, "contract-bin");
await mkdir(fakeBin, { recursive: true });
await writeFile(join(fakeBin, "gh"), '#!/usr/bin/env node\nconsole.error("fixture: offline");process.exit(1);\n');
await chmod(join(fakeBin, "gh"), 0o755);
process.env.PATH = `${fakeBin}:${process.env.PATH}`;

const theme = { fg: (_color, text) => text, bold: (text) => text };
const SIZES = [[80, 24], [120, 40], [60, 14], [40, 8]];
const MODES = ["regular", "fullscreen"];
const long = Array.from({ length: 80 }, (_, index) => `Paragraph ${index} of a long answer.`).join("\n\n");
const settings = { model: "gemini-a", effort: "low", mode: "balanced", showTurns: 1, overrides: {} };

/** Pi's own overlay sizing, so a host change fails here instead of clipping users silently. */
const hostLayout = (overlay, cols, rows) =>
	TuiMainScreen.prototype.resolveOverlayLayout.call(TuiMainScreen.prototype, overlay, 0, cols, rows);

/** A ctx.ui.custom that behaves like Pi's: done closes once, then disposes the component. */
async function mount(open, mode, cols, rows) {
	const writes = [];
	let disposed = false;
	let rendersAfterDispose = 0;
	const tui = {
		mode,
		terminal: { rows, columns: cols, write: (data) => writes.push(data) },
		requestRender() {
			if (disposed) rendersAfterDispose++;
		},
	};
	const mounted = {};
	let ready;
	const mountedOnce = new Promise((resolve) => (ready = resolve));
	const ctx = {
		mode: "tui",
		cwd: fakeBin,
		sessionManager: { getBranch: () => [] },
		ui: {
			notify() {},
			getEditorText: () => "",
			setEditorText() {},
			select: async (_title, labels) => labels.find((label) => label.includes("#88")),
			custom: (factory, options) =>
				new Promise((resolve) => {
					mounted.overlay = options.overlayOptions;
					let closed = false;
					const done = (value) => {
						if (closed) return;
						closed = true;
						resolve(value);
						disposed = true;
						mounted.component?.dispose?.();
					};
					mounted.component = factory(tui, theme, {}, done);
					ready();
				}),
		},
	};
	mounted.closed = open(ctx);
	// Some surfaces mount after async work (Guided Review reads and picks a saved record first).
	await Promise.race([mountedOnce, mounted.closed]);
	return { ...mounted, tui, writes, rendersAfterDispose: () => rendersAfterDispose };
}

// Mounted the way their /bro commands mount them, minus the file and settings reads.
const factoryRow = (create) => (ctx) => kit.openBroOverlay(ctx, create());

// Elevate's stages past compose need a discovery result, which only the backend can produce, so
// build the modal and set the stage directly. The frame, wheel and dispose contract is the same.
const elevateFindings = Array.from({ length: 5 }, (_, index) => ({
	dimension: ["altitude", "depth", "range"][index % 3],
	title: `Finding ${index + 1} with a reasonably long label`,
	why: `Reason ${index + 1}: `.repeat(12) + "a summary can hide missed evidence.",
	expertMove: `Move ${index + 1}: `.repeat(12) + "test against real business questions.",
}));
const elevateStage = (stage) => (ctx) =>
	kit.openBroOverlay(
		ctx,
		(tui, theme, _keybindings, done) => {
			const modal = new elevate.ElevateModal(tui, theme, () => done(), () => {}, () => {}, () => {}, () => {}, () => done());
			if (stage === "review") modal.setDiscovery({ assessment: "The request is workable but misses concrete evidence.", findings: elevateFindings });
			else if (stage === "ready") modal.setReady(Array.from({ length: 60 }, (_, index) => `Requirement ${index}: do the thing carefully.`).join("\n\n"));
			else modal.setFailed("Bro did not return valid discovery JSON. Retry discovery.");
			return modal;
		},
		{ mouse: true },
	);

const SURFACES = [
	{ name: "explain result", scrolls: true, mouse: true, open: (ctx) => explainModal.showBroModal(ctx, { result: { text: long, model: "m" } }) },
	{ name: "explain loading", mouse: true, open: (ctx) => explainModal.showBroModal(ctx, { run: () => new Promise(() => {}) }) },
	{ name: "help", scrolls: true, mouse: true, open: (ctx) => explainModal.showBroModal(ctx, { text: explainModal.helpText(), kind: "help", copyable: true }) },
	{
		name: "btw with a long thread and a notice",
		scrolls: true,
		mouse: true,
		// The composer outlives the command help and the notice at every size.
		shows: [/Esc/, /> /],
		open: (ctx) => btw.openBtwModal(ctx, { thread: { turns: [{ question: "Why?", answer: long }], full: false } }),
		after: (component) => component.setNotice("A long notice that wraps across more than one line of the btw window footer, and then some."),
	},
	// shortcut rows: pi-tui's Editor has a fixed minimum height; below ~22 rows the editors ask for a bigger terminal.
	{
		name: "preferences",
		minRows: 22,
		fullShows: [/Never sent to the advisor or Pi's main model/, /Ctrl\+S save/],
		smallShows: [/Enlarge the terminal/],
		open: factoryRow(() => explainModal.createPreferencesModal({}, { save: async () => {}, clear: async () => {} })),
	},
	{
		name: "advisor-steer",
		minRows: 22,
		fullShows: [/Never sent to the main model/, /Ctrl\+S save/],
		smallShows: [/Enlarge the terminal/],
		open: factoryRow(() => explainModal.createAdvisorSteerModal(long, () => {}, () => {})),
	},
	// SettingsList prints config's full hints inside the list; the safe tiny state still keeps Esc visible.
	{ name: "config", minRows: 14, shows: [/Esc/], fullShows: [/Enter\/Space to change · Esc/], open: factoryRow(() => configUi.createConfigModal(settings, [], async () => {})) },
	{
		name: "config with the model picker open",
		minRows: 14,
		shows: [/Esc/],
		fullShows: [/Enter select · Esc back/],
		open: factoryRow(() => configUi.createConfigModal(settings, [], async () => {})),
		after: (component) => component.handleInput("\r"),
		// When it fits, the first Esc closes the picker; in resize fallback it closes config.
		close: (component) => ["\x1b", "\x1b"].forEach((key) => component.handleInput(key)),
	},
	{ name: "Guided Review acquisition", open: (ctx) => openGuidedReview(ctx, "https://github.com/a/b/pull/99", "") },
	{ name: "Guided Review workspace", mouse: true, open: (ctx) => openGuidedReview(ctx, "resume", "") },
	// Elevate's compose stage mounts through its real /bro entry point; with no objective and an empty
	// editor it makes no backend call. Presenting findings is what makes Elevated scroll, so those
	// stages are constructed directly below.
	{ name: "elevate compose", mouse: true, open: (ctx) => elevate.openElevateModal(ctx, "") },
	{
		name: "elevate review with findings",
		scrolls: true,
		mouse: true,
		shows: [/Esc/],
		// The action row is the target of every consequential keypress, so it must survive at every size.
	fullShows: [/[\[›]Rewrite/],
		smallShows: [/[\[›]Rewrite/],
		open: elevateStage("review"),
	},
	{
		name: "elevate ready with a long rewrite",
		scrolls: true,
		mouse: true,
		shows: [/Esc/],
		fullShows: [/[\[›]Insert/],
		open: elevateStage("ready"),
	},
	{ name: "elevate failed", mouse: true, open: elevateStage("failed") },
];

for (const surface of SURFACES) {
	test(`modal contract: ${surface.name}`, async () => {
		let scrollChecks = 0;
		for (const mode of MODES) {
			for (const [cols, rows] of SIZES) {
				const where = `${surface.name} ${mode} ${cols}x${rows}`;
				const exitListeners = process.listenerCount("exit");
				const mounted = await mount(surface.open, mode, cols, rows);
				const { component } = mounted;
				surface.after?.(component);
				const layout = hostLayout(mounted.overlay, cols, rows);
				const lines = component.render(layout.width);

				for (const line of lines) assert.ok(visibleWidth(line) <= layout.width, `${where}: line wider than ${layout.width}`);
				assert.ok(lines.length <= layout.maxHeight, `${where}: ${lines.length} rows > ${layout.maxHeight}`);
				// Guided Review keeps its rounded frame.
				if (layout.maxHeight >= 3) assert.match(lines.at(-1), /[└╰]/, `${where}: bottom border clipped`);
				// What must stay visible: an Esc hint everywhere, the rest from minRows up.
				const shown = stripVTControlCharacters(lines.join("\n")).replace(/[│\s]+/g, " ");
				const big = rows >= (surface.minRows ?? 0);
				// smallShows needs room for at least one body row next to the frame and hints.
				const extra = big ? surface.fullShows : layout.maxHeight >= 8 ? surface.smallShows : [];
				for (const pattern of [...(surface.shows ?? [/Esc/]), ...(extra ?? [])]) assert.match(shown, pattern, `${where}: missing ${pattern}`);

				assert.equal(component.handleMouse?.({ type: "wheel", x: 1, y: 1, wheelDelta: 3 })?.handled, true, `${where}: wheel falls through to the chat`);
				// Only where some body is left: on tiny terminals the frame keeps controls over content.
				// The surface's own header shows a scroller indicator only when the body overflows, so use
				// that to decide whether wheel scrolling can be proven at this size.
				const overflow = /↑\d+ ↓\d+/.test(stripVTControlCharacters(lines[1] ?? ""));
				if (surface.scrolls && overflow && /Paragraph|Bro help|##|\/bro|Finding|Requirement/.test(stripVTControlCharacters(lines.slice(2, -2).join("\n")))) {
					// Raw SGR wheel (Pi 0.84, regular mode): down from the top, or up from a view that starts at the end.
					const view = () => stripVTControlCharacters(component.render(layout.width).join("\n"));
					const before = view();
					{
						const row = layout.row + 5;
						component.handleInput(`\x1b[<65;1;${row}M`);
						assert.equal(view(), before, `${where}: raw wheel outside the overlay scrolls`);
						const column = layout.col + 3;
						component.handleInput(`\x1b[<65;${column};${row}M`);
						const down = view();
						component.handleInput(`\x1b[<64;${column};${row}M`);
						component.handleInput(`\x1b[<64;${column};${row}M`);
						assert.ok(down !== before || view() !== down, `${where}: raw wheel does not scroll`);
						// Normalized wheel (Pi 1.x fullscreen) must move the view too, not just be handled.
						const start = view();
						component.handleMouse({ type: "wheel", x: 1, y: 1, wheelDelta: 3 });
						const moved = view();
						component.handleMouse({ type: "wheel", x: 1, y: 1, wheelDelta: -6 });
						assert.ok(moved !== start || view() !== moved, `${where}: handleMouse wheel does not scroll`);
						scrollChecks++;
					}
				}

				(surface.close ?? ((c) => c.handleInput("\x1b")))(component);
				await mounted.closed;
				const on = mounted.writes.filter((data) => data.includes("1000h")).length;
				const off = mounted.writes.filter((data) => data.includes("1000l")).length;
				assert.equal(on, off, `${where}: mouse reporting left on`);
				assert.equal(on, surface.mouse && mode === "regular" ? 1 : 0, `${where}: mouse reporting ${surface.mouse ? "missing" : "unexpected"}`);
				assert.equal(process.listenerCount("exit"), exitListeners, `${where}: exit listener left behind`);
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(mounted.rendersAfterDispose(), 0, `${where}: render requested after dispose`);
			}
		}
		if (surface.scrolls) assert.ok(scrollChecks > 0, `${surface.name}: scrolling never checked`);
	});
}

test("modal kit: renderFrame keeps borders, hints and notice when space runs out", () => {
	for (const height of [1, 2, 3, 4, 6, 12]) {
		const lines = kit.renderFrame(theme, 30, height, {
			header: () => "Header",
			body: (rows) => Array.from({ length: rows + 5 }, (_, index) => `body ${index}`),
			footer: ["Footer"],
			notice: "Notice",
			hints: "Esc close",
		});
		assert.equal(lines.length, height, `height ${height}`);
		for (const line of lines) assert.equal(visibleWidth(line), 30);
		if (height >= 3) {
			assert.match(lines.at(-1), /└/);
			assert.match(lines.at(-2), /Esc close/);
		}
		if (height >= 5) assert.match(lines.join("\n"), /Notice[\s\S]*Esc close/);
		assert.doesNotMatch(lines.join("\n"), /├─+┤\n[^\n]*├─+┤/, `height ${height}: two rules in a row`);
	}
});

test("modal kit: a long notice shrinks to keep minBody rows", () => {
	const notice = "word ".repeat(40);
	const lines = kit.renderFrame(theme, 30, 12, { header: () => "H", body: (rows) => Array.from({ length: rows }, () => "body"), notice, hints: "Esc close", minBody: 5 });
	assert.equal(lines.filter((line) => line.includes("body")).length, 5);
	assert.match(lines.join("\n"), /word/, "one notice line stays");
});

test("modal kit: modalHeight matches Pi's overlay sizing", () => {
	for (const columns of [40, 60, 80, 121]) {
		for (const rows of [1, 2, 3, 8, 14, 24, 40, 100]) {
			const tui = { mode: "fullscreen", terminal: { rows, columns }, requestRender() {} };
			const layout = hostLayout(kit.BRO_OVERLAY, columns, rows);
			assert.equal(kit.modalHeight(tui), layout.maxHeight, `${columns}x${rows}`);
			assert.deepEqual(
				kit.broOverlayArea(tui, layout.width, layout.maxHeight),
				{ top: layout.row, left: layout.col, width: layout.width, height: layout.maxHeight },
				`${columns}x${rows}: raw mouse bounds`,
			);
		}
	}
	assert.equal(kit.modalHeight({ terminal: { rows: 100 }, requestRender() {} }, kit.BRO_OVERLAY, 32), 32);
});

test("modal kit: Scroller pages, follows the end, and releases follow when scrolled up", () => {
	let scrolled = 0;
	const scroller = new kit.Scroller(() => scrolled++, { followEnd: true });
	const lines = Array.from({ length: 50 }, (_, index) => `${index}`);
	assert.deepEqual(scroller.view(lines, 10), lines.slice(0, 10));
	assert.equal(scroller.handleKey("\x1b[6~"), true, "PgDn");
	assert.equal(scroller.indicator(), "↑9 ↓31");
	scroller.toEnd();
	scroller.view(lines, 10);
	assert.equal(scroller.indicator(), "↑40 ↓0");
	scroller.view([...lines, "more"], 10);
	assert.equal(scroller.indicator(), "↑41 ↓0", "follows new lines at the end");
	scroller.handleMouse({ type: "wheel", wheelDelta: -3 });
	scroller.view([...lines, "more", "again"], 10);
	assert.equal(scroller.indicator(), "↑38 ↓4", "scrolling up stops following");
	assert.equal(scroller.handleKey("x"), false);
	const position = scroller.indicator();
	assert.equal(scroller.handleKey("\x1b[<0;10;5M"), true, "raw clicks are swallowed");
	assert.equal(scroller.indicator(), position, "raw clicks do not scroll");
	assert.equal(scroller.handleMouse({ type: "click" }), undefined);
	assert.equal(scrolled, 2);
});

// Pi 0.84 components have no handleMouse; there the wrappers only swallow the wheel.
test("modal kit: editor and config forward clicks and wheel to their pi-tui children", { skip: typeof Editor.prototype.handleMouse !== "function" }, () => {
	const tui = { mode: "fullscreen", terminal: { rows: 24, columns: 80 }, requestRender() {} };
	const text = (component) => component.render(62).map((line) => stripVTControlCharacters(line));

	let saved;
	const editor = explainModal.createAdvisorSteerModal("hello world", (value) => (saved = value), () => {})(tui, theme, {}, () => {});
	const lines = text(editor);
	const y = lines.findIndex((line) => line.includes("hello world"));
	const x = lines[y].indexOf("world");
	assert.equal(editor.handleMouse({ type: "press", button: "left", x, y }), undefined, "press stays with host text selection");
	assert.equal(editor.handleMouse({ type: "click", button: "left", x, y })?.handled, true);
	editor.handleInput("X");
	editor.handleInput("\x13"); // Ctrl+S
	assert.equal(saved, "hello Xworld", "the click moved the cursor to where it landed");
	assert.equal(editor.handleMouse({ type: "click", button: "left", x: 2, y: 1 }), undefined, "header clicks are not the editor's");

	const config = configUi.createConfigModal(settings, [], async () => {})(tui, theme, {}, () => {});
	const before = text(config).join("\n");
	const row = text(config).findIndex((line) => line.includes("Default model"));
	assert.equal(config.handleMouse({ type: "wheel", x: 3, y: 1, wheelDelta: 1 })?.handled, true);
	assert.equal(text(config).join("\n"), before, "a wheel over the header changes nothing");
	config.handleMouse({ type: "wheel", x: 3, y: row, wheelDelta: 1 });
	assert.notEqual(text(config).join("\n"), before, "a wheel over the list moves the selection");
});

test("modal kit: config blocks hidden actions after resize and recovers when it fits", async () => {
	const saved = [];
	let closed = false;
	const tui = { mode: "fullscreen", terminal: { rows: 40, columns: 80 }, requestRender() {} };
	const config = configUi.createConfigModal(settings, [], async (value) => void saved.push(value))(
		tui,
		theme,
		{},
		() => { closed = true; },
	);

	config.render(62);
	tui.terminal.rows = 8;
	tui.terminal.columns = 40;
	const small = stripVTControlCharacters(config.render(36).join("\n"));
	assert.match(small, /enlarge terminal/);
	assert.match(small, /Esc close/);
	for (let index = 0; index < 3; index++) config.handleInput("\x1b[B");
	config.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(saved.length, 0, "an invisible setting cannot be changed");

	tui.terminal.rows = 40;
	tui.terminal.columns = 80;
	assert.doesNotMatch(stripVTControlCharacters(config.render(62).join("\n")), /enlarge terminal/);
	for (let index = 0; index < 3; index++) config.handleInput("\x1b[B");
	config.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(saved.at(-1)?.showTurns, 2, "configuration resumes after the terminal fits again");
	config.handleInput("\x1b");
	assert.equal(closed, true);
});

for (const save of ["none", "success", "failure"]) {
	test(`modal kit: resize fallback Esc closes a hidden picker safely (${save})`, async () => {
		const tui = { mode: "fullscreen", terminal: { rows: 40, columns: 80 }, requestRender() {} };
		let settle;
		let closes = 0;
		const config = configUi.createConfigModal(settings, [], () => new Promise((resolve, reject) => {
			settle = () => save === "failure" ? reject(new Error("disk full")) : resolve();
		}))(tui, theme, {}, () => closes++);
		const view = () => stripVTControlCharacters(config.render(62).join("\n"));
		view();
		if (save !== "none") {
			for (let index = 0; index < 3; index++) config.handleInput("\x1b[B");
			config.handleInput("\r"); // start saving Show turns
			assert.equal(typeof settle, "function");
			for (let index = 0; index < 3; index++) config.handleInput("\x1b[A");
		}
		config.handleInput("\r"); // open Default model picker
		view();
		tui.terminal.rows = 8;
		assert.match(view(), /Esc close/);
		config.handleInput("\x1b");
		if (save === "none") {
			assert.equal(closes, 1, "one Esc closes config, not just the hidden picker");
		} else {
			assert.equal(closes, 0, "the in-flight save must settle before closing");
			settle();
			await new Promise((resolve) => setImmediate(resolve));
			if (save === "failure") {
				assert.equal(closes, 0, "a failed save cancels the deferred close");
				assert.match(view(), /Reverted/);
				config.handleInput("\x1b");
			}
			assert.equal(closes, 1);
		}
		config.handleInput("\x1b");
		assert.equal(closes, 1, "repeated Esc does not close twice");
	});
}

test("modal kit: config can clear a notice that alone causes resize lockout", async () => {
	const tui = { mode: "fullscreen", terminal: { rows: 40, columns: 80 }, requestRender() {} };
	const config = configUi.createConfigModal(settings, [], async () => { throw Error("disk full"); })(
		tui,
		theme,
		{},
		() => {},
	);

	config.render(62);
	for (let index = 0; index < 3; index++) config.handleInput("\x1b[B");
	config.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));

	let edge;
	for (let rows = 40; rows >= 8; rows--) {
		tui.terminal.rows = rows;
		if (/enlarge terminal/.test(stripVTControlCharacters(config.render(62).join("\n")))) {
			edge = rows;
			break;
		}
	}
	assert.ok(edge, "the failed-save notice reaches an edge-size lockout");
	config.handleInput("x");
	assert.doesNotMatch(
		stripVTControlCharacters(config.render(62).join("\n")),
		/enlarge terminal/,
		"a non-Esc key clears the notice and restores the available row",
	);
});

test("modal kit: the mouse lease pauses while hidden and stays off after close", async () => {
	const writes = [];
	const tui = { mode: "regular", terminal: { rows: 24, columns: 80, write: (data) => writes.push(data) }, requestRender() {} };
	const hiddenStates = [];
	let handle, done;
	const ctx = {
		ui: {
			custom: (factory, options) =>
				new Promise((resolve) => {
					done = resolve;
					factory(tui, theme, {}, resolve);
					options.onHandle({ setHidden: (hidden) => hiddenStates.push(hidden), isHidden: () => false });
				}),
		},
	};
	const closed = kit.openBroOverlay(ctx, () => ({ render: () => [], invalidate() {} }), { mouse: true, onHandle: (h) => (handle = h) });
	const state = () => writes.map((data) => (data.includes("1000h") ? "on" : "off"));
	handle.setHidden(true);
	handle.setHidden(false);
	assert.deepEqual(state(), ["on", "off", "on"]);
	assert.deepEqual(hiddenStates, [true, false], "the host handle still hides and shows");
	assert.equal(typeof handle.isHidden, "function", "the rest of the handle is passed through");
	done();
	await closed;
	handle.setHidden(false);
	assert.deepEqual(state(), ["on", "off", "on", "off"], "un-hiding after close does not turn reporting back on");
});

test("modal kit: rawWheel reads direction and cell, and ignores other mouse reports", async () => {
	const { rawWheel, wheelDelta } = await load("ui-capabilities.js");
	assert.deepEqual(rawWheel("\x1b[<64;12;7M"), { delta: -3, column: 12, row: 7 });
	assert.deepEqual(rawWheel("\x1b[<69;1;2M"), { delta: 3, column: 1, row: 2 }, "a modifier bit keeps the direction");
	assert.equal(rawWheel("\x1b[<0;5;5M"), undefined, "a click is not a wheel");
	assert.equal(rawWheel("\x1b[<66;5;5M"), undefined, "horizontal wheel");
	assert.equal(rawWheel("x"), undefined);
	assert.equal(wheelDelta("\x1b[<65;5;5M"), 3);
});

test("modal kit: renderFrame with fill false sizes to its content", () => {
	const parts = { header: () => "H", body: () => ["one"], hints: "Esc close" };
	assert.equal(kit.renderFrame(theme, 30, 20, parts).length, 20);
	const lines = kit.renderFrame(theme, 30, 20, { ...parts, fill: false });
	assert.equal(lines.length, 7, "border, header, rule, body, rule, hints, border");
	assert.match(lines.at(-1), /└/);
});

test("modal kit: an editor that does not fit asks for a bigger terminal and blocks blind edits", () => {
	let saved;
	let closed = false;
	const tui = { mode: "fullscreen", terminal: { rows: 14, columns: 80 }, requestRender() {} };
	const brief = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"); // long enough for Editor's minimum height
	const editor = explainModal.createAdvisorSteerModal(brief, (value) => (saved = value), () => {})(tui, theme, {}, () => (closed = true));
	const shown = editor.render(62).map((line) => stripVTControlCharacters(line)).join("\n");
	assert.match(shown, /Enlarge the terminal/);
	assert.match(shown, /Esc close/);
	editor.handleInput("X");
	editor.handleInput("\x13"); // Ctrl+S
	assert.equal(saved, undefined, "no save while the editor is hidden");
	tui.terminal.rows = 30;
	editor.render(62);
	editor.handleInput("\x13");
	assert.equal(saved, brief, "the typing above never reached the hidden editor");
	editor.handleInput("\x1b");
	assert.equal(closed, true);
});

test("modal kit: an unusable preferences file keeps its fix-it hint visible at 80x24", async () => {
	await writeFile(settingsModule.PREFERENCES_FILE, "x".repeat(70 * 1024));
	try {
		const mounted = await mount((ctx) => explainModal.showPreferencesModal(ctx), "fullscreen", 80, 24);
		const shown = mounted.component.render(hostLayout(mounted.overlay, 80, 24).width).map((line) => stripVTControlCharacters(line)).join(" ");
		assert.match(shown.replace(/[│\s]+/g, " "), /Unusable preferences file \(Ctrl\+K deletes it\)/);
		mounted.component.handleInput("\x1b");
		await mounted.closed;
	} finally {
		await rm(settingsModule.PREFERENCES_FILE, { force: true });
	}
});

test("modal kit: config ignores clicks on list rows the frame no longer shows", () => {
	let saves = 0;
	const tui = { mode: "fullscreen", terminal: { rows: 30, columns: 80 }, requestRender() {} };
	const config = configUi.createConfigModal(settings, [], async () => void saves++)(tui, theme, {}, () => {});
	tui.terminal.rows = 14; // shrinks after the list was sized at open
	const before = config.render(62);
	const rule = before.length - 2; // the frame's bottom rule, just under the cut list
	config.handleMouse({ type: "press", button: "left", x: 3, y: rule });
	config.handleMouse({ type: "click", button: "left", x: 3, y: rule });
	assert.equal(saves, 0, "a hidden setting was changed");
	assert.deepEqual(config.render(62), before);
});

test("modal kit: a failed save never locks the editor, and Ctrl+C always copies", async () => {
	const tui = { mode: "fullscreen", terminal: { rows: 24, columns: 60 }, requestRender() {} };
	const brief = Array.from({ length: 15 }, (_, index) => `line ${index}`).join("\n");
	let saves = 0;
	let copied;
	const onSave = (value) => {
		if (++saves === 1) throw new Error("disk full while writing the advisor steering entry to the session file, try again later");
		return value;
	};
	const editor = explainModal.createAdvisorSteerModal(brief, onSave, () => {}, async (text) => void (copied = text))(tui, theme, {}, () => {});
	const view = () => editor.render(48).map((line) => stripVTControlCharacters(line)).join("\n");
	editor.handleInput("\x13"); // Ctrl+S fails and shows a long notice
	const afterFailure = view();
	assert.match(afterFailure, /Save failed/);
	assert.doesNotMatch(afterFailure, /Enlarge the terminal/, "the notice gave way to the editor");
	assert.equal(view(), afterFailure, "the screen is stable between renders");
	editor.handleInput("\x13");
	assert.equal(saves, 2, "saving again still works");

	tui.terminal.rows = 14; // now the editor really does not fit
	view();
	const small = view();
	assert.match(small, /Enlarge the terminal/);
	assert.match(small.replace(/[│\s]+/g, " "), /Ctrl\+C still copies the text/);
	assert.equal(view(), small, "the screen is stable between renders");
	editor.handleInput("\x03"); // Ctrl+C
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(copied, brief, "the draft can be rescued");
});

test("modal kit: config keeps its key hints after a long save error on a short terminal", async () => {
	const tui = { mode: "fullscreen", terminal: { rows: 14, columns: 60 }, requestRender() {} };
	const config = configUi.createConfigModal(settings, [], async () => {
		throw new Error("disk full while writing the settings file, which is a long message on purpose");
	})(tui, theme, {}, () => {});
	config.handleInput("\x1b[B"); // Default effort
	config.handleInput("\x1b[B"); // Explain mode
	config.handleInput("\r"); // cycle the value and try to save
	for (let i = 0; i < 50 && !config.render(48).join("\n").includes("Reverted"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	const shown = config.render(48).map((line) => stripVTControlCharacters(line)).join("\n");
	assert.match(shown, /Reverted to the last saved settings/);
	assert.match(shown, /Esc/, "SettingsList's hints are still on screen");
});

test("modal kit: a one-line notice that tips the editor out is cleared by any key", async () => {
	const brief = Array.from({ length: 15 }, (_, index) => `line ${index}`).join("\n");
	let tipped = 0;
	for (let rows = 12; rows <= 26; rows++) {
		const tui = { mode: "fullscreen", terminal: { rows, columns: 60 }, requestRender() {} };
		let saved;
		const editor = explainModal.createPreferencesModal({ text: brief }, { save: async (value) => void (saved = value), clear: async () => {} }, async () => {})(tui, theme, {}, () => {});
		const view = () => editor.render(48).map((line) => stripVTControlCharacters(line)).join("\n");
		if (/Enlarge the terminal/.test(view())) continue; // too small even without a notice
		editor.handleInput("\x03"); // Ctrl+C shows "Copied"
		await new Promise((resolve) => setImmediate(resolve));
		if (!/Enlarge the terminal/.test(view())) continue; // the notice fit
		tipped++;
		assert.match(view().replace(/[│\s]+/g, " "), /any key clears the message/, `${rows} rows: says how to recover`);
		editor.handleInput("q"); // swallowed: it only clears the notice
		assert.doesNotMatch(view(), /Enlarge the terminal/, `${rows} rows: the editor came back`);
		editor.handleInput("\x13"); // Ctrl+S works again
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(saved, brief, `${rows} rows: the clearing key was not typed`);
	}
	assert.ok(tipped > 0, "no size tipped the editor; the test no longer exercises the edge");
});

test("modal kit: the editor never shows without its full privacy sentence or cut short", () => {
	for (const [cols, rows] of [[40, 24], [48, 30], [60, 22], [80, 24]]) {
		const tui = { mode: "fullscreen", terminal: { rows, columns: cols }, requestRender() {} };
		const editor = explainModal.createPreferencesModal({}, { save: async () => {}, clear: async () => {} })(tui, theme, {}, () => {});
		const lines = editor.render(hostLayout(kit.BRO_OVERLAY, cols, rows).width).map((line) => stripVTControlCharacters(line));
		const shown = lines.join(" ").replace(/[│\s]+/g, " ");
		if (/Enlarge the terminal/.test(shown)) continue;
		assert.match(shown, /Never sent to the advisor or Pi's main model\./, `${cols}x${rows}`);
		// ...and the editor is whole: its bottom border sits right above the frame's lower rule.
		const lowerRule = lines.findLastIndex((line) => line.startsWith("├"));
		assert.match(lines[lowerRule - 1], /^│─[─ ↓\w]*─│$/, `${cols}x${rows}: editor cut`);
	}
});

// The checklist and the action row must never lose the user's place or their target. This replaces
// the old number-key test: toggling is now Space on a highlighted row, so the row is always visible.
test("modal kit: elevate keeps the target visible and the reader's place", async () => {
	const mounted = await mount(elevateStage("review"), "fullscreen", 80, 24);
	const { component } = mounted;
	const layout = hostLayout(mounted.overlay, 80, 24);
	const header = () => stripVTControlCharacters(component.render(layout.width)[1]);
	const body = () => stripVTControlCharacters(component.render(layout.width).slice(3, -3).join("\n"));
	component.render(layout.width);

	// Space or Enter both toggle the highlighted finding, and the marker follows the cursor.
	assert.match(body(), /› \[ \] 1\./, "the cursor is not on the first finding");
	component.handleInput(" ");
	assert.match(body(), /› \[x\] 1\./, "Space did not tick the highlighted finding");
	component.handleInput("\x1b[B");
	assert.match(body(), /› \[ \] 2\./, "Down did not move the cursor");
	assert.match(body(), /  \[x\] 1\./, "moving the cursor unticked a finding");
	component.handleInput(" ");
	assert.equal(component.currentSelection.size, 2, "Space did not tick the second finding");

	// The count on the button and in the header agree with the ticks. The label may shorten to fit,
	// so match the count itself.
	assert.match(stripVTControlCharacters(component.render(layout.width).join("\n")), /Rewrite (\(|with )2/, "the action row does not show the selected count");
	assert.match(header(), /2\/5 selected/);

	// Enter toggles the same way Space does; Tab is what moves focus to the buttons.
	component.handleInput("\r");
	assert.equal(component.currentSelection.size, 1, "Enter did not toggle the highlighted finding");
	component.handleInput("\t");
	assert.match(stripVTControlCharacters(component.render(layout.width).join("\n")), /›\[Rewrite/, "Tab did not focus the action row");
	// Rewriting with nothing selected is refused with an explanation rather than doing nothing.
	// Navigate to [Select none] and activate it, then try Rewrite.
	component.handleInput("\x1b[C"); // right: Select all
	component.handleInput("\x1b[C"); // right: Select none
	component.handleInput("\r");
	assert.equal(component.currentSelection.size, 0, "Select none did not clear the ticks");
	component.handleInput("\x1b[D"); // left: Select all
	component.handleInput("\x1b[D"); // left: Rewrite
	component.handleInput("\r");
	assert.equal(component.currentStage, "review", "rewrite ran with no findings selected");
	assert.match(stripVTControlCharacters(component.render(layout.width).join("\n")), /at least one finding/);

	component.handleInput("\x1b");
	await mounted.closed;
});

// Compose is a real multi-line editor: a pasted objective must keep its structure, and the modal
// must refuse to edit rather than draw the Editor cut short.
test("modal kit: elevate compose accepts a multi-line objective and guards a tiny terminal", async () => {
	const mounted = await mount((ctx) => kit.openBroOverlay(ctx, (tui, theme, _kb, done) => new elevate.ElevateModal(tui, theme, () => done(), () => {}, () => {}, () => {}, () => {}, () => done()), { mouse: true }), "fullscreen", 80, 24);
	const { component, tui } = mounted;
	const view = () => stripVTControlCharacters(component.render(78).join("\n"));
	assert.match(view(), /Your objective/);
	assert.match(view(), /Discover/, "the action row is missing in compose");
	// A multi-line objective is typed straight in and rendered line by line, not flattened.
	component.setCompose("Line one\nLine two");
	assert.match(view(), /Line one/);
	assert.match(view(), /Line two/, "the second line was dropped: compose is still single-line");
	// On a terminal too short for the whole Editor the user is told to enlarge it.
	tui.terminal.rows = 12;
	const small = view();
	assert.match(small, /Enlarge the terminal/i, "no small-terminal guard in compose");
	assert.doesNotMatch(small, /Line one/, "an Editor too small to render whole was still drawn");
	component.handleInput("\x1b");
	await mounted.closed;
});

// A failed rewrite must repeat the rewrite, not silently re-run discovery and discard the approvals.
// The modal's onRetry is routed by openElevateModal's pending-step bookkeeping, so this asserts the
// routing decision itself: after a rewrite fails, retry must ask for another rewrite with the SAME
// approvals, and must not ask for discovery.
test("modal kit: elevate retry repeats the failed step and keeps approvals", async () => {
	const calls = [];
	const modal = new elevate.ElevateModal(
		{ mode: "fullscreen", terminal: { rows: 30, columns: 80 }, requestRender() {} },
		theme,
		() => {},
		(objective) => calls.push(["discover", objective]),
		(indexes) => calls.push(["upgrade", [...indexes]]),
		() => {},
		() => { const last = calls.at(-1); calls.push(last?.[0] === "upgrade" ? ["upgrade", last[1]] : ["discover", "objective"]); },
		() => {},
	);
	modal.setDiscovery({ assessment: "a", findings: [
		{ dimension: "depth", title: "One", why: "w", expertMove: "m" },
		{ dimension: "range", title: "Two", why: "w", expertMove: "m" },
	] });
	modal.render(78);
	modal.handleInput(" ");    // tick only finding 1
	modal.handleInput("\t");
	modal.handleInput("\r");   // rewrite with 1 selected
	assert.deepEqual(calls, [["upgrade", [0]]], "the rewrite did not start with the ticked finding");
	modal.setFailed("Bro returned an empty request. Retry.");
	modal.render(78);
	modal.handleInput("\r");   // [Retry] is focused first
	// Decisive: a second upgrade carrying the same approvals, and no discovery at all.
	assert.equal(calls.length, 2, "retry did not run anything");
	assert.deepEqual(calls[1], ["upgrade", [0]], "retry re-ran discovery instead of the failed rewrite");
	assert.equal(calls.filter(([kind]) => kind === "discover").length, 0, "retry ran discovery");
});

// Regression suite for the states that broke in review: dead zones, hidden editing, and the fit-guard
// flip. Each assertion below failed against the first rebuild.
test("modal kit: elevate has no dead zone and never edits an invisible Editor", async () => {
	const mk = (rows, cols) => new elevate.ElevateModal(
		{ mode: "fullscreen", terminal: { rows, columns: cols }, requestRender() {} }, theme, () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
	const findings = [{ dimension: "depth", title: "One", why: "w", expertMove: "m" }];

	// Ready and failed offer only the action row: Tab must not move focus somewhere with no keys.
	for (const stage of ["ready", "failed"]) {
		const modal = mk(30, 80);
		modal.setDiscovery({ assessment: "a", findings });
		if (stage === "ready") modal.setReady("rewrite"); else modal.setFailed("nope");
		modal.handleInput("\t");
		assert.equal(modal.currentZone, "actions", `${stage}: Tab left the action row`);
		modal.handleInput("\t");
		assert.equal(modal.currentZone, "actions", `${stage}: Tab cycled into a dead zone`);
	}

	// A guard that flips on render makes the Editor and the warning alternate forever.
	for (const [cols, rows] of [[70, 18], [84, 17], [90, 17], [98, 17], [120, 40]]) {
		const modal = mk(rows, cols);
		const seen = [];
		for (let index = 0; index < 4; index++) { modal.render(cols - 2); seen.push(modal.tooSmall); }
		assert.ok(seen.every((value) => value === seen[0]), `${cols}x${rows}: the fit guard flipped (${seen.join(",")})`);
	}

	// While the Editor cannot be drawn whole it must not accept edits that the user cannot see.
	const small = mk(12, 80);
	small.render(78);
	assert.equal(small.tooSmall, true, "the tiny-terminal guard did not engage");
	small.handleInput("H");
	small.handleInput("I");
	assert.equal(small.editor.getExpandedText(), "", "typing edited an Editor the user cannot see");

	// Ctrl+C must always rescue the objective, in every stage that has one.
	let copied = "";
	const copier = new elevate.ElevateModal(
		{ mode: "fullscreen", terminal: { rows: 30, columns: 80 }, requestRender() {} }, theme, () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
	copier.copy = (text) => { copied = text; return Promise.resolve(); };
	copier.setDiscovering("MY VALUABLE OBJECTIVE");
	copier.setDiscovery({ assessment: "a", findings });
	copier.handleInput("\x03");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(copied, "MY VALUABLE OBJECTIVE", "Ctrl+C copied nothing while reviewing findings");

	// A click inside the Editor must map to the cell the user clicked. Pi 0.84's Editor has no
	// handleMouse, so that version forwards nothing and leaves the click to host text selection; both
	// cases must at least keep the wheel swallowed. Version-gated like the shared kit's own test.
	const clicker = mk(30, 80);
	clicker.setCompose("hello");
	clicker.render(78);
	const area = clicker.editorArea;
	assert.ok(area.top >= 3, "editorArea ignores the frame rows above the body");
	assert.equal(area.left, 1, "editorArea ignores the frame's left border");
	const click = { type: "click", button: "left", x: 1, y: area.top };
	if (typeof Editor.prototype.handleMouse === "function") {
		assert.equal(clicker.handleMouse(click)?.handled, true, "a click on the Editor was dropped");
	} else {
		assert.equal(clicker.handleMouse(click), undefined, "Pi 0.84 must leave the click to host text selection");
	}
	assert.equal(clicker.handleMouse({ type: "wheel", x: 1, y: 1, wheelDelta: 3 })?.handled, true, "the wheel escaped the overlay");
});

// Ctrl+Enter needs the kitty keyboard protocol, so many terminals deliver nothing. Ctrl+S is the
// fallback, and it must not be documented-only.
test("modal kit: elevate starts discovery from the button and from Ctrl+S", async () => {
	const started = [];
	const modal = new elevate.ElevateModal(
		{ mode: "fullscreen", terminal: { rows: 30, columns: 80 }, requestRender() {} }, theme, () => {}, (objective) => started.push(objective), () => {}, () => {}, () => {}, () => {});
	modal.setCompose("the objective");
	modal.render(78);
	modal.handleInput("\x13"); // Ctrl+S
	assert.deepEqual(started, ["the objective"], "Ctrl+S did not start discovery");
	// The button path must work too, for terminals that deliver neither chord.
	modal.render(78);
	modal.handleInput("\t");
	modal.handleInput("\r");
	assert.deepEqual(started, ["the objective", "the objective"], "the [Discover gaps] button did not start discovery");
});
