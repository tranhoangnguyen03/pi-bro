/** Pure command parser for the one-source-at-a-time Simplify modal. */
export type SimplifyAction =
  | { kind: "latest" | "copy" | "clear" | "help" | "retry" }
  | { kind: "url" | "text" | "file"; input: string }
  | { kind: "invalid"; message: string };

export function parseSimplifyAction(input: string): SimplifyAction {
  const trimmed = input.trim();
  if (!trimmed) return { kind:"invalid", message:"Enter /simplify, /url, /text, /file, /copy, /clear or /help." };
  const i=trimmed.indexOf(" ");
  const cmd=(i<0?trimmed:trimmed.slice(0,i)).toLowerCase();
  const value=i<0?"":trimmed.slice(i+1).trim();
  if (["/simplify","/copy","/clear","/help","/retry"].includes(cmd)) {
    if(value) return {kind:"invalid",message:cmd+" takes no arguments."};
    return {kind:({"/simplify":"latest","/copy":"copy","/clear":"clear","/help":"help","/retry":"retry"} as Record<string,"latest"|"copy"|"clear"|"help"|"retry">)[cmd]!};
  }
  for (const kind of ["url","text","file"] as const) {
    if(cmd==="/"+kind) return value ? {kind,input:value} : {kind:"invalid",message:"Use /"+kind+" <"+(kind==="url"?"url":kind==="file"?"path":"text")+">."};
  }
  return {kind:"invalid",message:"Unknown Simplify command. Use /help. Ordinary chat belongs to /bro btw."};
}

export const SIMPLIFY_MODAL_HELP = [
  "## Simplify · Commands",
  "",
  "Bro explains one source in plain language. Every new explanation replaces the last one. This is not a chat.",
  "",
  "- \`/simplify\` — explain the latest completed assistant reply",
  "- \`/url <url>\` — explain a public webpage",
  "- \`/text <text>\` — explain pasted text",
  "- \`/file <path>\` — explain a workspace document",
  "- \`/copy\` — copy the current explanation",
  "- \`/clear\` — clear the explanation and source",
  "- \`/help\` — show these commands",
  "",
  "With an empty composer, **M** changes explanation mode and re-explains the captured source; **R** retries. Both keep the backend configured for Explain. **Esc** closes; /bro simplify reopens this view in the current Pi session.",
].join("\n");
