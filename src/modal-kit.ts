import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type OverlayHandle, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";
import { broModalRows, consumeWheel, rawWheel, setRegularMouseReporting, SGR_MOUSE, type BroMouseEvent, type BroMouseResult } from "./ui-capabilities.ts";

// Shared building blocks for Bro's overlays; see docs/plans/modal-consistency.md.

type Mounted = Component & { dispose?(): void };
export type Area = { top: number; left: number; width: number; height: number };
export type Theme = ExtensionCommandContext["ui"]["theme"];
export type TuiLike = {
	readonly mode: "regular" | "fullscreen";
	readonly terminal?: { rows?: number; columns?: number; write?: (data: string) => void };
	requestRender(): void;
};

/** One overlay preset for Bro's windows. Drawn heights come from the same numbers via modalHeight. */
export const BRO_OVERLAY = {
	width: "78%",
	minWidth: 48,
	maxHeight: "78%",
	anchor: "top-center",
	margin: { top: 1, left: 2, right: 2 },
} as const;

type HeightOptions = { readonly maxHeight: `${number}%`; readonly margin: { readonly top?: number; readonly bottom?: number } };

/** Rows the host lets the overlay show; mirrors pi-tui's resolveOverlayLayout (floor, clamp to margins, min 1). */
export function modalHeight(tui: unknown, overlay: HeightOptions = BRO_OVERLAY, cap = Infinity): number {
	const rows = broModalRows(tui, process.stdout.rows);
	const percent = Math.floor((rows * Number.parseFloat(overlay.maxHeight)) / 100);
	const available = Math.max(1, rows - (overlay.margin.top ?? 0) - (overlay.margin.bottom ?? 0));
	return Math.max(1, Math.min(percent, available, cap));
}

/** Terminal-cell bounds for the rendered top-centred Bro overlay. */
export function broOverlayArea(tui: TuiLike, width: number, height: number): Area {
	const columns = tui.terminal?.columns;
	const centered = typeof columns === "number" ? Math.floor((columns - width) / 2) : 0;
	return {
		top: BRO_OVERLAY.margin.top,
		left: Math.max(BRO_OVERLAY.margin.left, centered),
		width,
		height,
	};
}

export type FrameParts = {
	/** Header line, already styled; called after `body` so it can show the scroll position. */
	header: () => string;
	/** Called with the rows left for the body; return at most that many lines. */
	body: (rows: number, innerWidth: number) => string[];
	/** Lines under the body, e.g. a composer; truncated to the inner width, so wrap long text first. */
	footer?: string[];
	/** Already styled; wrapped to at most three lines, above the hints. Put the action first. */
	notice?: string;
	/** Omit when the body prints its own hints (config's SettingsList). */
	hints?: string;
	/** Lines rendered under the hints, e.g. a focusable action row. Wrapped by the caller; a line
	 * wider than the frame is truncated, so keep a single label narrower than the modal. */
	footerAfterHints?: string;
	/** false: size to the content instead of padding the body to the full height. */
	fill?: boolean;
	/** Body rows the notice must leave free; it shrinks to one line before taking them. */
	minBody?: number;
};

/**
 * Square frame that never renders more than `height` lines (exactly `height` unless `fill` is false).
 * Pi clips overlays from the bottom, so when space runs out the notice shrinks to `minBody`, the
 * body shrinks, then lines go from the top of the frame's middle (header, rules, notice), keeping
 * the footer (e.g. a composer), the hints and both borders.
 */
