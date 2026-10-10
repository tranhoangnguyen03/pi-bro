// Report-only surface counts, not readability scores. Markdown syntax counts as written.
export function readerCounts(text: string) {
 return {
  words: text.trim().split(/\s+/u).filter(Boolean).length,
  characters: text.length,
  sentences: [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].filter(s => /[\p{L}\p{N}]/u.test(s.segment)).length,
  emDashes: (text.match(/—/gu) ?? []).length,
  boldSpans: (text.match(/\*\*[^\n]+?\*\*|__[^\n]+?__/gu) ?? []).length,
  headers: (text.match(/^ {0,3}#{1,6}\s+\S/gmu) ?? []).length,
  bulletLines: (text.match(/^\s*(?:[-+*]|\d+[.)])\s+\S/gmu) ?? []).length,
 };
}
