/**
 * Preserve Markdown characters Pi's Editor normalizes when loading source.
 *
 * Pi Editor maps CRLF/CR to LF and tabs to four spaces. Keep the raw source
 * alongside the expanded editor view. Each editor change is a contiguous edit
 * in that view; splice only its changed span into the raw text. Untouched tabs,
 * line endings and code indentation remain byte-for-byte as supplied.
 */
export function normalizeEditorMarkdown(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
}

/** Split raw Markdown at a position in the editor's normalized text. */
function splitAtNormalizedOffset(raw: string, position: number): [string, string] {
  if (position < 0) throw new RangeError("Negative Markdown offset");
  let offset = 0;
  for (let i = 0; i < raw.length;) {
    if (position === offset) return [raw.slice(0, i), raw.slice(i)];
    let originalWidth = 1;
    let expanded = raw[i]!;
    if (expanded === "\r") {
      if (raw[i + 1] === "\n") originalWidth = 2;
      expanded = "\n";
    } else if (expanded === "\t") {
      expanded = "    ";
    }
    const next = offset + expanded.length;
    if (position < next) {
      const prefix = expanded.slice(0, position - offset);
      const suffix = expanded.slice(position - offset);
      // Splitting an edited tab requires expanding that tab; an untouched
      // whole tab or CRLF is always kept in its original form.
      return [raw.slice(0, i) + prefix, suffix + raw.slice(i + originalWidth)];
    }
    offset = next;
    i += originalWidth;
  }
  if (position === offset) return [raw, ""];
  throw new RangeError("Markdown offset exceeds normalized text");
}

/** Applies editor-visible edits to raw source without normalizing unrelated text. */
export class RawMarkdownDraft {
  private raw: string;
  private normalized: string;
  private readonly initialRaw: string;
  private readonly initialNormalized: string;

  constructor(source: string, editorText = normalizeEditorMarkdown(source)) {
    this.initialRaw = source;
    this.initialNormalized = normalizeEditorMarkdown(source);
    if (editorText !== this.initialNormalized) throw new Error("Editor text differs from the initial Markdown");
    this.raw = source;
    this.normalized = editorText;
  }

  get text(): string { return this.raw; }

  update(next: string): void {
    const before = this.normalized;
    if (next === before) return;
    if (next === this.initialNormalized) {
      // Undo back to the original visible text restores the raw source too.
      this.raw = this.initialRaw;
      this.normalized = next;
      return;
    }
    let start = 0;
    while (start < before.length && start < next.length && before[start] === next[start]) start++;
    let oldEnd = before.length;
    let newEnd = next.length;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === next[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    const [prefix, tail] = splitAtNormalizedOffset(this.raw, start);
    const [, suffix] = splitAtNormalizedOffset(tail, oldEnd - start);
    const result = prefix + next.slice(start, newEnd) + suffix;
    if (normalizeEditorMarkdown(result) !== next) {
      throw new Error("Markdown edit could not be reconciled without losing source text");
    }
    this.raw = result;
    this.normalized = next;
  }
}
