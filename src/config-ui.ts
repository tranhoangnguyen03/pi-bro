import {
	type Component,
	type SelectItem,
	type SettingItem,
	Input,
	SelectList,
	SettingsList,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	type AgyModelFamily,
	type BackendName,
	type BroSettings,
	type Capability,
	type ExternalBackend,
	type PiModelChoice,
	CAPABILITIES,
	CAPABILITY_LABELS,
	EXTERNAL_BACKENDS,
	applyEffortChange,
	applyModelChange,
	capabilityBackend,
	capabilityOverride,
	capabilityPair,
	effortDisplay,
	externalModelDisplay,
	isExternalBackend,
	resolveModelEffort,
	withCapabilityOverride,
} from "./settings.ts";
import { BRO_MODES, parseBroMode } from "./prompt.ts";
import { delegateMouse, formatNotice, modalHeight, renderFrame, type Area, type Theme, type TuiLike } from "./modal-kit.ts";
import type { BroMouseEvent } from "./ui-capabilities.ts";
import { errorMessage } from "./util.ts";

const SHOW_TURNS_PRESETS = [1, 2, 3, 5, 8];

// The step-1 backend list, in display order. "Default" has no backend value and is only offered for
// per-capability rows (a capability can inherit the shared default). "agy" is included but has no
// EXTERNAL_BACKENDS entry: its models come from the live Agy catalog.
const BACKEND_CHOICES: readonly { value: BackendName; label: string }[] = [
	{ value: "agy", label: "Agy" },
	{ value: "claude", label: "Claude" },
	{ value: "grok", label: "Grok" },
	{ value: "codex", label: "Codex" },
	{ value: "muse", label: "Muse" },
	{ value: "pi", label: "Pi" },
] as const;

// The prefix used to carry a backend selection out of the step-1 picker and into applyModelChange.
const BACKEND_SENTINEL = "__backend__:";

function showTurnsValues(current: number): string[] {
	return [...new Set([...SHOW_TURNS_PRESETS, current])].sort((a, b) => a - b).map(String);
}

