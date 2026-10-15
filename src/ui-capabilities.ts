/** Local structural contract. This does not extend, patch, or impersonate the upstream Pi API. */
type UiContext = { mode: string; ui: unknown };
type DesktopUi = { getDesktopUiCapabilities?: () => unknown };

export function hasBroCustomUi(ctx: UiContext): boolean {
	if (ctx.mode === "tui") return true;
	if (ctx.mode !== "rpc" || !ctx.ui || typeof ctx.ui !== "object") return false;
	const query = (ctx.ui as DesktopUi).getDesktopUiCapabilities;
	if (typeof query !== "function") return false;
	try {
		const value = query.call(ctx.ui);
		if (!value || typeof value !== "object") return false;
		const capability = value as { version?: unknown; customTui?: unknown; viewport?: unknown };
		return capability.version === 1 && capability.customTui === true && capability.viewport === true;
	} catch { return false; }
}

/** Read a virtual terminal's actual viewport in desktop mode; preserve terminal behavior elsewhere. */
export function broModalRows(tui: unknown, terminalRows: number | undefined): number {
	const rows = tui && typeof tui === "object" ? (tui as { terminal?: { rows?: unknown } }).terminal?.rows : undefined;
	const candidate = typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? rows : terminalRows;
	return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 ? Math.floor(candidate) : 30;
}

export async function insertBroDesktopText(ctx: UiContext, text: string): Promise<"inserted" | "not_empty" | "unavailable"> {
  if (!hasBroCustomUi(ctx) || ctx.mode !== "rpc") return "unavailable";
  const ui = ctx.ui as DesktopUi & { insertEditorTextIfEmpty?: (text: string) => Promise<"inserted" | "not_empty" | "unavailable"> };
  try {
    const caps = ui.getDesktopUiCapabilities?.() as { atomicEditorInsert?: boolean } | undefined;
    return caps?.atomicEditorInsert === true && ui.insertEditorTextIfEmpty ? await ui.insertEditorTextIfEmpty(text) : "unavailable";
  } catch { return "unavailable"; }
}

/** Only terminal mode uses synchronous insertion; Desktop uses insertBroDesktopText instead. */
export function canBroInsertIntoEditor(ctx: UiContext): boolean { return ctx.mode === "tui"; }

/** Any raw SGR mouse report; regular-mode reporting delivers these to handleInput. */
export const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/;

/** A raw SGR wheel report (Pi 0.84 and regular mode): ±3 lines at a 1-based terminal cell. */
export function rawWheel(data: string): { delta: number; column: number; row: number } | undefined {
	const match = SGR_MOUSE.exec(data);
	const button = match ? Number.parseInt(match[1]!, 10) : 0;
	if ((button & 64) === 0 || (button & 3) > 1) return undefined;
	return { delta: button & 1 ? 3 : -3, column: Number(match![2]), row: Number(match![3]) };
}

export function wheelDelta(data: string): number {
	return rawWheel(data)?.delta ?? 0;
}

/** Structural subset of pi-tui's mouse event; Pi 0.84 declares no mouse types. */
export type BroMouseEvent = { type: string; x?: number; y?: number; wheelDelta?: number };
export type BroMouseResult = { handled: boolean; render: boolean } | undefined;

/** Pi 1.2+ scrolls the chat behind an overlay whose handleMouse leaves a wheel unhandled. */
export function consumeWheel(event: BroMouseEvent): BroMouseResult {
	return event.type === "wheel" ? { handled: true, render: false } : undefined;
}

export function setRegularMouseReporting(
	tui: { readonly mode: "regular" | "fullscreen"; readonly terminal?: { write?: (data: string) => void } },
	enabled: boolean,
): void {
	if (tui.mode === "regular") tui.terminal?.write?.(`\x1b[?1000${enabled ? "h" : "l"}\x1b[?1006${enabled ? "h" : "l"}`);
}

