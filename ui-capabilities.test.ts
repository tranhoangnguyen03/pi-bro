import assert from "node:assert/strict";
import test from "node:test";
import { hasBroCustomUi, broModalRows, canBroInsertIntoEditor, insertBroDesktopText } from "./ui-capabilities.ts";

test('atomic insertion requires capability and method and preserves structured outcomes', async () => {
  let calls=0;
  const ui={getDesktopUiCapabilities:()=>({version:1,customTui:true,viewport:true,atomicEditorInsert:true}),insertEditorTextIfEmpty:async (_text:string)=>{calls++;return 'inserted' as const;}};
  assert.equal(await insertBroDesktopText({mode:'tui',ui},'x'),'unavailable');assert.equal(calls,0);
  assert.equal(await insertBroDesktopText({mode:'rpc',ui},'x'),'inserted');assert.equal(calls,1);
  assert.equal(await insertBroDesktopText({mode:'rpc',ui:{...ui,insertEditorTextIfEmpty:async()=> 'not_empty'}},'x'),'not_empty');
  assert.equal(await insertBroDesktopText({mode:'rpc',ui:{...ui,insertEditorTextIfEmpty:async()=>{throw Error('gone')}}},'x'),'unavailable');
  assert.equal(await insertBroDesktopText({mode:'rpc',ui:{getDesktopUiCapabilities:ui.getDesktopUiCapabilities}},'x'),'unavailable');
});

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
test("headless-channel capability withdrawal is honored on every call", () => {
	let interactive = true;
	const ctx = { mode: "rpc", ui: { getDesktopUiCapabilities: () => interactive ? desktopUi : undefined } };
	assert.equal(hasBroCustomUi(ctx), true); interactive = false; assert.equal(hasBroCustomUi(ctx), false);
});
test("virtual viewport beats stdout; ordinary TUI retains stdout fallback", () => {
	assert.equal(broModalRows({ terminal: { rows: 55 } }, 24), 55);
	assert.equal(broModalRows({}, 24), 24); assert.equal(broModalRows({}, undefined), 30);
	assert.equal(broModalRows({ terminal: { rows: NaN } }, 24), 24);
});
test("desktop insertion fails closed; terminal behavior is preserved", () => {
	assert.equal(canBroInsertIntoEditor({ mode: "rpc", ui: { getDesktopUiCapabilities: () => desktopUi } }), false);
	assert.equal(canBroInsertIntoEditor({ mode: "tui", ui: {} }), true);
});

test("capability query survives the SDK's shallow UI wrapper without caching availability", () => {
	let interactive = true;
	const source = { getDesktopUiCapabilities: () => interactive ? desktopUi : undefined };
	const wrapped = { ...source };
	const ctx = { mode: "rpc", ui: wrapped };
	assert.equal(hasBroCustomUi(ctx), true); interactive = false; assert.equal(hasBroCustomUi(ctx), false);
});
test("a broken capability query fails closed", () => {
	assert.equal(hasBroCustomUi({ mode: "rpc", ui: { getDesktopUiCapabilities() { throw new Error("gone"); } } }), false);
});
