/** Navigation taxonomy only. Existing config storage remains in settings.ts. */
import type { BroSettings, Capability } from "./settings.ts";
import { capabilityBackend, capabilityOverride, capabilityPair } from "./settings.ts";

export type ConfigSettingsPage = "defaults" | Capability;
export type ConfigNavScreen = "root" | "global" | "features" | "advisor" | "inherited";
export type ConfigNavState = { screen: ConfigNavScreen; inherited?: "elevate"|"grill-me"|"remember-me" };
export type ConfigNavAction =
  | {kind:"settings";page:ConfigSettingsPage}
  | {kind:"preferences"|"doctor"|"advisor-steer"|"close"};

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
  {value:"btw",label:"BTW — backend override; permissions stay in BTW"},
  {value:"review",label:"Guided Review — backend override"},
  {value:"advisor",label:"Advisor — backend override and steering"},
  {value:"elevate",label:"Elevate — inherits BTW"},
  {value:"grill-me",label:"Grill Me — inherits BTW"},
  {value:"remember-me",label:"Remember Me — inherits BTW"},
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
