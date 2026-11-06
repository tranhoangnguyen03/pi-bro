/** Private per-session Bro state. Custom entries are not sent to the main model or advisor. */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BtwThread } from "./btw.ts";
import type { GrillThread } from "./grill-engine.ts";
import type { ModalResult } from "./explain-modal.ts";
import type { SimplifyState } from "./simplify-ui.ts";
import { isRecord } from "./util.ts";

export const BTW_SESSION_ENTRY = "bro-btw-thread";
export const GRILL_SESSION_ENTRY = "bro-grill-thread";
export const SIMPLIFY_SESSION_ENTRY = "bro-simplify-state";
export const LAST_RESULT_SESSION_ENTRY = "bro-last-result";

export type PrivateBroSessionState = {
  btw?: BtwThread;
  grill?: GrillThread;
  simplify: SimplifyState;
  lastResult?: ModalResult;
  lastShowSteering?: string;
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

function modalResult(value: unknown): ModalResult | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  if (value.source !== undefined && (!isRecord(value.source) || typeof value.source.text !== "string")) return undefined;
  return value as unknown as ModalResult;
}

function simplifyState(value: unknown): SimplifyState {
  if (!isRecord(value)) return {};
  const result = modalResult(value.result);
  if (value.result !== undefined && !result?.source) return {};
  return {
    ...(result ? { result: result as SimplifyState["result"] } : {}),
    ...(value.view === "result" || value.view === "help" || value.view === "empty" ? { view: value.view } : {}),
    ...(typeof value.draft === "string" ? { draft: value.draft } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

/** Last matching entry on the active branch wins. A cleared state cannot resurrect. */
export function restorePrivateBroState(branch: readonly SessionEntry[]): PrivateBroSessionState {
  const restored: PrivateBroSessionState = { simplify: {} };
  for (const entry of branch) {
    if (entry.type !== "custom" || !isRecord(entry.data)) continue;
    const value = entry.data;
    switch (entry.customType) {
      case BTW_SESSION_ENTRY: restored.btw = btwThread(value.thread); break;
      case GRILL_SESSION_ENTRY: restored.grill = grillThread(value.thread); break;
      case SIMPLIFY_SESSION_ENTRY: restored.simplify = simplifyState(value.state); break;
      case LAST_RESULT_SESSION_ENTRY:
        restored.lastResult = modalResult(value.result);
        restored.lastShowSteering = typeof value.steering === "string" ? value.steering : undefined;
        break;
    }
  }
  return restored;
}
