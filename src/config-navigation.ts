/** Navigation taxonomy only. Existing config storage remains in settings.ts. */
import type { BroSettings, Capability } from "./settings.ts";
import { capabilityBackend, capabilityOverride, capabilityPair } from "./settings.ts";
import { reviewBackendNotice } from "./backend.ts";

export type ConfigSettingsPage = "defaults" | Capability;
export type ConfigNavScreen = "root" | "global" | "features" | "advisor" | "inherited" | "overthink";
export type ConfigNavState = { screen: ConfigNavScreen; inherited?: "elevate"|"grill-me"|"remember-me" };
export type ConfigNavAction =
  | {kind:"settings";page:ConfigSettingsPage}
  | {kind:"preferences"|"doctor"|"advisor-steer"|"overthink-defaults"|"overthink-toggle"|"close"};

export const CONFIG_ROOT = [
  {value:"global",label:"Global — shared defaults, preferences and Doctor"},
  {value:"features",label:"Features — specific settings and inherited behavior"},
] as const;
export const CONFIG_GLOBAL = [
  {value:"defaults",label:"Default backend, model and effort"},
  {value:"preferences",label:"Preferences — shared response style"},
  {value:"doctor",label:"Doctor — run setup and model diagnostics"},
] as const;
export const CONFIG_FEATURES = [
  {value:"explain",label:"Simplify — Explain override and default mode"},
  {value:"show",label:"Show — backend override and default turn count"},
  {value:"btw",label:"BTW — backend override; conversation/full access"},
  {value:"review",label:"Guided Review — override and inspection limits"},
  {value:"advisor",label:"Advisor — backend override and steering"},
  {value:"elevate",label:"Elevate — inherits BTW"},
  {value:"grill-me",label:"Grill Me — inherits BTW"},
  {value:"remember-me",label:"Remember Me — inherits BTW"},
  {value:"overthink",label:"Overthink — automatic checks and default questions"},
] as const;

export function effectiveConfigLabel(settings:BroSettings, capability:Capability):string {
  const p=capabilityPair(settings,capability);
  const source=capabilityOverride(settings,capability)?"override":"global default";
  return (capabilityBackend(settings,capability))+" / "+p.model+" / "+p.effort+" ("+source+")";
}

export function inheritedConfigDescription(settings:BroSettings, feature:"elevate"|"grill-me"|"remember-me"):string {
  const purpose=feature==="elevate"?"Improve a request":feature==="grill-me"?"Private decision interview":"Personal memory writing";
  return purpose+". This workflow inherits BTW's configured backend, model and effort: "+
    effectiveConfigLabel(settings,"btw")+
    ". No separate override exists. Use Features > BTW to change the inherited selection.";
}


/**
 * Show the selected backend's actual access boundary at the point of configuration.
 * Informational only: does not alter backend invocation, tools or permissions.
 * Matched to the existing backend adapter flags and reference/data-and-permissions.md.
 */
export function configFeatureAccessNote(settings: BroSettings, feature: "btw" | "review"): string {
  const backend = capabilityBackend(settings,feature);
  if(feature==="btw") {
    const notes: Record<typeof backend,string> = {
      agy:"Agy's conversation-only path uses a temporary directory and sandboxed shell; the sandbox is not a no-write guarantee.",
      claude:"Claude disables tools in conversation-only mode.",
      grok:"Grok's conversation-only limit is prompt guidance only: its sandbox stays off and permissions are bypassed.",
      codex:"Codex allows workspace reads and sandboxed commands under its read-only sandbox; it is not tool-free.",
      muse:"Muse disables shell, write and approvals in conversation-only mode, but other tools can remain available.",
      pi:"Pi's conversation-only session has no tools, extensions or context files.",
    };
    return "BTW: /mode in the BTW modal toggles conversation-only and full workspace access; full mode bypasses backend permission checks. "+notes[backend];
  }
  const existing=reviewBackendNotice(backend);
  if(existing)return existing;
  const strict: Record<"claude"|"muse"|"pi",string>={
    claude:"Claude uses Read/Grep/Glob file-inspection tools only in the captured checkout; no shell.",
    muse:"Muse disables shell, writes and web access in the captured checkout; reads remain available.",
    pi:"Pi permits only read/grep/find/ls in the captured checkout; no shell or workspace writes.",
  };
  return "Guided Review: "+strict[backend as keyof typeof strict]+
    " PR content remains untrusted evidence; backend restrictions do not prove the review's conclusions.";
}
