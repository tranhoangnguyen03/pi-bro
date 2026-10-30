/** Read-only agent interface for the user-approved personal memory store. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readMemoryStore, renderUserMemory } from "./remember-store.ts";

export function registerAboutUserTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "about_user",
    label: "About user",
    description: "Read user-approved personal memories in bounded pages. Continue with offset, query by topic, or expand IDs for source and exceptions. Current requests override standing preferences. No write access.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Topic to find relevant user memories" })),
      expand: Type.Optional(Type.Array(Type.String(), { description: "Stable memory IDs to unfold", maxItems: 12 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based start for overview or search" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Page size" })),
    }),
    async execute(_id, params) {
      const store = await readMemoryStore();
      return { content: [{ type: "text" as const, text: renderUserMemory(store, params) }], details: {} };
    },
  });
}
