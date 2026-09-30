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

/** Desktop's synchronous getEditorText is not the live editor. Until atomic insert exists, refuse. */
export function canBroInsertIntoEditor(ctx: UiContext): boolean { return ctx.mode === "tui"; }
