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
	type BroSettings,
	type Capability,
	type ExternalBackend,
	CAPABILITIES,
	CAPABILITY_LABELS,
	EXTERNAL_BACKENDS,
	applyEffortChange,
	applyModelChange,
	capabilityBackend,
	capabilityOverride,
	capabilityPair,
	effortDisplay,
	resolveModelEffort,
	withCapabilityOverride,
} from "./settings.ts";
import { BRO_MODES, parseBroMode } from "./prompt.ts";
import { delegateMouse, formatNotice, modalHeight, renderFrame, type Area, type Theme, type TuiLike } from "./modal-kit.ts";
import type { BroMouseEvent } from "./ui-capabilities.ts";
import { errorMessage } from "./util.ts";

const SHOW_TURNS_PRESETS = [1, 2, 3, 5, 8];

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

		const modelPicker = (current: string, pickerDone: (value?: string) => void, capability?: Capability) => {
			const defaultResolved = resolveModelEffort({ model: settings.model, effort: settings.effort }, families);
			const options: SelectItem[] = [
				...(capability ? [{ value: "__default__", label: `Default (${defaultResolved.family?.label ?? settings.model})` }] : []),
				...families.map((family) => ({
					value: family.id,
					label: `${family.label}${family.efforts.length ? "" : " · fixed effort"}`,
				})),
				// Alternative CLI entries stay last so existing Agy keyboard navigation is unaffected.
				...Object.values(EXTERNAL_BACKENDS).flatMap((meta) =>
					meta.models.map((model) => ({
						value: `${meta.prefix}${model.id}`,
						label: `${model.label} · ${meta.name}`,
					})),
				),
			];
			for (const meta of Object.values(EXTERNAL_BACKENDS)) {
				options.push({ value: `__${meta.name}_custom__`, label: `${meta.label} · custom model ID…` });
			}
			const input = new Input();
			let enteringBackend: ExternalBackend | undefined;
			input.onSubmit = (value) => {
				if (value.trim() && enteringBackend) {
					const meta = EXTERNAL_BACKENDS[enteringBackend];
					pickerDone(`${meta.prefix}${value.trim()}`);
				}
			};
			const picker = new SelectList(options, Math.min(options.length, 8, listRows), getSelectListTheme());
			const selectedIndex = capability && current === "Default" ? 0 : options.findIndex((option) => option.value === current);
			picker.setSelectedIndex(Math.max(0, selectedIndex));
			picker.onSelect = (item) => {
				const custom = (Object.keys(EXTERNAL_BACKENDS) as ExternalBackend[]).find((b) => item.value === `__${b}_custom__`);
				if (custom) { enteringBackend = custom; tui.requestRender(); }
				else pickerDone(item.value);
			};
			picker.onCancel = () => pickerDone();
			const customLabel = () => enteringBackend ? EXTERNAL_BACKENDS[enteringBackend].label : "";
			return {
				// SettingsList draws an open submenu instead of its own list and hints, so the picker brings its own.
				render: (width: number) => enteringBackend
					? [
						`${customLabel()} model ID:`,
						...input.render(width),
						"",
						truncateToWidth(theme.fg("dim", "  Enter save · Esc back"), width),
					]
					: [...picker.render(width), "", truncateToWidth(theme.fg("dim", "  ↑/↓ choose · Enter select · Esc back"), width)],
				invalidate: () => { picker.invalidate(); input.invalidate(); },
				// SettingsList hands an open submenu its own events unchanged.
				handleMouse: (event: BroMouseEvent) => (enteringBackend ? delegateMouse(input, event, { top: 1, left: 0, width: tui.terminal?.columns ?? 80, height: 1 }) : delegateMouse(picker, event)),
				handleInput: (data: string) => {
					if (enteringBackend && matchesKey(data, "escape")) pickerDone();
					else if (enteringBackend) input.handleInput(data);
					else picker.handleInput(data);
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
			modelItem.currentValue =
				defaultBackend in EXTERNAL_BACKENDS
					? `${EXTERNAL_BACKENDS[defaultBackend as ExternalBackend].prefix}${settings.model}`
					: (def.family?.id ?? settings.model);
			effortItem.currentValue = effortDisplay(def, defaultBackend);
			effortItem.values =
				defaultBackend in EXTERNAL_BACKENDS
					? ["default", ...EXTERNAL_BACKENDS[defaultBackend as ExternalBackend].efforts]
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
					: backend in EXTERNAL_BACKENDS
						? `${EXTERNAL_BACKENDS[backend as ExternalBackend].prefix}${override.model}`
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
