import assert from "node:assert/strict";
import test from "node:test";
import { hasBroCustomUi, broModalRows } from "../src/ui-capabilities.ts";

const desktopUi = { version: 1, customTui: true, viewport: true };
test("terminal UI remains supported", () => assert.equal(hasBroCustomUi({ mode: "tui", ui: {} }), true));
test("RPC requires the explicit versioned desktop profile", () => {
	assert.equal(hasBroCustomUi({ mode: "rpc", ui: { getDesktopUiCapabilities: () => desktopUi } }), true);
	for (const ui of [undefined, {}, { custom() {} }, { getDesktopUiCapabilities: () => ({ version: 2, customTui: true, viewport: true }) }, { getDesktopUiCapabilities: () => ({ version: 1, customTui: true }) }]) {
		assert.equal(hasBroCustomUi({ mode: "rpc", ui }), false);
	}
});
test("print/json stay headless even if a marker is present", () => {
	for (const mode of ["json", "print"]) assert.equal(hasBroCustomUi({ mode, ui: { getDesktopUiCapabilities: () => desktopUi } }), false);
});
test("headless-channel capability withdrawal is honored on every call, including through shallow UI wrappers", () => {
	let interactive = true;
	const source = { getDesktopUiCapabilities: () => (interactive ? desktopUi : undefined) };
	for (const ui of [source, { ...source }]) {
		const ctx = { mode: "rpc", ui };
		interactive = true;
		assert.equal(hasBroCustomUi(ctx), true);
		interactive = false;
		assert.equal(hasBroCustomUi(ctx), false);
	}
});
test("virtual viewport beats stdout; ordinary TUI retains stdout fallback", () => {
	assert.equal(broModalRows({ terminal: { rows: 55 } }, 24), 55);
	assert.equal(broModalRows({}, 24), 24); assert.equal(broModalRows({}, undefined), 30);
	assert.equal(broModalRows({ terminal: { rows: NaN } }, 24), 24);
});
test("a broken capability query fails closed", () => {
	assert.equal(hasBroCustomUi({ mode: "rpc", ui: { getDesktopUiCapabilities() { throw new Error("gone"); } } }), false);
});
