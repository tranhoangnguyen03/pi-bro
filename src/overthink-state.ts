/** Small private Overthink settings and session entries; custom entries never enter LLM context. */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./util.ts";

export const OVERTHINK_ENTRY = "bro-overthink";
export const OVERTHINK_DEFAULTS_FILE = "bro-overthink-defaults.json";
export const FACTORY_QUESTIONS = [
  "Are we going in the right direction?",
  "Where are we now, where do we want to be, and where are we actually going?",
  "Are we solving the real problem, or just completing the tasks in front of us?",
  "What are we taking for granted that might be wrong?",
  "What important risks or failure modes are we overlooking?",
  "Have we drifted from the original intent or added complexity without enough value?",
  "What is the most useful correction or next move we can make now?",
] as const;

const MAX_QUESTIONS = 32;
const MAX_QUESTION_CHARS = 500;
const MAX_NOTE_CHARS = 8000;
export type OverthinkUsage = { cacheRead?: number; cacheWrite?: number; input?: number; output?: number };
export type OverthinkNote = {
  text: string; checkedAt: string; model: string; questionKey: string;
  usage?: OverthinkUsage;
};
export type OverthinkSession = { questions?: string[]; note?: OverthinkNote; initialized: boolean };

export function checkQuestions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_QUESTIONS) {
    throw new Error("Overthink allows at most 32 questions.");
  }
  const questions = value.map((item: unknown) => {
    if (typeof item !== "string" || !item.trim() || item.length > MAX_QUESTION_CHARS || /[\r\n\u0000-\u001f]/.test(item)) {
      throw new Error("Each question must be a single nonempty line of at most 500 characters.");
    }
    return item.trim();
  });
  return questions;
}

export function questionsFromText(value: string): string[] {
  return checkQuestions(value.split(/\r?\n/).map(x => x.trim()).filter(Boolean));
}
export function questionKey(questions: readonly string[]): string { return JSON.stringify(questions); }

export function resolveOverthinkSession(branch: readonly SessionEntry[]): OverthinkSession {
  const state: OverthinkSession = { initialized: false };
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== OVERTHINK_ENTRY || !isRecord(entry.data) || entry.data.version !== 1) continue;
    if (entry.data.kind === "questions") {
      try { state.questions = checkQuestions(entry.data.questions); state.initialized = true; }
      catch { /* Ignore damaged historical records without granting them authority. */ }
    } else if (entry.data.kind === "note") {
      const data = entry.data;
      if (typeof data.text === "string" && data.text.length <= MAX_NOTE_CHARS &&
          typeof data.checkedAt === "string" && typeof data.model === "string" &&
          typeof data.questionKey === "string") {
        const note: OverthinkNote = {
          text: data.text, checkedAt: data.checkedAt, model: data.model, questionKey: data.questionKey,
        };
        if (isRecord(data.usage)) {
          const usage: OverthinkUsage = {};
          for (const key of ["cacheRead", "cacheWrite", "input", "output"] as const) {
            const val = data.usage[key];
            if (typeof val === "number" && Number.isFinite(val) && val >= 0) usage[key] = val;
          }
          note.usage = usage;
        }
        state.note = note;
      }
    }
  }
  return state;
}

export function globalQuestionsFile(dir = getAgentDir()): string {
  return join(dir, OVERTHINK_DEFAULTS_FILE);
}
export async function readGlobalQuestions(dir = getAgentDir()): Promise<string[]> {
  const file = globalQuestionsFile(dir);
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...FACTORY_QUESTIONS];
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) throw new Error("Unsafe or oversized Overthink defaults file: " + file);
  const data = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!isRecord(data) || data.version !== 1) throw new Error("Unsupported Overthink defaults format: " + file);
  return checkQuestions(data.questions);
}

export async function writeGlobalQuestions(questions: readonly string[], dir = getAgentDir()): Promise<void> {
  const cleaned = checkQuestions([...questions]);
  await mkdir(dir, { recursive: true });
  const file = globalQuestionsFile(dir);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe Overthink defaults file: " + file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify({ version: 1, questions: cleaned }, null, 2) + "\n", {
      encoding: "utf8", mode: 0o600, flag: "wx", flush: true,
    });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }).catch(() => undefined); }
}

export async function ensureOverthinkSession(pi: ExtensionAPI, branch: readonly SessionEntry[]): Promise<OverthinkSession> {
  const current = resolveOverthinkSession(branch);
  if (current.initialized) return current;
  const questions = await readGlobalQuestions();
  pi.appendEntry(OVERTHINK_ENTRY, { version: 1, kind: "questions", questions });
  return { ...current, initialized: true, questions };
}

export function saveSessionQuestions(pi: ExtensionAPI, questions: readonly string[]): void {
  pi.appendEntry(OVERTHINK_ENTRY, { version: 1, kind: "questions", questions: checkQuestions([...questions]) });
}
export function saveOverthinkNote(pi: ExtensionAPI, note: OverthinkNote): void {
  pi.appendEntry(OVERTHINK_ENTRY, { version: 1, kind: "note", ...note });
}

export function overthinkPrompt(questions: readonly string[]): string {
  return [
    "[Bro Overthink: private second look]",
    "Reassess the current work using the preceding Pi conversation as evidence. Consider these user-written questions:",
    ...questions.map((q, i) => String(i + 1) + ". " + q),
    "Find only material points that could change the next decision or the quality of the work.",
    "Prefer direction, assumptions, evidence, risks, coherence, and the next useful move. Do not fabricate problems, demand checks for hypothetical edge cases, or restate concerns already clear in the last assistant reply.",
    "Write in the user's language. Keep it short: at most three specific findings with evidence and a useful next move. Plain text, no mandatory template or question-by-question answers.",
    "When nothing material is worth bringing up, return exactly NONE.",
  ].join("\n");
}
export function parseOverthinkAnswer(text: string): string {
  const cleaned = text.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (/^none\.?$/i.test(cleaned)) return "";
  return cleaned.slice(0, MAX_NOTE_CHARS);
}

/** Only use provider-reported values; absence means unknown, never zero. */
export function readOverthinkUsage(raw: unknown): OverthinkUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const usage: OverthinkUsage = {};
  const fields = { cacheRead: ["cacheReadTokens", "cacheRead"], cacheWrite: ["cacheWriteTokens", "cacheWrite"], input: ["inputTokens", "input"], output: ["outputTokens", "output"] } as const;
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    for (const field of fields[key]) {
      const value = raw[field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) { usage[key] = value; break; }
    }
  }
  return Object.keys(usage).length ? usage : undefined;
}
