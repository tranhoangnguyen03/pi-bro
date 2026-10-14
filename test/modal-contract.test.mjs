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
import { btw, buildDir, configUi, explainModal } from "./test-build.mjs";

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
		ui: {
			notify() {},
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
	return { ...mounted, writes, rendersAfterDispose: () => rendersAfterDispose };
}

// Mounted the way their /bro commands mount them, minus the file and settings reads.
const factoryRow = (create) => (ctx) => kit.openBroOverlay(ctx, create());

const SURFACES = [
	{ name: "explain result", scrolls: true, mouse: true, open: (ctx) => explainModal.showBroModal(ctx, { result: { text: long, model: "m" } }) },
	{ name: "explain loading", mouse: true, open: (ctx) => explainModal.showBroModal(ctx, { run: () => new Promise(() => {}) }) },
	{ name: "help", scrolls: true, mouse: true, open: (ctx) => explainModal.showBroModal(ctx, { text: explainModal.helpText(), kind: "help", copyable: true }) },
	{
		name: "btw with a long thread and a notice",
		scrolls: true,
		mouse: true,
		open: (ctx) => btw.openBtwModal(ctx, { thread: { turns: [{ question: "Why?", answer: long }], full: false } }),
		after: (component) => component.setNotice("A long notice that wraps across more than one line of the btw window footer, and then some."),
	},
	// shortcut rows: pi-tui's Editor has a fixed minimum height, so the editors fit from ~22 rows.
	{ name: "preferences", minRows: 22, open: factoryRow(() => explainModal.createPreferencesModal({}, { save: async () => {}, clear: async () => {} })) },
	{ name: "advisor-steer", minRows: 22, open: factoryRow(() => explainModal.createAdvisorSteerModal(long, () => {}, () => {})) },
	{ name: "config", shows: [/Esc/], open: factoryRow(() => configUi.createConfigModal(settings, [], async () => {})) },
	{
		name: "config with the model picker open",
		shows: [/Esc/],
		open: factoryRow(() => configUi.createConfigModal(settings, [], async () => {})),
		after: (component) => component.handleInput("\r"),
		// The first Esc only closes the picker.
		close: (component) => ["\x1b", "\x1b"].forEach((key) => component.handleInput(key)),
	},
	{ name: "Guided Review acquisition", open: (ctx) => openGuidedReview(ctx, "https://github.com/a/b/pull/99", "") },
	{ name: "Guided Review workspace", mouse: true, open: (ctx) => openGuidedReview(ctx, "resume", "") },
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
				if (rows >= (surface.minRows ?? 0)) {
					assert.ok(lines.length <= layout.maxHeight, `${where}: ${lines.length} rows > ${layout.maxHeight}`);
					// Guided Review keeps its rounded frame.
					if (layout.maxHeight >= 3) assert.match(lines.at(-1), /[└╰]/, `${where}: bottom border clipped`);
				}
				const shown = stripVTControlCharacters(lines.join("\n"));
				for (const pattern of surface.shows ?? []) assert.match(shown, pattern, `${where}: missing ${pattern}`);

				assert.equal(component.handleMouse?.({ type: "wheel", x: 1, y: 1, wheelDelta: 3 })?.handled, true, `${where}: wheel falls through to the chat`);
				// Only where some body is left: on tiny terminals the frame keeps controls over content.
				if (surface.scrolls && /Paragraph|Bro help|##|\/bro/.test(stripVTControlCharacters(lines.slice(2, -2).join("\n")))) {
					// Raw SGR wheel (Pi 0.84, regular mode): down from the top, or up from a view that starts at the end.
					const view = () => stripVTControlCharacters(component.render(layout.width).join("\n"));
					const before = view();
					const row = layout.row + 5;
					component.handleInput(`\x1b[<65;1;${row}M`);
					assert.equal(view(), before, `${where}: raw wheel outside the overlay scrolls`);
					const column = layout.col + 3;
					component.handleInput(`\x1b[<65;${column};${row}M`);
					const down = view();
					component.handleInput(`\x1b[<64;${column};${row}M`);
					component.handleInput(`\x1b[<64;${column};${row}M`);
					assert.ok(down !== before || view() !== down, `${where}: raw wheel does not scroll`);
					scrollChecks++;
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
	}
});

test("modal kit: modalHeight matches Pi's overlay sizing", () => {
	for (const rows of [1, 2, 3, 8, 14, 24, 40, 100]) {
		const tui = { mode: "fullscreen", terminal: { rows, columns: 80 }, requestRender() {} };
		const layout = hostLayout(kit.BRO_OVERLAY, 80, rows);
		assert.equal(kit.modalHeight(tui), layout.maxHeight, `${rows} rows`);
		assert.deepEqual(
			kit.broOverlayArea(tui, layout.width, layout.maxHeight),
			{ top: layout.row, left: layout.col, width: layout.width, height: layout.maxHeight },
			`${rows} rows: raw mouse bounds`,
		);
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
