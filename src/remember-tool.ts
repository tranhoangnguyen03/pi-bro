/** Read-only agent interface for the user-approved personal memory store. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readMemoryStore, renderUserMemory } from "./remember-store.ts";

export function registerAboutUserTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "about_user",
    label: "About user",
    description: "Read user-approved personal memories. Call without arguments for short summaries and IDs; query by topic; expand IDs only when detail is needed. Current user requests override standing preferences. Never invent or edit a memory.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Topic to find relevant user memories" })),
      expand: Type.Optional(Type.Array(Type.String(), { description: "Stable memory IDs to unfold", maxItems: 12 })),
    }),
    async execute(_id, params) {
      const store = await readMemoryStore();
      return { content: [{ type: "text" as const, text: renderUserMemory(store, params) }] };
    },
  });
}
