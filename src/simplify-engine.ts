import { parseShowArguments } from "./show.ts";

export type SimplifyRequest =
  | { kind: "latest" }
  | { kind: "url" | "text" | "file"; input: string }
  | { kind: "show"; turns?: number; steering: string };

type Invalid = { kind: "invalid"; message: string };
export type SimplifyAction = SimplifyRequest | Invalid | { kind: "copy" | "clear" | "help" | "retry" };

export const SIMPLIFY_INPUTS = ["latest", "text", "file", "url", "show"] as const;

// The modal and one-shot entry share source grammar, not viewer actions.
export function parseSimplifyRequest(command: string, value: string): SimplifyRequest | Invalid {
  switch (command) {
    case "latest": return value ? { kind: "invalid", message: "Use /bro simplify latest without arguments." } : { kind: "latest" };
    case "text":
    case "file":
    case "url":
      return value ? { kind: command, input: value } : {
        kind: "invalid", message: `Use /bro simplify ${command} <${command === "file" ? "path" : command}>.`,
      };
    case "show": {
      const parsed = parseShowArguments(value);
      return parsed.invalid ? { kind: "invalid", message: "Use /bro simplify show [n-turns] [query]." } : {
        kind: "show", turns: parsed.requested === undefined ? undefined : Number(parsed.requested), steering: parsed.steering,
      };
    }
    default: return { kind: "invalid", message: "Use /bro simplify [latest | text <text> | file <path> | url <url> | show [n-turns] [query]]." };
  }
}

export function parseSimplifyAction(input: string): SimplifyAction {
  const [token = ""] = input.trim().split(/\s+/, 1);
  const command = token.toLowerCase();
  const value = input.trim().slice(token.length).trim();
  if (command === "/simplify") return value ? { kind: "invalid", message: "/simplify takes no arguments." } : { kind: "latest" };
  if (command === "/copy" || command === "/clear" || command === "/help" || command === "/retry") {
    return value ? { kind: "invalid", message: `${command} takes no arguments.` } : { kind: command.slice(1) as "copy" | "clear" | "help" | "retry" };
  }
  if (command === "/text" || command === "/file" || command === "/url" || command === "/show") {
    const parsed = parseSimplifyRequest(command.slice(1), value);
    return parsed.kind === "invalid" ? { ...parsed, message: parsed.message.replace("/bro simplify ", "/") } : parsed;
  }
  return { kind: "invalid", message: "Use /help for Simplify commands. Ordinary chat belongs to /bro btw." };
}

export const SIMPLIFY_MODAL_HELP = [
  "## Simplify · Commands",
  "",
  "Understand one source at a time, in plain words or as a diagram. Each new result replaces the last. This is not a chat.",
  "",
  "- `/simplify` — explain the latest completed assistant reply",
  "- `/text <text>` — explain pasted text",
  "- `/file <path>` — explain a local document (any readable path)",
  "- `/url <url>` — explain a public webpage",
  "- `/show [n-turns] [query]` — draw recent conversation text, optionally focused by a query",
  "- `/copy` — copy the current result",
  "- `/clear` — clear the result and its source",
  "- `/help` — show these commands",
  "",
  "With an empty composer, **M** changes the explanation mode, **O** opens a diagram when available, and **R** reruns the captured source. **Esc** returns from help to the saved result, or closes.",
].join("\n");
