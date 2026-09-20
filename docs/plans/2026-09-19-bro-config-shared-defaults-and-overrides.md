# /bro config: shared defaults with per-capability overrides

## Goal

Replace the interaction-only `/bro config` spike with a production settings screen: a shared
default model/effort (still owned by `/bro model` and `/bro effort`), plus optional per-capability
overrides for `explain`, `show`, `btw`, and `advisor`. `advisor` has no runtime (no command, no Agy
call, no Doctor check) — it is a plain, clearly-labeled configuration row, present now so its shape
exists ahead of the runtime that will eventually read it. No advisor runtime, no version bump.

## Data model

```ts
type ModelEffortPair = { model: string; effort: BroEffort };
type BroSettings = {
	model: string;      // shared default model
	effort: BroEffort;  // shared default effort
	mode: BroMode;
	showTurns: number;
	overrides: Partial<Record<"explain" | "show" | "btw" | "advisor", ModelEffortPair>>;
};
```

Key decisions:

- **An override is atomic.** It always pins both `model` and `effort` together; there is no
  "override effort but keep inheriting the model" state. Picking "Default" in the model picker
  clears the whole override. This avoids partial-inheritance edge cases (what effort applies when
  the model is overridden and the shared default's effort no longer fits the new model?) at the
  cost of a capability no longer tracking the shared default once it diverges. Adjusting a
  capability's effort row while inheriting the model creates an override that copies the current
  *resolved* model in explicitly (never a raw/suffixed string — see "Effort-only edits" below) —
  still atomic, just constructed from the current resolved pair.
- **An override is cleared only by an explicit "Default" selection — never automatically.**
  `withCapabilityOverride` stores exactly the pair it is given; it does not compare it against the
  shared default and does not drop it for merely matching. A user who deliberately pins a capability
  to whatever model currently happens to be the shared default needs that pin to survive the default
  later changing to something else — silently treating "matches today's default" as "no override" would
  make that pin impossible to express. The pin is only ever removed by picking "Default" in the model
  picker (`withCapabilityOverride(settings, capability, undefined)`). `settingsPayload` only omits
  the whole `overrides` key when it is empty; it does not deduplicate or drop any individual entry.
- **`advisor` is a real, editable row — just with no runtime behind it.** The config modal exposes
  "Advisor model" / "Advisor effort" rows identical in mechanics to explain/show/btw, each carrying a
  `SettingItem.description` of "Configuration only — the advisor is not implemented yet, so this
  value has no effect." `parseOverrides` validates and preserves `overrides.advisor` like any other
  capability. Doctor does not check it (there is nothing running to check), and no command reads it.
- **Catalog resolution is a single shared function.** `resolveModelEffort(pair, families)` is the
  one place that normalizes a `{model, effort}` pair against the live Agy catalog — expanding a
  suffixed variant id (`gemini-x-low`) to its family id + effort, and leaving `effort: "default"` in
  place for a fixed-effort family. It is used for the shared default, every capability's effective
  settings (`capabilityPair` + `resolveModelEffort`), and Doctor's per-capability checks.
- **Effort-only edits pin the resolved family id, never a raw string.** `ensureSettingsFile` can
  create a shared default whose `model` is a concrete suffixed variant id (e.g. `PI_BRO_MODEL=gemini-x-low`
  writes `{ model: "gemini-x-low", effort: "default" }`). If a capability inherits that default and
  the user only edits its *effort* row, the new override must store `resolveModelEffort(...).family.id`
  ("gemini-x"), not the raw `settings.model`/existing override's model string — otherwise the stored
  pair would be self-contradictory (a "-low"-suffixed model name paired with an unrelated effort like
  "high").
- **Display must not claim health it doesn't have.** `effortDisplay(resolved)` distinguishes three
  states instead of collapsing them into "fixed": no family found → `"unavailable"` (an unrecognized
  model must never look like a healthy fixed-effort one); family found with no configurable efforts
  and effort is exactly `"default"` → `"fixed"`; anything else where the stored effort isn't one the
  resolved family actually supports (including a fixed family with a stray non-`"default"` effort, or
  a variable-effort family still holding `"default"`) → `` `${effort} (unsupported)` ``, so a stale or
  hand-edited value is flagged rather than silently displayed as if it were valid.

## Where existing behavior changes

- `agySelection` and `resolveCatalogSettings` now take a plain `ModelEffortPair` instead of a full
  `BroSettings`. Every Agy invocation (`simplify`, `runShowExplanation`, `runBtwTurn`) first resolves
  its capability's effective pair via `capabilityPair(settings, capability)` — a pure, catalog-free
  lookup — before calling `agySelection`. This deliberately avoids an extra `agy models` call on
  every explain/show/btw run; only Doctor and `/bro config` need the catalog.
- `/bro model` and `/bro effort` are unchanged in scope: they only ever read/write the shared
  default (`settings.model`/`settings.effort`), never a capability override. Per-capability
  overrides are only ever set through `/bro config`.
- Doctor gained one pass/fail line per capability in `explain`/`show`/`btw` (not `advisor`), each
  reporting whether it inherits the shared default or an override, and whether that resolved pair is
  still valid against the current catalog.
- `isRecord` now rejects arrays (`typeof value === "object" && value !== null && !Array.isArray(value)`).
  Previously `overrides: []` (or a per-capability override given as an array) silently passed the
  object-shape check and produced `overrides: {}` with no error; it is now a validation error like any
  other malformed settings value.

## UI

`/bro config` keeps the same framed `SettingsList`/`SelectList` overlay pattern already validated
by the earlier spike (manual box-drawing border, `SettingsList` for the row list, `SelectList` as a
submenu `Component` for model pickers). Twelve rows, always present (no rows appear/disappear):
shared default model + effort, explain mode, show turns, then a model + effort row per capability
(`explain`, `show`, `btw`, `advisor`). Model rows open a `SelectList` submenu; effort rows cycle
through the resolved family's supported efforts via `SettingItem.values` (or are inert — no
`values`, no `submenu` — when the resolved model is fixed-effort or unavailable).