export function renderFrame(theme: Theme, width: number, height: number, parts: FrameParts): string[] {
	const inner = Math.max(1, width - 2);
	const border = (text: string) => theme.fg("border", text);
	const row = (content: string) => {
		const line = truncateToWidth(content, inner, "");
		return `${border("│")}${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))}${border("│")}`;
	};
	const rule = border(`├${"─".repeat(inner)}┤`);
	const footer = parts.footer ?? [];
	// Wrapped, not truncated: Esc comes last in every hint line and must not be cut off.
	const hints = parts.hints ? wrapTextWithAnsi(theme.fg("dim", parts.hints), inner) : [];
	// The action row is already wrapped by the caller, so keep its own line breaks.
	const belowHints = parts.footerAfterHints ? parts.footerAfterHints.split("\n").map((line) => truncateToWidth(line, inner, "")) : [];
	const notice = parts.notice ? wrapTextWithAnsi(parts.notice, inner).slice(0, 3) : [];
	while (notice.length > 1 && height - 5 - footer.length - hints.length - belowHints.length - notice.length < (parts.minBody ?? 0)) notice.pop();
	// The notice sits above the footer so it is dropped before a composer when space runs out.
	const below = [...notice, ...footer, ...hints, ...belowHints];
	const bodyRows = Math.max(0, height - 5 - below.length);
	const body = bodyRows ? parts.body(bodyRows, inner).slice(0, bodyRows) : [];
	if (parts.fill !== false) while (body.length < bodyRows) body.push("");
	const middle = [row(parts.header()), rule, ...(bodyRows ? [...body.map(row), rule] : []), ...below.map(row)];
	return [border(`┌${"─".repeat(inner)}┐`), ...middle.slice(-Math.max(0, height - 2)), border(`└${"─".repeat(inner)}┘`)].slice(0, height);
}

/** Line-based scrolling for a body: keys, both wheel paths and an ↑/↓ indicator. */
export class Scroller {
	private offset = 0;
	private max = 0;
	private rows = 1;
	private follow = false;

	/** `followEnd`: scrolling to the end pins the view to new text until the reader scrolls up. */
	constructor(
		private readonly onScroll: () => void,
		private readonly options: { followEnd?: boolean } = {},
	) {}

	view(lines: string[], rows: number): string[] {
		this.rows = Math.max(1, rows);
		this.max = Math.max(0, lines.length - this.rows);
		this.offset = this.follow ? this.max : Math.max(0, Math.min(this.offset, this.max));
		return lines.slice(this.offset, this.offset + this.rows);
	}

	by(delta: number): void {
		this.offset = Math.max(0, Math.min(this.offset + delta, this.max));
		this.follow = Boolean(this.options.followEnd) && this.offset >= this.max;
		this.onScroll();
	}

	toStart(): void {
		this.offset = 0;
		this.follow = false;
	}

	toEnd(): void {
		this.follow = true;
	}

	/** ↑/↓ one line, PgUp/PgDn one page, and raw SGR mouse input (Pi 0.84, regular mode). */
	handleKey(data: string, area?: Area): boolean {
		if (SGR_MOUSE.test(data)) {
			const wheel = rawWheel(data);
			const x = (wheel?.column ?? 0) - 1;
			const y = (wheel?.row ?? 0) - 1;
			if (
				wheel &&
				(!area || (x >= area.left && x < area.left + area.width && y >= area.top && y < area.top + area.height))
			) this.by(wheel.delta);
			return true;
		}
		const page = Math.max(1, this.rows - 1);
		const delta =
			(matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0) ||
			(matchesKey(data, "pageUp") ? -page : matchesKey(data, "pageDown") ? page : 0);
		if (!delta) return false;
		this.by(delta);
		return true;
	}

	/** Pi 1.x delivers the wheel here; it is always consumed so the chat behind never scrolls. */
	handleMouse(event: BroMouseEvent): BroMouseResult {
		if (event.type !== "wheel") return;
		const delta = Math.trunc(event.wheelDelta ?? 0);
		if (delta) this.by(delta);
		return { handled: true, render: false };
	}

	indicator(): string {
		return this.max > 0 ? `↑${this.offset} ↓${this.max - this.offset}` : "";
	}
}

/**
 * Render a focusable action row: the focused button carries a leading marker and accent colour, so a
 * keypress always has exactly one visible target. Callers own focus, keys and activation; this only
 * draws, which is why Guided Review can keep its own navigation and layout.
 */
