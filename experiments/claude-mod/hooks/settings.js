// Claude-host settings: separate from Pi's bro-settings.json to avoid breaking Pi's parser.
export const BACKENDS = ["native", "agy", "codex", "pi"];
export const EFFORTS = {
  native: ["default"],
  agy: ["default", "low", "medium", "high"],
  codex: ["default", "low", "medium", "high", "xhigh"],
  pi: ["default", "minimal", "low", "medium", "high", "xhigh", "max"]
};
export const SEEDS = { native: "current", agy: "gemini-3.7-flash", codex: "gpt-5.4", pi: "" };
export const DEFAULT_CONFIG = Object.freeze({ version: 1, backend: "native", model: "current", effort: "default" });
export const CONFIG_KEY = "bro.claude.explain.backend.v1";

export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bro settings must be an object.");
  const { backend, model, effort } = value;
  if (!BACKENDS.includes(backend)) throw new Error("Choose Native Claude, Agy, Codex, or Pi.");
  if (typeof model !== "string" || model.length > 180 || /[\r\n\x00-\x1f]/.test(model))
    throw new Error("Model must be a single line of up to 180 characters.");
  if (!model.trim()) throw new Error("Choose a model. For Pi, use provider/model.");
  if (model.trim().startsWith("-")) throw new Error("Model must not start with a dash.");
  if (backend === "pi" && !/^[^/\s]+\/[^/\s].*$/.test(model.trim())) throw new Error("Pi requires provider/model.");
  if (backend === "native" && effort !== "default")
    throw new Error("Claude native completions do not expose an effort setting.");
  if (!EFFORTS[backend].includes(effort)) throw new Error("Unsupported reasoning effort for " + backend + ".");
  return { version: 1, backend, model: model.trim(), effort };
}
export function fromStore(value) {
  if (value == null) return { ...DEFAULT_CONFIG };
  return validateConfig(value);
}
export function changeBackend(current, backend) {
  if (!BACKENDS.includes(backend)) throw new Error("Unsupported backend");
  if (current.backend === backend) return { ...current };
  return { version: 1, backend, model: SEEDS[backend], effort: "default" };
}
export function settingsLabel(config) {
  return ({native:"Claude Native",agy:"Antigravity",codex:"Codex",pi:"Pi CLI"}[config.backend]) + " · " + (config.model || "(choose model)") + " · " + config.effort;
}
