import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme, TuiLike } from "./config-ui.ts";
import { broModalRows, consumeWheel, setRegularMouseReporting, wheelDelta, type BroMouseEvent, type BroMouseResult } from "./ui-capabilities.ts";

// Shared building blocks for Bro's overlays; see docs/plans/modal-consistency.md.

type Mounted = Component & { dispose?(): void };

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
export function modalHeight(tui: TuiLike, overlay: HeightOptions = BRO_OVERLAY, cap = Infinity): number {
	const rows = broModalRows(tui, process.stdout.rows);
	const percent = Math.floor((rows * Number.parseFloat(overlay.maxHeight)) / 100);
	const available = Math.max(1, rows - (overlay.margin.top ?? 0) - (overlay.margin.bottom ?? 0));
	return Math.max(1, Math.min(percent, available, cap));
}

export type FrameParts = {
	/** Header line, already styled; called after `body` so it can show the scroll position. */
	header: () => string;
	/** Called with the rows left for the body; return at most that many lines. */
	body: (rows: number, innerWidth: number) => string[];
	/** Lines under the body, e.g. a composer; truncated to the inner width, so wrap long text first. */
	footer?: string[];
	/** Already styled; wrapped to at most two lines, above the hints. */
	notice?: string;
	/** Omit when the body prints its own hints (config's SettingsList). */
	hints?: string;
	/** false: size to the content instead of padding the body to the full height. */
	fill?: boolean;
};

/**
 * Square frame that never renders more than `height` lines (exactly `height` unless `fill` is false). Pi clips overlays from the
 * bottom, so when space runs out the body shrinks first, then lines go from the top of
 * the frame's middle (header, rules), keeping the footer, notice, hints and both borders.
 */
export function renderFrame(theme: Theme, width: number, height: number, parts: FrameParts): string[] {
	const inner = Math.max(1, width - 2);
	const border = (text: string) => theme.fg("border", text);
	const row = (content: string) => {
		const line = truncateToWidth(content, inner, "");
		return `${border("│")}${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))}${border("│")}`;
	};
	const rule = border(`├${"─".repeat(inner)}┤`);
	const below = [
		...(parts.footer ?? []),
		...(parts.notice ? wrapTextWithAnsi(parts.notice, inner).slice(0, 2) : []),
		...(parts.hints ? [theme.fg("dim", parts.hints)] : []),
	];
	const bodyRows = Math.max(0, height - 5 - below.length);
	const body = bodyRows ? parts.body(bodyRows, inner).slice(0, bodyRows) : [];
	if (parts.fill !== false) while (body.length < bodyRows) body.push("");
	const middle = [row(parts.header()), rule, ...body.map(row), rule, ...below.map(row)];
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

	/** ↑/↓ one line, PgUp/PgDn one page, and raw SGR wheel bytes (Pi 0.84, regular mode). */
	handleKey(data: string): boolean {
		const page = Math.max(1, this.rows - 1);
		const delta =
			wheelDelta(data) ||
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

export type Area = { top: number; left: number; width: number; height: number };

/**
 * Forward a pointer event to a pi-tui child drawn at `area` inside the overlay, in the child's own
 * coordinates (without `area`, the event already is). Pi 0.84 components have no handleMouse, hence
 * the structural call. A wheel the child leaves unhandled is consumed; presses and drags stay
 * unhandled so host text selection keeps working.
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

/** Mount a Bro overlay. `mouse` holds regular-mode reporting until the overlay closes or is disposed. */
export async function openBroOverlay<T>(
	ctx: ExtensionCommandContext,
	factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: T) => void) => Mounted,
	options: { mouse?: boolean } = {},
): Promise<T> {
	let lease: ReturnType<typeof mouseLease> | undefined;
	try {
		return await ctx.ui.custom<T>(
			(tui, theme, keybindings, done) => {
				const component = factory(tui, theme, keybindings, done);
				if (!options.mouse) return component;
				const held = (lease = mouseLease(tui));
				held.acquire();
				const dispose = component.dispose?.bind(component);
				component.dispose = () => {
					held.release();
					dispose?.();
				};
				return component;
			},
			{ overlay: true, overlayOptions: BRO_OVERLAY },
		);
	} finally {
		// Also covers a close before mount, when the host never calls dispose.
		lease?.release();
	}
}