export function buttonLabels(theme: Theme, labels: readonly string[], focused?: number): string[] {
	return labels.map((label, index) => {
		const text = `${index === focused ? "›" : ""}[${label}]`;
		return index === focused ? theme.bold(theme.fg("accent", text)) : text;
	});
}

/**
 * Pack whole buttons onto lines with `visibleWidth`, never splitting one: a label broken mid-word
 * makes the focused target ambiguous, which is the misclick this row exists to prevent.
 */
export function wrapButtons(buttons: readonly string[], width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const button of buttons) {
		if (!line) { line = button; continue; }
		if (visibleWidth(`${line} ${button}`) <= width) line += ` ${button}`;
		else { lines.push(line); line = button; }
	}
	if (line) lines.push(line);
	return lines;
}

/**
 * Forward a pointer event to a pi-tui child drawn at `area` inside the overlay, in the child's own
 * coordinates (without `area`, the event already is). Pi 0.84 components have no handleMouse, hence
 * the structural call. A wheel the child leaves unhandled is consumed; presses and drags the child
 * ignores (Editor does) stay unhandled so host text selection keeps working there.
 */
export function delegateMouse(child: object, event: BroMouseEvent, area?: Area): BroMouseResult {
	const { x = -1, y = -1 } = event;
	const inside = !area || (y >= area.top && y < area.top + area.height && x >= area.left && x < area.left + area.width);
	const local = area ? { ...event, x: x - area.left, y: y - area.top, width: area.width, height: area.height } : event;
	const handle = (child as { handleMouse?: (event: BroMouseEvent) => BroMouseResult }).handleMouse;
	return (inside ? handle?.call(child, local) : undefined) ?? consumeWheel(event);
}

/** Regular-mode mouse reporting held by one overlay; release is idempotent and also runs on exit. */
export function mouseLease(tui: TuiLike): { acquire(): void; release(): void } {
	let held = false;
	const release = () => {
		if (!held) return;
		held = false;
		process.off("exit", release);
		setRegularMouseReporting(tui, false);
	};
	return {
		acquire() {
			if (held) return;
			held = true;
			// Pi's regular-mode TUI never resets 1000/1006 itself, so a quit with a modal open would leave it on.
			process.once("exit", release);
			setRegularMouseReporting(tui, true);
		},
		release,
	};
}

/**
 * Mount a Bro overlay. `mouse` holds regular-mode reporting until the overlay closes or is disposed,
 * and releases it while the overlay is hidden through the handle passed to `onHandle`.
 */
export async function openBroOverlay<T>(
	ctx: ExtensionCommandContext,
	factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: T) => void) => Mounted,
	options: { mouse?: boolean; overlay?: OverlayOptions; onHandle?: (handle: OverlayHandle) => void } = {},
): Promise<T> {
	let lease: ReturnType<typeof mouseLease> | undefined;
	// Once closed or disposed, un-hiding must not turn reporting back on.
	let ended = false;
	try {
		return await ctx.ui.custom<T>(
			(tui, theme, keybindings, done) => {
				const component = factory(tui, theme, keybindings, done);
				if (!options.mouse) return component;
				const held = (lease = mouseLease(tui));
				held.acquire();
				const dispose = component.dispose?.bind(component);
				component.dispose = () => {
					ended = true;
					held.release();
					dispose?.();
				};
				return component;
			},
			{
				overlay: true,
				overlayOptions: options.overlay ?? BRO_OVERLAY,
				onHandle: (handle) =>
					options.onHandle?.({
						...handle,
						setHidden: (hidden: boolean) => {
							if (hidden) lease?.release();
							else if (!ended) lease?.acquire();
							handle.setHidden(hidden);
						},
					}),
			},
		);
	} finally {
		// Also covers a close before mount, when the host never calls dispose.
		ended = true;
		lease?.release();
	}
}