// Testable core: takes settings/catalog/persist as plain arguments so smoke tests can drive
// the exact interaction (submenus, cancel, cycling, save failure) without a real Agy process
// or settings file. showBroConfigModal in bro.ts wires this to the real ctx/pi/filesystem.
export function createConfigModal(
	initialSettings: BroSettings,
	families: AgyModelFamily[],
	persistSettings: (settings: BroSettings) => Promise<void>,
	piModels: PiModelChoice[] = [],
): (tui: TuiLike, theme: Theme, keybindings: unknown, done: (value?: void) => void) => Component & { dispose?(): void } {
	return (tui, theme, _keybindings, done) => {
		// Size the host list once, then stop interaction if a later resize cannot show the whole
		// component. SettingsList has no public resize API; clipping it would hide selection/actions.
		const listRows = Math.max(1, modalHeight(tui) - 11);
		let settings = initialSettings;
		// The last settings actually confirmed on disk. A failed save reverts `settings` (and the
		// whole displayed row set) back to this, so the screen never shows state that doesn't exist.
		let savedSettings = initialSettings;
		// Only one persistSettings call is ever in flight. A change that arrives while one is
		// already running is coalesced into `queued` (overwriting any earlier queued change) rather
		// than firing a second concurrent write — this is what keeps writes serialized and makes
		// sure the on-disk file always converges on the latest intent instead of a stale one that
		// happened to finish last.
		let saving = false;
		let queued: BroSettings | undefined;
		// Esc while a save is in flight must not close past an unshown result: it requests a close
		// that only actually happens once the in-flight (and any coalesced) save has settled, and
		// only if it succeeded — a failure cancels the pending close so its notice stays visible.
		let closeRequested = false;
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			done(undefined);
		};

		// Two-step picker: backend first, then a model for that backend. Esc in step 2 returns to step 1
		// without saving; only a complete model selection calls pickerDone, so a cancel never mutates
		// settings. The Agy family list is step 2 for the Agy backend, keeping the catalog behavior.
		const modelPicker = (current: string, pickerDone: (value?: string) => void, capability?: Capability) => {
			const defaultResolved = resolveModelEffort({ model: settings.model, effort: settings.effort }, families);
			const currentBackend = capability
				? (capabilityOverride(settings, capability) ? capabilityBackend(settings, capability) : undefined)
				: (settings.backend ?? "agy");
			const backendOptions: SelectItem[] = [
				...(capability ? [{ value: "__default__", label: `Default (${defaultResolved.family?.label ?? settings.model})` }] : []),
				...BACKEND_CHOICES.map((choice) => ({
					value: `${BACKEND_SENTINEL}${choice.value}`,
					label: choice.label,
				})),
			];
			const backendIndex = capability && current === "Default" ? 0 : backendOptions.findIndex((option) => option.value === `${BACKEND_SENTINEL}${currentBackend ?? "agy"}`);

			const input = new Input();
			let step: "backend" | "model" | "custom" = "backend";
			let chosenBackend: BackendName | undefined;
			let customError: string | undefined;

			const buildModelOptions = (backend: BackendName): SelectItem[] => {
				if (backend === "agy") {
					return families.map((family) => ({
						value: family.id,
						label: `${family.label}${family.efforts.length ? "" : " · fixed effort"}`,
					}));
				}
				const meta = EXTERNAL_BACKENDS[backend];
				const models = backend === "pi" ? piModels.map((choice) => ({ id: choice.value, label: choice.label })) : meta.models;
				return [
					...models.map((model) => ({ value: `${meta.prefix}${model.id}`, label: model.label })),
					{ value: `__${backend}_custom__`, label: `${meta.label} · custom model ID…` },
				];
			};

			let modelSelectList: SelectList | undefined;
			const currentModelPicker = (): SelectList => {
				if (!modelSelectList) {
					const items = chosenBackend ? buildModelOptions(chosenBackend) : [];
					modelSelectList = new SelectList(items, Math.min(items.length, 8, listRows), getSelectListTheme());
					// Pi's list row shows the bare "<provider>/<id>" while the option value carries the transport
					// prefix, so also try the prefixed form when matching the current selection.
					const prefix = chosenBackend && chosenBackend !== "agy" ? EXTERNAL_BACKENDS[chosenBackend].prefix : "";
					modelSelectList.setSelectedIndex(Math.max(0, items.findIndex((option) => option.value === current || option.value === `${prefix}${current}`)));
					modelSelectList.onSelect = (item) => {
						if (chosenBackend && chosenBackend !== "agy" && item.value === `__${chosenBackend}_custom__`) {
							step = "custom";
							customError = undefined;
							tui.requestRender();
							return;
						}
						pickerDone(item.value);
					};
					// Esc in step 2 goes back to the backend list; it never saves a half-made choice.
					modelSelectList.onCancel = () => {
						step = "backend";
						chosenBackend = undefined;
						customError = undefined;
						tui.requestRender();
					};
				}
				return modelSelectList;
			};

			const picker = new SelectList(backendOptions, Math.min(backendOptions.length, 8, listRows), getSelectListTheme());
			picker.setSelectedIndex(Math.max(0, backendIndex));
			picker.onSelect = (item) => {
				const value = item.value;
				if (!value.startsWith(BACKEND_SENTINEL)) {
					pickerDone(value); // "__default__" for a capability
					return;
				}
				const backend = value.slice(BACKEND_SENTINEL.length) as BackendName;
				chosenBackend = backend;
				modelSelectList = undefined;
				currentModelPicker();
				step = "model";
				tui.requestRender();
			};
			picker.onCancel = () => pickerDone();

			input.onSubmit = (value) => {
				if (!value.trim() || !chosenBackend || chosenBackend === "agy") return;
				// Validate before leaving the step so a malformed ID (Pi needs "<provider>/<id>") shows an
				// inline hint and leaves the field open, instead of throwing out of the input handler.
				const choice = `${EXTERNAL_BACKENDS[chosenBackend].prefix}${value.trim()}`;
				try {
					EXTERNAL_BACKENDS[chosenBackend].resolveModel(value.trim());
				} catch (error) {
					customError = errorMessage(error);
					tui.requestRender();
					return;
				}
				customError = undefined;
				pickerDone(choice);
			};

			return {
				// SettingsList draws an open submenu instead of its own list and hints, so the picker brings its own.
				render: (width: number) => {
					if (step === "custom" && chosenBackend && chosenBackend !== "agy") {
						return [
							`${EXTERNAL_BACKENDS[chosenBackend].label} model ID:${chosenBackend === "pi" ? " <provider>/<id>" : ""}`,
							...input.render(width),
							...(customError ? [truncateToWidth(theme.fg("warning", `  ${customError}`), width)] : []),
							"",
							truncateToWidth(theme.fg("dim", "  Enter save · Esc back"), width),
						];
					}
					const list = step === "backend" ? picker : currentModelPicker();
					const hint = step === "backend" ? "  ↑/↓ choose backend · Enter select · Esc back" : "  ↑/↓ choose model · Enter select · Esc back";
					return [...list.render(width), "", truncateToWidth(theme.fg("dim", hint), width)];
				},
				invalidate: () => { picker.invalidate(); modelSelectList?.invalidate(); input.invalidate(); },
				// SettingsList hands an open submenu its own events unchanged.
				handleMouse: (event: BroMouseEvent) =>
					step === "custom"
						? delegateMouse(input, event, { top: 1, left: 0, width: tui.terminal?.columns ?? 80, height: 1 })
						: delegateMouse(step === "backend" ? picker : currentModelPicker(), event),
				handleInput: (data: string) => {
					if (step === "custom") {
						if (matchesKey(data, "escape")) {
							step = "model";
							customError = undefined;
							tui.requestRender();
							return;
						}
						input.handleInput(data);
						return;
					}
					if (step === "backend") picker.handleInput(data);
					else currentModelPicker().handleInput(data);
				},
			};
		};

		const modelItem: SettingItem = { id: "model", label: "Default model", currentValue: settings.model, submenu: modelPicker };
		const effortItem: SettingItem = { id: "effort", label: "Default effort", currentValue: "" };
		const modeItem: SettingItem = { id: "mode", label: "Explain mode", currentValue: settings.mode, values: [...BRO_MODES] };
		const showTurnsItem: SettingItem = {
			id: "showTurns",
			label: "Show turns",
			currentValue: String(settings.showTurns),
			values: showTurnsValues(settings.showTurns),
		};
		const capabilityItems = Object.fromEntries(
			CAPABILITIES.map((capability) => [
				capability,
				{
					model: {
						id: `${capability}Model`,
						label: `${CAPABILITY_LABELS[capability]} model`,
						currentValue: "Default",
						submenu: (current: string, pickerDone: (value?: string) => void) => modelPicker(current, pickerDone, capability),
					} as SettingItem,
					effort: {
						id: `${capability}Effort`,
						label: `${CAPABILITY_LABELS[capability]} effort`,
						currentValue: "",
					} as SettingItem,
				},
			]),
		) as Record<Capability, { model: SettingItem; effort: SettingItem }>;

		function refresh(): void {
			const defaultBackend = settings.backend ?? "agy";
			const def = resolveModelEffort({ backend: settings.backend, model: settings.model, effort: settings.effort }, families);
			modelItem.currentValue = isExternalBackend(defaultBackend)
				? externalModelDisplay(defaultBackend, settings.model)
				: (def.family?.id ?? settings.model);
			effortItem.currentValue = effortDisplay(def, defaultBackend);
			effortItem.values = isExternalBackend(defaultBackend)
				? ["default", ...EXTERNAL_BACKENDS[defaultBackend].efforts]
				: def.family?.efforts.length
					? [...def.family.efforts]
					: undefined;
			modeItem.currentValue = settings.mode;
			showTurnsItem.currentValue = String(settings.showTurns);
			showTurnsItem.values = showTurnsValues(settings.showTurns);

			for (const capability of CAPABILITIES) {
				const override = capabilityOverride(settings, capability);
				const backend = capabilityBackend(settings, capability);
				const resolved = resolveModelEffort(capabilityPair(settings, capability), families);
				const rows = capabilityItems[capability];
				rows.model.currentValue = !override
					? "Default"
					: isExternalBackend(backend)
						? externalModelDisplay(backend, override.model)
						: (resolved.family?.id ?? override.model);
				rows.effort.currentValue = effortDisplay(resolved, backend);
				rows.effort.values =
					backend in EXTERNAL_BACKENDS
						? ["default", ...EXTERNAL_BACKENDS[backend as ExternalBackend].efforts]
						: resolved.family?.efforts.length
							? [...resolved.family.efforts]
							: undefined;
			}
		}
		refresh();

		const items: SettingItem[] = [
			modelItem,
			effortItem,
			modeItem,
			showTurnsItem,
			...CAPABILITIES.flatMap((capability) => [capabilityItems[capability].model, capabilityItems[capability].effort]),
		];

		let notice = "";
		let interactive = true;
		// Where the complete list was last drawn inside the overlay, for click forwarding.
		let listArea: Area = { top: 0, left: 0, width: 0, height: 0 };

		function runSave(toSave: BroSettings): void {
			saving = true;
			void persistSettings(toSave)
				.then(() => {
					savedSettings = toSave;
					notice = "";
				})
				.catch((error: unknown) => {
					// Restore the last state that is actually on disk: showing the failed, unsaved
					// value would let the screen claim a setting that doesn't really exist.
					settings = savedSettings;
					queued = undefined;
					closeRequested = false;
					refresh();
					// Outcome first: long notices are cut after three lines.
					notice = formatNotice(theme, `Reverted to the last saved settings. Could not save settings: ${errorMessage(error)}`, "error");
				})
				.finally(() => {
					saving = false;
					tui.requestRender();
					if (queued !== undefined) {
						const next = queued;
						queued = undefined;
						runSave(next);
					} else if (closeRequested) {
						closeRequested = false;
						close();
					}
				});
		}

		function persist(toSave: BroSettings): void {
			if (saving) {
				queued = toSave;
				return;
			}
			runSave(toSave);
		}

		const onChange = (id: string, newValue: string) => {
			if (id === "model") {
				const current = { backend: settings.backend, model: settings.model, effort: settings.effort };
				const next = applyModelChange(current, newValue, families);
				if (!next) return;
				if (next.backend === undefined) {
					const { backend: _dropped, ...rest } = settings;
					settings = { ...rest, model: next.model, effort: next.effort };
				} else {
					settings = { ...settings, backend: next.backend, model: next.model, effort: next.effort };
				}
			} else if (id === "effort") {
				const current = { backend: settings.backend, model: settings.model, effort: settings.effort };
				const next = applyEffortChange(current, newValue, families);
				if (!next) return;
				settings = { ...settings, model: next.model, effort: next.effort };
			} else if (id === "mode") {
				const mode = parseBroMode(newValue);
				if (!mode) return;
				settings = { ...settings, mode };
			} else if (id === "showTurns") {
				const turns = Number(newValue);
				if (!Number.isInteger(turns) || turns < 1) return;
				settings = { ...settings, showTurns: turns };
			} else {
				const capability = CAPABILITIES.find((item) => id === `${item}Model` || id === `${item}Effort`);
				if (!capability) return;
				if (id === `${capability}Model`) {
					if (newValue === "__default__") {
						settings = withCapabilityOverride(settings, capability, undefined);
					} else {
						const current = capabilityPair(settings, capability);
						const next = applyModelChange(current, newValue, families);
						if (!next) return;
						settings = withCapabilityOverride(settings, capability, next);
					}
				} else {
					const existing = capabilityOverride(settings, capability);
					const current = existing ?? {
						backend: capabilityBackend(settings, capability) === "agy" ? undefined : capabilityBackend(settings, capability),
						model: settings.model,
						effort: capabilityPair(settings, capability).effort,
					};
					const next = applyEffortChange(current, newValue, families);
					if (!next) return;
					settings = withCapabilityOverride(settings, capability, next);
				}
			}
			refresh();
			tui.requestRender();
			persist(settings);
		};

		const requestClose = () => {
			if (saving) {
				closeRequested = true;
				return;
			}
			close();
		};

		const settingsList = new SettingsList(items, Math.min(items.length, listRows), getSettingsListTheme(), onChange, requestClose);
		return {
			render: (width: number) => {
				listArea = { top: 0, left: 0, width: 0, height: 0 };
				const height = modalHeight(tui);
				const innerWidth = Math.max(1, width - 2);
				const list = settingsList.render(innerWidth);
				// renderFrame shrinks a notice to one line before taking minBody rows.
				interactive = list.length <= Math.max(0, height - 5 - (notice ? 1 : 0));
				return renderFrame(theme, width, height, {
					header: () => theme.fg(
						interactive ? "accent" : "warning",
						theme.bold(interactive ? "Bro · config" : "Bro · config · enlarge terminal"),
					),
					body: (rows) => {
						if (!interactive) return [theme.fg("warning", "Enlarge the terminal to configure settings safely.")];
						// The subtitle gives way before SettingsList's selection, scroll state and key hints.
						const subtitle = rows > list.length
							? [truncateToWidth(theme.fg("dim", "Shared defaults, with optional overrides per capability"), innerWidth)]
							: [];
						// Clicks only reach list rows that were actually drawn.
						listArea = { top: 3 + subtitle.length, left: 1, width: innerWidth, height: Math.min(list.length, rows - subtitle.length) };
						return [...subtitle, ...list];
					},
					notice,
					hints: interactive ? undefined : "Esc close",
					fill: false,
					minBody: interactive ? list.length : 1,
				});
			},
			invalidate: () => settingsList.invalidate(),
			handleMouse: (event: BroMouseEvent) => delegateMouse(settingsList, event, listArea),
			handleInput: (data: string) => {
				if (!interactive) {
					// No picker is visible here: Esc closes config, still waiting for pending saves.
					if (matchesKey(data, "escape")) {
						requestClose();
						return;
					}
					if (notice) {
						notice = "";
						tui.requestRender();
					}
					return;
				}
				settingsList.handleInput?.(data);
				if (!closed) tui.requestRender();
			},
		};
	};
}
