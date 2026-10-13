// Candidate prompts measured against the shipped builders. A candidate rewrites one exact part of
// the shipped prompt, so a run shows the effect of that change alone. Nothing here ships to users.
import { buildDefaultPrompt, type BroMode } from "../src/prompt.ts";

type Candidate = { mode: BroMode; shipped: string; replacement: string };

export const CANDIDATES: Record<string, Candidate> = {};

export function buildArmPrompt(arm: string, source: string, mode: BroMode, preferences = ""): string {
	const prompt = buildDefaultPrompt(source, mode, preferences);
	const candidate = CANDIDATES[arm];
	if (!candidate) return prompt;
	if (mode !== candidate.mode) return prompt;
	// Fail loudly if the shipped prompt changed, instead of silently measuring the old wording.
	if (prompt.split(candidate.shipped).length !== 2) throw new Error(`Candidate ${arm} no longer matches the shipped ${mode} prompt`);
	return prompt.replace(candidate.shipped, candidate.replacement);
}
