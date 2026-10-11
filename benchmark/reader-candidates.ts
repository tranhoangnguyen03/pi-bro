// Candidate prompts measured against the shipped builders. A candidate rewrites one exact part of
// the shipped prompt, so a run shows the effect of that change alone. Nothing here ships to users.
import { buildDefaultPrompt, type BroMode } from "../prompt.ts";

type Candidate = { mode: BroMode; shipped: string; replacement: string };

export const CANDIDATES: Record<string, Candidate> = {
	"brief-v1": {
		mode: "brief",
		shipped: "So, please ELI-simpleton, and try not to go overboard with the forced analogies.",
		replacement:
			"So, please ELI-simpleton: give only what I need to know or act on, in short sentences and everyday words. " +
			"Explain any technical term you keep in a few plain words the first time it appears. " +
			"Put each condition before the action it controls. " +
			"Keep warnings, numbers, and anything still unverified or undecided. " +
			"Skip forced analogies.",
	},
};

export function buildArmPrompt(arm: string, source: string, mode: BroMode, preferences = ""): string {
	const prompt = buildDefaultPrompt(source, mode, preferences);
	if (arm === "shipped") return prompt;
	const candidate = CANDIDATES[arm];
	if (!candidate) throw new Error(`Unknown arm ${arm}`);
	if (mode !== candidate.mode) return prompt;
	// Fail loudly if the shipped prompt changed, instead of silently measuring the old wording.
	if (prompt.split(candidate.shipped).length !== 2) throw new Error(`Candidate ${arm} no longer matches the shipped ${mode} prompt`);
	return prompt.replace(candidate.shipped, candidate.replacement);
}
