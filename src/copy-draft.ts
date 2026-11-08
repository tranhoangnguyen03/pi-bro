/**
 * Keep original Markdown bytes which Pi Editor normalizes in its visible view.
 *
 * Edits must carry their actual cursor and operation, not just a before/after
 * text diff: deleting one of two identical newlines can otherwise replace an
 * untouched LF with CRLF (and spaces can mask an untouched tab).
 */
export function normalizeEditorMarkdown(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
}

export type MarkdownEditKind = "insert" | "backward" | "forward" | "undo" | "unknown";
export type MarkdownEdit = {
  kind: MarkdownEditKind;
  /** UTF-16 offset in expanded, normalized text immediately before the key. */
  beforeCursor?: number;
  /** UTF-16 offset immediately after the key; omitted for opaque paste markers. */
  afterCursor?: number;
};

/** Split original source at a UTF-16 offset in the normalized editor view. */
function splitAtNormalizedOffset(raw: string, position: number): [string, string] {
  if (position < 0) throw new RangeError("Negative Markdown offset");
  let offset = 0;
  for (let i = 0; i < raw.length;) {
    if (position === offset) return [raw.slice(0, i), raw.slice(i)];
    let sourceWidth = 1;
    let expanded = raw[i]!;
    if (expanded === "\r") {
      if (raw[i + 1] === "\n") sourceWidth = 2;
      expanded = "\n";
    } else if (expanded === "\t") {
      expanded = "    ";
    }
    const next = offset + expanded.length;
    if (position < next) {
      // Editing inside a tab expands ONLY the touched tab. Whole untouched
      // tabs and CRLF remain verbatim in the other segments of the source.
      const prefix = expanded.slice(0, position - offset);
      const suffix = expanded.slice(position - offset);
      return [raw.slice(0, i) + prefix, suffix + raw.slice(i + sourceWidth)];
    }
    offset = next;
    i += sourceWidth;
  }
  if (position === offset) return [raw, ""];
  throw new RangeError("Markdown offset exceeds editor text");
}

/** Use the cursor to anchor the edit, then verify it against the FULL new text. */
function validChange(before: string, next: string, start: number, end: number): boolean {
  const nextEnd = end + next.length - before.length;
  return start >= 0 && start <= end && end <= before.length && nextEnd >= start &&
    nextEnd <= next.length &&
    before.slice(0, start) === next.slice(0, start) &&
    before.slice(end) === next.slice(nextEnd);
}

type DraftSnapshot = { normalized: string; raw: string };

export class RawMarkdownDraft {
  private raw: string;
  private normalized: string;
  private history: DraftSnapshot[];

  constructor(source: string, editorText = normalizeEditorMarkdown(source)) {
    if (editorText !== normalizeEditorMarkdown(source)) throw new Error("Editor text differs from original Markdown");
    this.raw = source;
    this.normalized = editorText;
    this.history = [{ normalized: editorText, raw: source }];
  }

  get text(): string { return this.raw; }
  get editorText(): string { return this.normalized; }

  update(next: string, edit: MarkdownEdit): void {
    if (next === this.normalized) return;
    if (edit.kind === "undo") {
      // Pi may coalesce several typed characters into one undo. Find the
      // actual earlier editor snapshot, not a best-effort reverse diff.
      let index = -1;
      for (let i = this.history.length - 2; i >= 0; i--) {
        if (this.history[i]!.normalized === next) { index = i; break; }
      }
      if (index < 0) throw new Error("Cannot match the Pi Editor undo to the raw source");
      this.raw = this.history[index]!.raw;
      this.normalized = next;
      this.history.length = index + 1;
      return;
    }

    const before = this.normalized;
    const delta = next.length - before.length;
    const caret = edit.beforeCursor;
    if (caret === undefined || caret < 0 || caret > before.length) {
      throw new Error("Cannot locate this edit in the raw Markdown");
    }

    const candidates: [number, number][] = [];
    if (edit.kind === "insert" && delta > 0) candidates.push([caret, caret]);
    else if (edit.kind === "backward" && delta < 0) candidates.push([caret + delta, caret]);
    else if (edit.kind === "forward" && delta < 0) candidates.push([caret, caret - delta]);
    else if (edit.kind === "unknown") {
      if (delta > 0) candidates.push([caret, caret]);
      if (delta < 0) {
        candidates.push([caret + delta, caret], [caret, caret - delta]);
      }
    }
    const possible: string[] = [];
    for (const [start, end] of candidates) {
      if (!validChange(before, next, start, end)) continue;
      const after = edit.afterCursor;
      const resultingCursor = edit.kind === "insert" ? start + delta :
        edit.kind === "backward" || edit.kind === "forward" ? start : undefined;
      if (after !== undefined && resultingCursor !== undefined && after !== resultingCursor) continue;
      const [prefix, rest] = splitAtNormalizedOffset(this.raw, start);
      const [, suffix] = splitAtNormalizedOffset(rest, end - start);
      const nextEnd = end + delta;
      const raw = prefix + next.slice(start, nextEnd) + suffix;
      if (normalizeEditorMarkdown(raw) === next) possible.push(raw);
    }
    const distinct = [...new Set(possible)];
    if (distinct.length !== 1) {
      throw new Error(distinct.length ? "Ambiguous edit position" : "Edit does not match the Pi Editor cursor/action");
    }
    this.raw = distinct[0]!;
    this.normalized = next;
    this.history.push({ normalized: next, raw: this.raw });
  }
}
