/** Private per-session Bro state. Custom entries are not sent to the main model or advisor. */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BtwThread } from "./btw.ts";
import type { GrillThread } from "./grill-engine.ts";
import { parseBroMode } from "./prompt.ts";
import type { SimplifyResult, SimplifyState } from "./simplify-ui.ts";
import { isRecord } from "./util.ts";

export const BTW_SESSION_ENTRY = "bro-btw-thread";
export const GRILL_SESSION_ENTRY = "bro-grill-thread";
export const SIMPLIFY_SESSION_ENTRY = "bro-simplify-state";
export const LAST_RESULT_SESSION_ENTRY = "bro-last-result";

/** Last on-branch snapshot per feature, used to avoid duplicate append-only writes.
 * A tree move rebuilds these signatures from its own branch, not the old one.
 */
export function privateSessionEntrySnapshots(branch: readonly SessionEntry[]): Map<string, string> {
  const snapshots = new Map<string, string>();
  restorePrivateBroState(branch, snapshots);
  return snapshots;
}


export type PrivateBroSessionState = {
  btw?: BtwThread;
  grill?: GrillThread;
  simplify: SimplifyState;
};

const textTurns = (value: unknown): boolean =>
  Array.isArray(value) && value.every(turn =>
    isRecord(turn) && typeof turn.question === "string" && typeof turn.answer === "string");

function btwThread(value: unknown): BtwThread | undefined {
  if (!isRecord(value) || !textTurns(value.turns) || typeof value.full !== "boolean") return undefined;
  if (value.backend !== undefined && typeof value.backend !== "string") return undefined;
  return value as unknown as BtwThread;
}

function grillThread(value: unknown): GrillThread | undefined {
  if (!isRecord(value) || typeof value.topic !== "string" || !textTurns(value.turns) ||
      !["light", "balanced", "exhaustive"].includes(String(value.depth)) ||
      typeof value.fullAccess !== "boolean") return undefined;
  return value as unknown as GrillThread;
}

function simplifyResult(value: unknown, legacySteering?: string): SimplifyResult | undefined {
  if (!isRecord(value) || typeof value.text !== "string" || !isRecord(value.source) || typeof value.source.text !== "string") return undefined;
  const steering = legacySteering ?? (typeof value.showSteering === "string" ? value.showSteering : undefined);
  const mode = steering === undefined ? parseBroMode(value.mode) : undefined;
  return {
    text: value.text,
    source: { text: value.source.text, ...(typeof value.source.label === "string" ? { label: value.source.label } : {}) },
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.preferences === "boolean" ? { preferences: value.preferences } : {}),
    ...(mode ? { mode } : {}),
    ...(steering !== undefined ? { showSteering: steering } : {}),
  };
}

function simplifyState(value: unknown): SimplifyState {
  if (!isRecord(value)) return {};
  const result = simplifyResult(value.result);
  if (value.result !== undefined && !result) return {};
  return {
    ...(result ? { result } : {}),
    ...(value.view === "result" || value.view === "help" || value.view === "empty" ? { view: value.view } : {}),
    ...(typeof value.draft === "string" ? { draft: value.draft } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

/** Last matching entry on the active branch wins. A cleared state cannot resurrect. */
export function restorePrivateBroState(branch: readonly SessionEntry[], snapshots?: Map<string, string>): PrivateBroSessionState {
  const restored: PrivateBroSessionState = { simplify: {} };
  let hasSimplifySnapshot = false;
  for (const entry of branch) {
    if (entry.type !== "custom" || !isRecord(entry.data)) continue;
    const value = entry.data;
    switch (entry.customType) {
      case BTW_SESSION_ENTRY:
        restored.btw = btwThread(value.thread);
        snapshots?.set(entry.customType, JSON.stringify(value));
        break;
      case GRILL_SESSION_ENTRY:
        restored.grill = grillThread(value.thread);
        snapshots?.set(entry.customType, JSON.stringify(value));
        break;
      case SIMPLIFY_SESSION_ENTRY:
        hasSimplifySnapshot = true;
        restored.simplify = simplifyState(value.state);
        snapshots?.set(entry.customType, JSON.stringify(value));
        break;
      case LAST_RESULT_SESSION_ENTRY: {
        // Show and old `/bro open` retries wrote only this entry. An old Explain
        // can also be a stale copy, so it must not override a cleared snapshot.
        const steering = typeof value.steering === "string" ? value.steering : undefined;
        if (steering === undefined && hasSimplifySnapshot && !restored.simplify.result) break;
        const result = simplifyResult(value.result, steering);
        if (result && JSON.stringify(result) !== JSON.stringify(restored.simplify.result)) {
          restored.simplify = { result, view: "result", draft: restored.simplify.draft };
          snapshots?.delete(SIMPLIFY_SESSION_ENTRY);
        }
        break;
      }
    }
  }
  return restored;
}