Every change calls `refresh()` synchronously (so the screen never shows a stale or raw internal
value like a sentinel `"__default__"`), then hands the new settings to a serialized persistence
queue:

- Only one `persistSettings` call is ever in flight. A change that arrives while one is already
  running is coalesced into a single pending slot (overwriting any earlier pending change, never
  queuing more than one) instead of firing a second concurrent write. When the in-flight write
  settles, the coalesced pending write (if any) starts immediately, carrying the latest state — so
  the file on disk always converges on the user's actual final intent, never a stale intermediate one,
  and writes are never issued out of order.
- A rejected save reverts the in-memory `settings` (and every displayed row) back to the last state
  that was actually confirmed on disk, and shows the error inline (`theme.fg("warning", ...)`) so the
  screen never claims a setting that doesn't really exist. The notice is not auto-dismissed by a timer;
  it clears only on the next successful save.
- Esc while a save is in flight does not close the modal immediately — it records the request and
  defers it until every in-flight and coalesced write has settled. If the save that settles last
  succeeded, the deferred close then happens; if it failed, the close is cancelled instead, so the
  failure notice stays visible and the user has to press Esc again once they've seen it.
- A picker's Esc calls the library's `done()` with no argument, which — verified by reading
  `SettingsList`'s own `activateItem` — never touches `item.currentValue` or calls `onChange`, so
  nothing is saved, queued, or displayed differently.

`createConfigModal(initialSettings, families, persistSettings)` is exported specifically so this can
be tested without a real Agy process or settings file: `showBroConfigModal(ctx, pi)` is the thin
production wrapper that calls `readSettings()` + `listAgyModels(pi)` and passes the real
`writeSettings` as `persistSettings`.

## Testing

`smoke-test.sh`'s unit-test phase drives `createConfigModal` directly against a small three-family
fake catalog (`gemini-a`/`gemini-c` variable-effort, `gemini-b` fixed-effort) built through the real
`parseAgyModels`, with a fake `persistSettings` that records calls (or rejects, for the failure
case). It exercises: initial inherited display; switching the shared default to a fixed-effort model
(effort resolves to `"fixed"` everywhere it's inherited); giving a capability its own model
(auto-picks a compatible effort); cycling that override's effort independently; an override that
starts out identical to the shared default and must still be stored explicitly, then survives a
later, unrelated change to the shared default; an explicit "Default" selection clearing that
override; a submenu Esc leaving state and persisted calls untouched; a top-level Esc closing without
an extra save; the advisor rows' presence, description, and real (if inert) persistence; a dedicated
regression for the effort-only-edit-on-a-suffixed-default case; a dedicated deferred-promise test for
serialized/coalesced writes plus Esc-while-saving; a dedicated rejection test for state
revert/notice/close-cancellation; and the `"unavailable"`/`"fixed"`/`` `(unsupported)` `` display
cases. Separately, `resolveModelEffort`, `withCapabilityOverride`, and `settingsPayload` are
exercised as pure functions, and `parseBroSettings` is exercised against settings with no
`overrides` key, unknown capability keys, an array in place of the overrides object (or a
per-capability override), and a reserved `advisor` entry, to cover old-settings migration.

A separate offline-RPC block in `smoke-test.sh` verifies capability overrides reach the *real* Agy
invocation, not just the pure `capabilityPair`/`agySelection` composition: a settings file with
distinct `explain` and `show` overrides is loaded, `/bro` and `/bro show` are run against a dedicated
fake `agy` binary, and the recorded `--model`/`--effort` arguments are asserted to match each
override rather than the shared default. `btw` cannot be driven through this harness — it requires
`ctx.mode === "tui"` and an interactive composer that the offline RPC harness has no channel for — so
its wiring is covered only at the pure-helper level, via the same `capabilityPair`/`agySelection`
composition used at its real call site in `openBtwModal`.
