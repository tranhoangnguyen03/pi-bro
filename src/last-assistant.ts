/**
 * One authoritative selection rule for the last completed assistant reply.
 * Explain intentionally trims its result; Copy keeps the untrimmed text.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Multiple text content blocks are flattened with one LF, matching Bro's
 * existing Explain convention (the LF is a separator, not an original block).
 * Ignore reasoning, images, unfinished replies and non-text messages.
 */
export function latestCompletedAssistantText(branch: readonly SessionEntry[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason !== "stop") continue;
    const text = entry.message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map(part => part.text)
      .join("\n");
    if (text.trim()) return text;
  }
  return undefined;
}
