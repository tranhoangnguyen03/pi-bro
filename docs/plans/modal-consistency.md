# Design: one shared modal kit for every Bro overlay

Status: complete (2026-10-15). v2 was revised after independent reviews by
agy, claude and codex; v3 adds a second review by agy and claude (both: "ready
after small fixes").

- Step 0 shipped as the 0.23.1 hotfix (PR #143).
- Steps 1 and 2 landed together: the kit plus its first two users (`BroModal`,
  `BtwModal`) and the contract test, so the kit never shipped without callers.
- Built differently from the sketch below: `renderFrame` takes `header` as a
  function (it runs after the body, to show the scroll position) and truncates
  footer lines instead of wrapping them (btw's composer line carries cursor
  markers); `delegateMouse` waits for step 3, its first user.
- Step 3 landed: preferences, advisor-steer and config use `renderFrame`
  (with `fill: false`, so they size to their content) and `openBroOverlay`;
  `delegateMouse` forwards clicks and wheel to pi-tui's `Editor`, `SettingsList`
  and the model picker. Config only accepts input while the complete host list,
  including its selection and hints, fits the current frame; after a shrink it
  asks for a larger terminal instead of allowing hidden actions. Below ~22 rows
  the editor's own minimum height is still cut instead of the hints.
- Step 4 landed: Guided Review mounts with `openBroOverlay` and `REVIEW_OVERLAY`
  (it keeps its rounded frame and pane layout); the workspace holds the mouse
  lease, so the wheel works in regular mode too, released while hidden behind
  the regenerate confirm; one raw SGR parser (`rawWheel`) serves every surface.
  The contract test covers all surfaces; no `todo` rows remain.
- Step 5 landed: btw and Review's small-terminal screen use the `Key action`
  hint wording; DEVELOPMENT.md documents the conventions. The user-facing
  changelog entry goes in with the release that ships steps 1–5.
- Implementation review (agy, claude, codex) fixes: the config model picker
  brings its own hints and btw's running hint fits one line (in #143); privacy
  sentences lead the editor subtitles; notices wrap to three lines with the
  action first; hints wrap instead of being cut; btw keeps its composer last;
  editors that do not fit show "Enlarge the terminal" and block edits; config
  clicks only reach rows still shown; `Theme`/`TuiLike` live in the kit and
  `REVIEW_OVERLAY` in `review-modal.ts`.
- Done. Open follow-ups: the editors' minimum height below ~22 rows (pi-tui
  `Editor`), and a live-terminal pass on Pi 0.84.2 and 1.2 before release.

## Why

Pi 1.2.0 stopped forwarding raw wheel bytes to overlays that lack `handleMouse`,
so explain/show/help and btw lost wheel scrolling. Fixing that exposed a bigger
issue: Bro's overlay surfaces are built four different ways. Each one handles
framing, sizing, scrolling, mouse input and closing on its own.

| Surface | Built as | Mount |
|---|---|---|
| explain / show / doctor / help | `BroModal` class | `showBroModal` (`explain-modal.ts`) |
| btw | `BtwModal` class | `openBtwModal` (`btw.ts`) |
| preferences, advisor-steer | object literal around `Editor` | `createTextEditorModal` (`explain-modal.ts`) |
| config (+ model picker submenu) | object literals around `SettingsList` / `SelectList` / `Input` | `createConfigModal` (`config-ui.ts`), mounted in `doctor.ts` |
| review acquisition | inline object literal | `review-ui.ts` |
| review workspace | `ReviewModal` class + literal wrapper | `review-ui.ts` / `review-modal.ts` |

Host dialogs (`ctx.ui.select` / `confirm` / `notify`) are Pi's own and out of scope.

### User-visible defects

Verified means measured with the test build or read in code by at least two reviewers.

| # | Defect | Status |
|---|---|---|
| D1 | **Preferences, advisor-steer and config are clipped.** Pi cuts overlays taller than `maxHeight` from the bottom. At 24 rows preferences draws 27 lines against a cap of 14, and config draws 27 against 18. Save notices, key hints and the bottom border are never seen. Causes: `maxHeight: "60%"` on the editors, `Text`'s default `paddingY = 1` (two blank rows per label), a wrapped subtitle, Editor's own height, an editor hint line that wraps to two lines at 78% width, and `SettingsList` visible rows fixed at 18 plus its own hint rows. | verified |
| D2 | **The wheel scrolls the chat behind** the editors, config, the config model picker and review acquisition. This is the same Pi 1.2 regression as `BroModal`: Pi 1.1 left an unhandled wheel over a focused overlay to the overlay. The wrappers also drop the click support pi-tui's `Editor`/`SettingsList`/`SelectList` already have. | verified in code |
| D3 | **btw jumps to the top after every answer** (`btw.ts:216`, reached from the turn's `finally`). | verified |
| D4 | **btw says "Esc: cancel response", but Esc closes the panel.** | verified |
| D5 | **A long notice in `BroModal` pushes the key hints off the line** (e.g. "Retry failed: …"). | verified |
| D6 | **Short terminals clip the bottom border.** `BroModal`'s 7-row floor is above the cap at 8 rows. btw's footer has no limit: 11 rows against a cap of 6. | verified |
| D7 | **Guided Review never turns on mouse reporting in regular mode**, so the wheel does nothing there. | verified in code |
| D8 | **Review saves twice on close** (`close()` saves, then `dispose()` saves again). | verified |
| D9 | **Config shows two conflicting hint lines**: its own "Esc back/close" and SettingsList's "Esc to cancel". | verified in code |
| D10 | **Mouse reporting can stay on in regular mode if Pi exits or crashes while a Bro overlay is open.** Bro turns it off only in `dispose`, and Pi's regular-mode TUI never resets modes 1000/1006 (only the fullscreen TUI does). Every Bro factory is synchronous, so a close before mount can't skip `dispose` today. | code path verified; not reproduced live |

Dropped after review: "`done` can be called twice". Pi's `showExtensionCustom`
`close` already runs once and calls `dispose` itself on every supported version.

### Duplication

- Frame helpers are copied verbatim between `BroModal` and `BtwModal`. The padded bordered render is copied between the editor and config wrappers.
- Scroll offset, clamp and indicator code is copied between `BroModal` and `BtwModal`.
- There are two SGR wheel parsers: `ui-capabilities.ts:37` and `review-modal.ts:458`.
- There are six `overlayOptions` literals. Each drawn-height formula (0.78, 0.82, `rows − 2`, none) is computed separately from its `maxHeight`.
- `Theme` and `Tui` types are defined twice: `config-ui.ts` and `review-modal.ts`.

## What the Pi host gives us (0.84.2 → 1.2.0)

| Capability | 0.84.2 | 1.0–1.1 | 1.2 |
|---|---|---|---|
| Keys go to the focused overlay's `handleInput` | yes | yes | yes |
| Regular mode: raw SGR wheel goes to `handleInput` (only if Bro turned reporting on) | yes | yes | yes |
| Fullscreen: raw wheel falls back to `handleInput` | yes | only if `handleMouse` doesn't handle it | **removed** |
| Normalized `handleMouse` with overlay-local x/y, hit-tested to the overlay box | no | yes | yes |
| `Container` / `Box` forward mouse events to children by row | no | yes | yes |
| `Editor` / `SettingsList` / `SelectList` / `Input` have `handleMouse` | no | yes | yes |
| `ScrollView` scrolls inside an overlay | **no** | **no** | **no** |
| Overlay tells the component its available height | no | no | no |

The overlay sizing math is the same in every version (`TuiBase.resolveOverlayLayout`).
Percentages are floored against terminal size, then clamped to the space left
after margins, with a **minimum of 1 row**. `ScrollView` only scrolls through the
fullscreen layout engine, which overlays bypass, so we can't reuse it. Bro has to
work out its own height budget.

## Goals and non-goals

Goals. Every Bro overlay, on every supported Pi version and in both TUI modes:

1. scrolls with keys, and with the wheel **while the pointer is over it**, without scrolling the chat behind it;
2. fits its overlay at normal sizes, so hints, notices and borders are never clipped, and degrades predictably on tiny terminals;
3. turns mouse reporting on and off reliably;
4. reads the same way: frame, hint wording, notice placement.

Non-goals:

- changing Review's focus model, panes, `followAnswer`, close-saves or `setHidden` confirm;
- changing btw's composer, slash commands or Desktop insert;
- changing config's deferred close while saving or its submenu Esc;
- changing the editors' Ctrl+S / Ctrl+K / pending behaviour;
- changing `BroModal`'s M / R / O, its kind state machine or its headless fallback;
- changing titles (`Bro · <source label>` is dynamic, and tests pin `Bro · Review`);
- adding features.

## Design: a small kit, used by composition

One new module, `src/modal-kit.ts` (about 120 lines). It must be added to
`package.json` `files`. There's no base class: the surfaces differ too much, and
composition lets each surface migrate on its own. All mouse types are local and
structural, so 0.84.2's type declarations (which have no mouse types) still
compile, and every child call is optional (`child.handleMouse?.(…)`).

```ts
// Local structural types; no runtime or declaration dependency on pi-tui mouse types.
type WheelEvent = { type: string; x: number; y: number; width?: number; height?: number; wheelDelta?: number };
type MouseResult = { handled: boolean; render: boolean } | undefined;

// 1. Sizing: one preset, and a drawn height that comes from the same numbers.
export const BRO_OVERLAY;   // width 78%, minWidth 48, maxHeight 78%, top-center, margin t1 l2 r2
export function modalHeight(tui, overlay = BRO_OVERLAY, cap?: number): number;
//    rows from broModalRows(), then the host's math: floor percent, clamp to rows minus margins, min 1

// 2. Frame: renders at most `height` lines. Drop order when space runs out:
//    body rows, then subtitle, then notice (down to 1 line), then the rule lines.
//    The top/bottom border and the hint line are never dropped while height >= 3.
export function renderFrame(theme, width, height, parts: {
  title: string; meta?: string; subtitle?: string;
  body: (rows: number, innerWidth: number) => string[];
  footer?: string[]; notice?: string; hints: string;
}): string[];

// 3. Scrolling for a line-based body (BroModal, BtwModal; Review keeps its own multi-pane offsets).
export class Scroller {
  view(lines: string[], rows: number): string[];   // clamp + slice; remembers maxOffset
  by(delta: number): void; toEnd(): void;
  handleKey(data: string): boolean;                  // ↑/↓ line, PgUp/PgDn page, raw SGR wheel (one parser)
  handleMouse(event: WheelEvent): MouseResult;       // consumes wheel over the overlay
  indicator(): string;                               // "↑3 ↓10" or ""
}

// 4. Wrappers: pass mouse to a pi-tui Container (it routes by row on 1.x but shifts
//    only y), so subtract the frame offset from x and y and the frame size from
//    width and height first. Consume only a leftover wheel. Press/drag/release
//    stay unhandled when the child ignores them, so host text selection keeps working.
export function delegateMouse(container, event: WheelEvent, top: number, left: number): MouseResult;

// 5. Regular-mode mouse reporting as a lease: idempotent.
export function mouseLease(tui): { acquire(): void; release(): void };
//    openBroOverlay acquires it after component creation and releases it on dispose.
//    One process.once("exit") hook is added on acquire and removed on release, so
//    listeners never pile up. Review also releases it while hidden for its confirm.
export function openBroOverlay<T>(ctx, factory, options?: {
  overlay?: OverlayOptions; mouse?: boolean; onHandle?: (handle) => void;   // onHandle is forwarded
}): Promise<T>;
```

Removed after review:

- `hints()`: a plain `[…].join(" · ")` is enough.
- `copyWithNotice()`: the four callers word their messages differently.
- A separate `wheelOnly()`: it now lives in `Scroller`.
- A custom `forwardMouse()`: `Container` already routes by row.
- The once-only `done` wrapper: the host already guarantees it.
- The 80% height change.

### Per-surface height budget

- **BroModal / BtwModal.** `modalHeight(tui, BRO_OVERLAY, 32 | 34)` keeps today's row caps. btw's footer counts against the budget, and its notice wraps to at most 2 lines.
- **Editors.**
  - Move from `maxHeight 60%` to `BRO_OVERLAY`.
  - Use `Text` with `paddingY 0`.
  - Keep the subtitle wrapping: it carries the privacy note ("never to the advisor or Pi's main model"), which a test pins. Truncating it would hide that.
  - Shorten the hint line to `Ctrl+S save · Ctrl+K clear · Ctrl+C copy · Esc close`, so it fits one line at 78% width. Enter-for-newline stays as it is and goes in the user guide.
  - Keep the notice and hints.
  - Editor keeps its own height, `max(5, 30% rows) + 2`. It can't be capped without hiding the cursor, so the frame drops the subtitle first.
  - It fits from about 22 rows (measured with the starter text). Below that the overlay clips, marked as `shortcut: Editor min height, revisit if users report <22-row terminals`.
- **Config.**
  - `SettingsList` visible rows = budget − chrome − 3 (its own blank, hint and scroll rows), computed when the modal opens.
  - Bro's duplicate hint line is dropped while the complete SettingsList fits; SettingsList's own selection and hint stay together.
  - SettingsList has no public resize API. If a later resize makes the component incomplete, Config shows an enlarge-terminal state, keeps Esc visible and blocks hidden actions until it fits again.

### Conventions

- **Hints.** Written as `Key action` and joined by ` · `, with no colons.
- **btw while a reply is running.** The hint reads `Esc close (stops reply)`, which is what it does today. A two-stage Esc (first stops, second closes) is a possible later change, not part of this work.
- **Notices.** At most 2 wrapped lines, above the hints and never in front of them. Scrolling still clears the notice.
- **Wheel.** Consumed while the pointer is over a Bro overlay. The step is the host's on 1.x (it honours `fullscreenWheelScrollLines`); the raw path keeps 3.
- **Scroll keys.** In Bro and btw: ↑/↓ one line, PgUp/PgDn one page. Home/End are left to btw's composer. On submit, btw jumps to the end and then follows while at the end.
- **Regular-mode mouse reporting.** On for scroll surfaces (Bro, btw, Review) through `mouseLease`. Off for the editors and config, where terminal text selection matters more.

## Reliability: one contract test for every surface

The test uses the host's real sizing function as its oracle:
`TuiMainScreen.prototype.resolveOverlayLayout.call(TuiMainScreen.prototype, options, 0, cols, rows)`.
`TuiBase` isn't exported from pi-tui's root, but both exported TUIs inherit the method.
That way a Pi upgrade that changes sizing fails the test instead of drifting
silently. The fake `ctx.ui.custom` behaves like the host: it closes once, then
calls `dispose`, and it captures `overlayOptions`.

Surfaces (rows):

- `showBroModal`: result, loading and help;
- `openBtwModal`: long thread, with a notice;
- `createPreferencesModal` and `createAdvisorSteerModal`;
- `createConfigModal`, and config with the model picker open;
- review acquisition, using the `review-session.test` harness;
- review workspace.

Sizes: 80×24, 120×40, 60×14, 40×8, in regular and fullscreen mode.

Assertions:

- rendered lines ≤ the oracle's `maxHeight`, and the last line is the bottom border (where height ≥ 3). Each row can set `minRows` for a documented exemption: the editors use 22, citing the Editor-min-height shortcut;
- visible width ≤ the render width;
- a wheel over the overlay is handled, and raw SGR scrolls where the surface scrolls;
- mouse reporting writes are balanced after close, and no exit listener is left behind;
- no `requestRender` after `dispose`.

During migration, rows for surfaces not yet moved used node:test `{ todo: true }`; no todo rows remain.

## Migration (one PR each)

0. **Hotfix 0.23.1: cheap user-visible fixes, no kit.** These are small and independent:
   - the current `handleMouse` wheel fix for `BroModal`/`BtwModal`;
   - a one-line wheel-only `handleMouse` on the editors, config, the model picker and review acquisition, so the chat behind stops scrolling (the D2 regression; clicks come in step 3);
   - editors: `maxHeight` 60% → 78%, `Text` padding 0, shorter hint line (most of D1). Done in 0.23.1 (`fix/modal-hotfix-0.23.1`);
   - config: `Text` padding 0, drop Bro's duplicate hint line (D9), `SettingsList` visible rows from terminal rows at open (most of D1 for config);
   - btw: on submit, scroll to the end (clamped in `render`); stop resetting the offset in the turn's `finally`; reset to the top only on `/clear` (D3). Use the honest Esc hint (D4);
   - Review: save once on close, keep the `dispose` save for teardown that doesn't go through `close()`, plus a test for both paths (D8).
1. **Kit + contract test.** Add `src/modal-kit.ts` and its `files` entry (`test/release.test.ts` already fails if it's missing), with unit tests and the contract test (unmigrated rows marked `todo`).
2. **BroModal + BtwModal** move to `renderFrame`, `Scroller`, `openBroOverlay`/`mouseLease`. Fixes D5, D6 and D10 for these two, and adds PgUp/PgDn.
3. **Editors + config + model picker** get a `renderFrame` wrapper, the height budget and `delegateMouse`. Fixes the rest of D1, plus D2 and D9.
4. **Review** moves to the shared `rawWheel` parser, `openBroOverlay({ mouse: true, onHandle })` with the lease suspended while hidden, and `consumeWheel` for acquisition (it has no pi-tui children). Fixes D7 and D10 for Review, plus the acquisition part of D2.
5. **Docs.** A "Modals" section in `docs/DEVELOPMENT.md` (use the kit, add a contract-test row), user-guide hint updates, changelog.

## Risks

- Editors still clip below about 22 rows, because Editor's minimum height is fixed upstream.
- `modalHeight` copies the host's math. The contract test catches drift on each Pi dev-dependency bump, but only for the versions we install.
- Mouse-reporting cleanup on process exit is best effort. Pi doesn't reset modes 1000/1006 itself.
- Regular-mode reporting in Review turns off mouse text selection while the review is open. This is already true for Bro and btw.
- The contract test calls direct handlers. Real compositing, resize and live terminals still need a manual check on Pi 0.84.2 and 1.2 before each release.
