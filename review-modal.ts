import { Input, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { findingText, guideEvidence, type Evidence, type Finding, type ReviewRecord } from './review.ts';

export type ReviewView = {
  selected: string;
  screen: 'reading' | 'file' | 'discussion' | 'finding';
  file: string;
  target: string;
  pane: 'contents' | 'detail';
  offsets: Record<string, number>;
  drafts: Record<string, string>;
  row: number;
  scope?: string;
  returnTo?: { selected: string; screen: 'reading' | 'file' | 'finding'; file: string; target: string; row: number };
};
export const newReviewView = (): ReviewView => ({ selected: 'overview', screen: 'reading', file: '', target: 'whole review', pane: 'contents', offsets: {}, drafts: {}, row: 0 });
export type ReviewControls = {
  ask(target: string, question: string): void;
  prepare(): void;
  regenerate(): void;
  retrySave(): void;
  stop(): void;
  close(): void;
  changed(): void;
  copy(text: string): void;
};
type Tui = { terminal: { rows: number; columns?: number }; requestRender(): void };
// Structural subset keeps normalized mouse support compatible with the pinned pre-mouse SDK.
type ReviewMouseEvent = { type: string; x: number; y: number; wheelDelta?: number };
type Theme = { fg: (name: any, text: string) => string; bold: (text: string) => string };
export const safeReviewText = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const label = (text: string) => safeReviewText(text).replace(/[\n\r\t]/g, ' ');

/** The controller owns requests and saving; this component only owns interaction. */
export class ReviewModal {
  focused = true;
  busy = false;
  startedAt = 0;
  stage: { step: 'start' | 'investigate' | 'receive' | 'check' | 'save'; detail: string } | undefined;
  operation: 'guide' | 'answer' | 'regenerate' = 'guide';
  activeTurn: ReviewRecord['turns'][number] | undefined;
  notice = '';
  saveError = '';
  evidence = new Map<string, string>();
  evidenceErrors = new Map<string, string>();
  private input = new Input();
  private markdown = new Markdown('', 0, 0, getMarkdownTheme());
  private focus: 'contents' | 'body' | 'actions' | 'input';
  private action = 0;
  private maxOffset = 0;
  private tiny = false;
  private width = 100;
  private followAnswer = false;
  private fileDiffs: Map<string, string> | undefined;
  private contentsOffset: number | undefined;
  private manualListKey: string | undefined;
  private layout = { height: 0, bodyRows: 0, leftWidth: 0, navigationOnly: false, contentsStart: 0, bodyStart: 4 };
  readonly view: ReviewView;

  constructor(public record: ReviewRecord, public tui: Tui, private theme: Theme, private controls: ReviewControls) {
    this.view = record.ui ??= newReviewView();
    this.focus = this.view.pane === 'contents' ? 'contents' : this.view.screen === 'discussion' ? 'input' : 'body';
    this.syncGuideView();
  }
  private entries(): { id: string; title: string }[] {
    return [{ id: 'overview', title: 'Overview' }, ...(this.record.guide?.topics ?? []).map((topic, i) => ({ id: topic.id, title: `${i + 1}. ${topic.title}` })),
      ...(this.record.guide?.assessment ? [{ id: 'findings', title: `Findings (${this.record.guide.assessment.findings.length})` }, ...(this.record.guide.assessment.findings.some(finding => !finding.topicId) ? [{ id: 'across', title: 'Across the change' }] : []), { id: 'coverage', title: 'Coverage and limitations' }] : []),
      { id: 'files', title: `Changed files (${this.record.snapshot.files.length})` },
      { id: 'questions', title: `Your questions (${this.discussions.length})` }, { id: 'close', title: this.busy ? 'Stop and close' : 'Close' }];
  }
  private get topic() { return this.record.guide?.topics.find(topic => topic.id === this.view.selected); }
  private get finding() { return this.record.guide?.assessment?.findings.find(finding => finding.id === this.view.target); }
  private get latestTurn() { return this.record.turns.filter(turn => turn.target === this.view.target).at(-1); }
  private get stopLabel() { return this.operation === 'answer' ? 'Stop response' : this.operation === 'regenerate' ? 'Stop regeneration' : 'Stop preparation'; }
  private get findings() {
    const rank = { high: 0, medium: 1, low: 2 };
    return [...(this.record.guide?.assessment?.findings ?? [])].filter(finding => (this.view.selected !== 'across' || !finding.topicId) && (!this.view.scope || finding.topicId === this.view.scope)).sort((a, b) => Number(a.kind === 'question') - Number(b.kind === 'question') || rank[a.severity] - rank[b.severity]);
  }
  private get isList() { return this.view.screen === 'reading' && ['files', 'questions', 'findings', 'across'].includes(this.view.selected); }
  private get discussions() {
    return [...this.record.turns.map(turn => ({ target: turn.target, text: turn.question, draft: false })), ...Object.entries(this.view.drafts).filter(([, text]) => text).map(([target, text]) => ({ target, text, draft: true }))];
  }
  private get listLength() { return this.view.selected === 'files' ? this.record.snapshot.files.length : this.view.selected === 'questions' ? this.discussions.length : this.findings.length; }
  private get key() { return `${this.view.selected}:${this.view.screen}:${['discussion', 'finding'].includes(this.view.screen) ? this.view.target : this.view.screen === 'file' ? this.view.file : ''}${this.view.scope ? `:topic:${this.view.scope}` : ''}`; }
  private targetLabel(target: string): string {
    if (target === 'whole review') return 'whole review';
    if (target.startsWith('file:')) return target.slice(5);
    return this.record.guide?.topics.find(topic => topic.id === target)?.title ?? this.record.guide?.assessment?.findings.find(finding => finding.id === target)?.title ?? `Earlier · ${this.record.targetContexts?.[target]?.title ?? target}`;
  }
  syncGuideView(): void {
    if (!this.record.guide?.topics.some(topic => topic.id === this.view.scope)) delete this.view.scope;
    const origin = this.view.returnTo;
    if (origin && (typeof origin !== 'object' || !['reading','file','finding'].includes(origin.screen) || typeof origin.file !== 'string' || typeof origin.target !== 'string' || !Number.isInteger(origin.row) || origin.row < 0 || !this.entries().some(entry => entry.id === origin.selected) || (origin.screen === 'finding' && !this.record.guide?.assessment?.findings.some(finding => finding.id === origin.target)) || (origin.screen === 'file' && !this.record.snapshot.files.some(file => file.path === origin.file)))) delete this.view.returnTo;
    this.focus = this.view.pane === 'contents' ? 'contents' : this.view.screen === 'discussion' ? 'input' : 'body';
    this.input.setValue(this.view.drafts[this.view.target] ?? '');
    this.contentsOffset = undefined; this.manualListKey = undefined; this.followAnswer = false; this.action = 0;
  }
  private actions(): string[] {
    const recovery = this.saveError && this.view.selected !== 'close' ? ['Retry saving'] : [];
    if (this.view.selected === 'close') return [];
    if (this.view.screen === 'discussion') return [...recovery, this.busy ? this.stopLabel : 'Send question', ...(!this.busy && this.latestTurn && this.latestTurn.status !== 'complete' ? ['Edit and resend'] : []), 'Back'];
    const stop = this.busy ? [this.stopLabel] : [];
    const ask = this.busy ? [] : [this.view.screen === 'finding' ? 'Ask about this finding' : this.view.screen === 'file' ? 'Ask about this file' : this.topic ? 'Ask a question' : 'Ask about this review'];
    if (this.view.screen === 'finding') return [...recovery, ...ask, 'Copy finding', 'Back', ...stop];
    if (this.view.screen === 'file') return [...recovery, ...ask, 'Back to files', ...stop];
    if (this.isList || this.view.selected === 'coverage') return [...recovery, ...stop];
    if (this.topic) return [...recovery, ...(this.record.guide?.assessment?.findings.some(finding => finding.topicId === this.topic!.id) ? ['View topic findings'] : []), ...ask, ...stop];
    return [...recovery, ...(!this.record.guide && !this.busy ? ['Prepare guide'] : []), ...ask, ...(this.busy ? stop : this.record.guide ? ['Regenerate guide'] : [])];
  }
  private changed() {
    this.view.pane = this.focus === 'contents' ? 'contents' : 'detail';
    this.controls.changed();
    this.tui.requestRender();
  }
  private select(id: string) {
    this.contentsOffset = undefined;
    this.manualListKey = undefined;
    if (id !== this.view.selected) this.view.row = 0;
    delete this.view.scope; delete this.view.returnTo;
    this.notice = '';
    this.view.selected = id;
    this.view.screen = 'reading';
    this.action = 0;
    this.maxOffset = 0;
  }
  openDiscussion(target: string) {
    if (this.view.screen !== 'discussion') this.view.returnTo = { selected: this.view.selected, screen: this.view.screen, file: this.view.file, target: this.view.target, row: this.view.row };
    this.notice = '';
    this.view.target = target;
    this.followAnswer = false;
    this.view.screen = 'discussion';
    this.focus = 'input';
    this.input.setValue(this.view.drafts[target] ?? '');
    this.action = 0;
  }
  private back() {
    this.notice = '';
    if (this.view.screen === 'discussion' && this.view.returnTo) {
      Object.assign(this.view, this.view.returnTo); delete this.view.returnTo; this.focus = 'body';
    } else if (this.view.screen === 'discussion') {
      this.view.screen = this.finding ? 'finding' : this.view.target.startsWith('file:') ? 'file' : 'reading';
      if (this.view.screen === 'file') { this.view.file = this.view.target.slice(5); this.view.selected = 'files'; }
      else this.view.selected = this.finding ? 'findings' : this.view.target === 'whole review' ? 'overview' : this.record.guide?.topics.some(topic => topic.id === this.view.target) ? this.view.target : 'questions';
      if (this.finding) this.view.row = Math.max(0, this.findings.findIndex(finding => finding.id === this.view.target));
      this.focus = 'body';
    } else if (this.view.screen === 'file' || this.view.screen === 'finding') { this.view.screen = 'reading'; this.focus = 'body'; }
    else if (this.view.scope) { const topic = this.view.scope; this.select(topic); this.focus = 'body'; }
    else { this.focus = 'contents'; }
    this.action = 0;
  }
  private ask() {
    if (this.busy) { this.notice = `${this.operation === 'answer' ? 'An answer' : 'Preparation'} is running. Your draft is kept; stop it before sending.`; return; }
    const question = this.input.getValue().trim();
    if (!question) { this.focus = 'input'; return; }
    this.input.setValue('');
    this.view.drafts[this.view.target] = '';
    this.followAnswer = true;
    this.controls.ask(this.view.target, question);
  }
  private activate() {
    const action = this.actions()[this.action];
    if (action?.startsWith('Ask')) this.openDiscussion(this.view.screen === 'file' ? `file:${this.view.file}` : this.view.screen === 'finding' ? this.view.target : this.topic?.id ?? 'whole review');
    else if (action === 'Copy finding' && this.finding) this.controls.copy(findingText(this.finding));
    else if (action === 'View topic findings') {
      const id = this.topic!.id; this.select('findings'); this.view.scope = id; this.view.row = 0; this.focus = 'body';
    }
    else if (action === 'Send question') this.ask();
    else if (action === 'Edit and resend') {
      if (this.view.drafts[this.view.target]) this.notice = 'Your current draft is kept. Edit it or clear it before restoring the earlier question.';
      else { const question = this.latestTurn?.question ?? ''; this.input.setValue(question); this.view.drafts[this.view.target] = question; }
      this.focus = 'input';
    }
    else if (action === this.stopLabel) this.controls.stop();
    else if (action === 'Prepare guide') this.controls.prepare();
    else if (action === 'Regenerate guide') this.controls.regenerate();
    else if (action === 'Retry saving') this.controls.retrySave();
    else if (action === 'Back' || action === 'Back to files') this.back();
    this.action = 0;
  }
  handleMouse(event: ReviewMouseEvent): { handled: boolean; render: boolean } | undefined {
    if (event.type !== 'wheel') return;
    if (this.tiny || event.x < 0 || event.x >= this.width || event.y < 0 || event.y >= this.layout.height) return { handled: true, render: false };
    const { bodyRows, leftWidth, navigationOnly, contentsStart, bodyStart } = this.layout;
    const start = 4;
    const rows = bodyRows + bodyStart - 4;
    if (event.y < start || event.y >= start + rows || event.x === 0 || event.x === this.width - 1) return { handled: true, render: false };
    const delta = Math.trunc(event.wheelDelta ?? 0);
    if (!delta) return { handled: true, render: false };
    if (navigationOnly || (leftWidth && event.x <= leftWidth)) {
      this.contentsOffset = Math.max(0, Math.min(Math.max(0, this.entries().length - bodyRows), (this.contentsOffset ?? contentsStart) + delta));
    } else {
      if (leftWidth && event.x < leftWidth + 4) return { handled: true, render: false };
      this.scroll(delta);
      this.manualListKey = this.key;
      this.controls.changed();
    }
    this.tui.requestRender();
    return { handled: true, render: true };
  }
  private scroll(delta: number) {
    const offset = Math.max(0, Math.min(this.maxOffset, (this.view.offsets[this.key] ?? 0) + delta));
    this.view.offsets[this.key] = offset;
    this.followAnswer = this.busy && this.activeTurn?.target === this.view.target && this.view.screen === 'discussion' && delta > 0 && offset === this.maxOffset;
  }
  handleInput(data: string): void {
    // Pi 0.84 forwards raw wheel input to focused overlays; newer hosts use handleMouse.
    const mouse = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
    if (mouse) {
      const button = Number(mouse[1]);
      if ((button & 64) && (button & 3) < 2 && mouse[4] === 'M') {
        const columns = this.tui.terminal.columns;
        if (columns !== undefined) this.handleMouse({ type: 'wheel', x: Number(mouse[2]) - 1 - Math.floor((columns - this.width) / 2), y: Number(mouse[3]) - 1 - Math.floor((this.tui.terminal.rows - this.layout.height) / 2), wheelDelta: (button & 1) ? 3 : -3 });
      }
      return;
    }
    if (this.tiny) { if (matchesKey(data, 'escape')) this.controls.close(); return; }
    if (matchesKey(data, 'escape')) {
      if (this.focus === 'contents') { this.controls.close(); return; }
      this.back(); this.changed(); return;
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const order: typeof this.focus[] = ['contents', 'body', ...(this.view.screen === 'discussion' ? ['input' as const] : []), ...(this.actions().length ? ['actions' as const] : [])];
      this.focus = order[(order.indexOf(this.focus) + (matchesKey(data, 'tab') ? 1 : order.length - 1)) % order.length]!;
    } else if (matchesKey(data, 'pageDown') || matchesKey(data, 'pageUp')) {
      this.render(this.width);
      const delta = (matchesKey(data, 'pageDown') ? 1 : -1) * Math.max(1, this.layout.bodyRows - 1);
      if (this.focus === 'contents') {
        const entries = this.entries(), index = entries.findIndex(entry => entry.id === this.view.selected);
        this.select(entries[Math.max(0, Math.min(entries.length - 1, index + delta))]!.id);
      } else if (this.isList && this.focus === 'body') { this.manualListKey = undefined; this.view.row = Math.max(0, Math.min(Math.max(0, this.listLength - 1), this.view.row + delta)); }
      else this.scroll(delta);
    } else if (this.focus === 'input') {
      if (matchesKey(data, 'return')) this.ask();
      else { this.input.handleInput(data); this.view.drafts[this.view.target] = this.input.getValue(); }
    } else if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
      const delta = matchesKey(data, 'down') ? 1 : -1;
      if (this.focus === 'contents') {
        const entries = this.entries(); const index = entries.findIndex(entry => entry.id === this.view.selected);
        this.select(entries[Math.max(0, Math.min(entries.length - 1, index + delta))]!.id);
      } else if (this.focus === 'actions') this.action = Math.max(0, Math.min(this.actions().length - 1, this.action + delta));
      else if (this.isList) { this.manualListKey = undefined; this.view.row = Math.max(0, Math.min(Math.max(0, this.listLength - 1), this.view.row + delta)); }
      else { this.render(this.width); this.scroll(delta); }
    } else if (matchesKey(data, 'return')) {
      if (this.focus === 'contents') {
        if (this.view.selected === 'close') { this.controls.close(); return; }
        this.focus = 'body';
      } else if (this.view.selected === 'close') { this.controls.close(); return; }
      else if (this.focus === 'actions') this.activate();
      else if (this.isList) {
        if (this.view.selected === 'files') { const file = this.record.snapshot.files[this.view.row]; if (file) { this.view.file = file.path; this.view.screen = 'file'; } }
        else if (this.view.selected === 'findings' || this.view.selected === 'across') {
          const finding = this.findings[this.view.row]; if (finding) { this.view.target = finding.id; this.view.screen = 'finding'; }
        }
        else {
          const discussion = this.discussions[this.view.row];
          if (discussion) this.openDiscussion(discussion.target);
        }
      } else if (this.actions().length) this.focus = 'actions';
    }
    this.changed();
  }
  private section(title: string, width: number, color = 'accent'): string {
    const text = `── ${label(title)} `;
    return this.theme.fg(color, truncateToWidth(text + '─'.repeat(Math.max(0, width - visibleWidth(text))), width, '…'));
  }
  private codeLine(text: string, gutter: string, width: number, color = 'text'): string[] {
    const prefix = `${gutter} │ `;
    const available = Math.max(1, width - visibleWidth(prefix));
    return wrapTextWithAnsi(safeReviewText(text).replace(/\t/g, '    '), available).map((part, index) =>
      this.theme.fg('dim', index ? ' '.repeat(visibleWidth(gutter)) + ' │ ' : prefix) + this.theme.fg(color, part));
  }
  private diffLines(section: string, width: number): string[] {
    const source = section.split('\n');
    const digits = Math.max(1, ...Array.from(section.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm), match => Math.max(String(Number(match[1]) + Number(match[2] ?? 1)).length, String(Number(match[3]) + Number(match[4] ?? 1)).length)));
    let old = 0, next = 0, inHunk = false;
    const output: string[] = [];
    for (const line of source) {
      if (line.startsWith('diff --git ')) { inHunk = false; continue; }
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; output.push(this.section(line, width)); continue; }
      if (!inHunk) {
        if (!/^(diff --git |index |--- |\+\+\+ )/.test(line) && line) output.push(...wrapTextWithAnsi(safeReviewText(line), width));
        continue;
      }
      if (!/^[ +\-]/.test(line)) { if (line) output.push(...wrapTextWithAnsi(safeReviewText(line), width)); continue; }
      const added = line.startsWith('+'), removed = line.startsWith('-');
      const gutter = `${added ? ' '.repeat(digits) : String(old++).padStart(digits)} ${removed ? ' '.repeat(digits) : String(next++).padStart(digits)}`;
      output.push(...this.codeLine(line, gutter, width, added ? 'success' : removed ? 'error' : 'text'));
    }
    return output;
  }
  private findingBadge(finding: Finding): string {
    return this.theme.bold(this.theme.fg(finding.kind === 'question' ? 'accent' : finding.severity === 'high' ? 'error' : finding.severity === 'medium' ? 'warning' : 'accent', `▌ ${finding.severity.toUpperCase()} · ${finding.kind}`));
  }
  private findingCard(finding: Finding, width: number): string[] {
    const rail = this.theme.fg('border', '│ ');
    return [this.findingBadge(finding), ...wrapTextWithAnsi(this.theme.bold(label(finding.title)), Math.max(1, Math.min(width, 72) - 2)).map(line => rail + line), ''];
  }
  private middle(text: string, width: number): string {
    text = label(text);
    if (visibleWidth(text) <= width) return text;
    const tail = Array.from(text); let suffix = '';
    while (tail.length && visibleWidth(suffix + tail.at(-1)!) <= Math.max(1, width - 4)) suffix = tail.pop()! + suffix;
    return truncateToWidth(text, Math.max(1, width - visibleWidth(suffix) - 1), '') + '…' + suffix;
  }
  private listRow(text: string, index: number, width: number): string[] {
    const selected = index === this.view.row;
    const prefix = selected ? '› ' : '  ';
    const lines = selected ? wrapTextWithAnsi(text, Math.max(1, width - 2)).slice(0, 3) : [truncateToWidth(text, width - 2, '…')];
    return lines.map((line, i) => (i ? '  ' : prefix) + (selected && this.focus === 'body' ? this.theme.fg('accent', line) : line));
  }
  private content(width: number): string[] {
    const prose = (text: string) => wrapTextWithAnsi(safeReviewText(text), Math.max(1, Math.min(width, 72)));
    const quiet = (text: string) => prose(text).map(line => this.theme.fg('dim', line));
    const markdown = (text: string, size = Math.min(width, 72)) => { this.markdown.setText(safeReviewText(text)); const lines = [...this.markdown.render(size)]; while (lines.length && !visibleWidth(lines[0]!)) lines.shift(); while (lines.length && !visibleWidth(lines.at(-1)!)) lines.pop(); return lines; };
    if (this.view.screen === 'discussion') return [...prose(`Your question · ${this.targetLabel(this.view.target)}`), ...(this.record.targetContexts?.[this.view.target] ? [this.section('ORIGINAL DISCUSSION CONTEXT', width), ...markdown(this.record.targetContexts[this.view.target]!.text), ''] : []),
      ...this.record.turns.filter(turn => turn.target === this.view.target).flatMap(turn => [this.section('YOU', width), ...prose(turn.question), this.section('BRO · ANSWER', width), ...markdown(turn.answer || (this.busy && turn === this.activeTurn ? 'Working…' : 'No answer received.')), ...(turn.error ? [this.theme.fg('warning', 'Request failed'), ...prose(turn.error)] : []), ...(turn.status !== 'complete' ? [this.busy && turn === this.activeTurn ? 'Answering…' : turn.status === 'failed' ? 'Failed · partial answer kept' : 'Stopped · partial answer kept'] : []), '']),
      ...(this.record.turns.some(turn => turn.target === this.view.target) ? [] : ['Ask a question below. Nothing is posted to GitHub.'])];
    if (this.view.screen === 'file') {
      if (!this.fileDiffs) {
        // Capture disables renames; type changes can have two adjacent sections with the same header.
        const sections: string[] = [];
        let previousHeader = '';
        for (const section of this.record.snapshot.diff.split(/(?=^diff --git )/m).filter(Boolean)) {
          if (!section.startsWith('diff --git ')) continue;
          const header = section.split('\n', 1)[0]!;
          if (header === previousHeader) sections[sections.length - 1] += section;
          else { sections.push(section); previousHeader = header; }
        }
        this.fileDiffs = new Map(sections.length === this.record.snapshot.files.length ? this.record.snapshot.files.map((file, index) => [file.path, sections[index]!]) : []);
      }
      const section = this.fileDiffs.get(this.view.file);
      return [this.section('CHANGES', width), ...prose(this.view.file), this.theme.fg('dim', 'old / new line numbers'), ...(section ? this.diffLines(section, width) : ['Diff inventory mismatch; captured changes cannot be mapped safely.'])];
    }
    if (this.view.screen === 'finding') {
      const finding = this.finding;
      if (!finding) return ['Finding no longer available in this guide.'];
      const block = (title: string, text: string, color = 'accent') => [this.theme.bold(this.theme.fg(color, title)), '', ...markdown(text, Math.max(1, Math.min(width, 64) - 2)).map(line => '  ' + line), ''];
      return [...wrapTextWithAnsi(`${this.findingBadge(finding)}  ${this.theme.bold(label(finding.title))}`, width), '',
        ...block('What happens', finding.scenario), ...block('Why it matters', finding.impact),
        ...block('Suggested fix', finding.fix, 'success'), ...block('How to check', finding.check, 'success'),
        ...block('Reasoning', finding.reasoning), ...(finding.uncertainty ? block('Uncertainty', finding.uncertainty) : quiet('Review note: source assessment only; not independently verified.')),
        '', ...(finding.evidence.length ? this.evidenceLines(finding.evidence, width) : quiet('No resolved source references cited.')), '',
        ...quiet('Suggestions are not applied or independently verified. Suggested checks have not been executed by this review.'),
        ...(!finding.evidence.some(ref => ref.valid) ? quiet('No resolved source evidence; treat this finding as unverified.') : [])];
    }
    if (this.view.selected === 'findings' || this.view.selected === 'across') return [this.section(this.view.scope ? `Findings · ${this.targetLabel(this.view.scope)}` : this.view.selected === 'across' ? 'ACROSS THE CHANGE' : 'FINDINGS TO EXAMINE', width, 'warning'), ...(this.findings.length ? this.findings.flatMap((finding, index) => this.listRow(`${this.findingBadge(finding)}  ${this.theme.bold(label(finding.title))}`, index, width)) : ['No issues reported in covered material. This is not approval.'])];
    if (this.view.selected === 'coverage') {
      const assessment = this.record.guide?.assessment;
      if (!assessment) return ['Quality assessment not performed.'];
      const cited = new Set(guideEvidence(this.record.guide).filter(ref => ref.valid).map(ref => ref.path));
      const list = (title: string, items: string[], empty: string) => [this.theme.bold(this.theme.fg('accent', title)), '', ...(items.length ? items.flatMap(item => wrapTextWithAnsi(safeReviewText(item), Math.max(1, Math.min(width, 64) - 2)).map((line, index) => (index ? '  ' : '• ') + line)) : quiet(empty)), ''];
      return [this.section('COVERAGE', width), '',
        ...prose(this.record.snapshot.diff.length > 100_000 ? 'Diff: first 100,000 characters supplied. Full captured diff remains available.' : 'Diff: complete captured diff supplied.'),
        ...quiet('Execution: no project tests independently verified.'), '',
        ...list('Inspected · model-reported', assessment.inspected, 'No inspected paths reported.'),
        ...list('Not checked · model-reported', assessment.notExamined, 'No gaps reported; this does not prove complete coverage.'),
        ...list('Changed files without citations', this.record.snapshot.files.filter(file => !cited.has(file.path)).map(file => file.path), 'All changed files have cited evidence.'),
        ...(assessment.warnings.length ? list('Assessment gaps', assessment.warnings, '') : []),
        this.theme.fg('dim', 'Reading these results'), '',
        ...quiet('Citations show source locations, not proof of full inspection or a finding’s conclusion.'), '',
        ...quiet('Automatic preparation is instructed not to execute repository code. This is not an enforced sandbox. The assessment is not independently verified.')];
    }
    if (this.topic) {
      const findings = this.record.guide?.assessment?.findings.filter(finding => finding.topicId === this.topic!.id) ?? [];
      return [...prose(this.topic.title).map(line => this.theme.bold(line)), '', this.section('EXPLANATION', width), ...markdown(this.topic.explanation), '', ...(findings.length ? [this.section('FINDINGS TO EXAMINE', width, 'warning'), '', ...findings.flatMap(finding => this.findingCard(finding, width)), ...quiet('View topic findings for evidence, fixes and checks.'), ''] : []), ...this.evidenceLines(this.topic.evidence, width)];
    }
    if (this.view.selected === 'files') return ['Changed files', ...this.record.snapshot.files.flatMap((file, index) => this.listRow(`${({ M: 'Modified', A: 'Added', D: 'Deleted', T: 'Type changed' } as Record<string,string>)[file.status] ?? file.status} · ${this.middle(file.path, Math.max(8, width - 14))}`, index, width))];
    if (this.view.selected === 'questions') return ['Your questions and drafts', ...(this.discussions.length ? this.discussions.flatMap((discussion, index) => this.listRow(`${discussion.draft ? 'Draft · ' : ''}${this.middle(this.targetLabel(discussion.target), Math.max(8, Math.floor(width / 2)))}: ${label(discussion.text)}`, index, width)) : ['No questions yet. Ask from the overview, a topic, finding or file.'])];
    if (this.view.selected === 'close') return [this.busy ? 'Stop and close' : 'Close', '', ...prose(this.busy ? `The active ${this.operation === 'answer' ? 'answer' : this.operation === 'regenerate' ? 'regeneration' : 'preparation'} will stop. Partial work, drafts and reading position will be saved privately.` : 'Your questions, drafts and reading position are saved privately. Nothing is posted to GitHub.'), '', 'Enter to close.'];
    return [this.section('PURPOSE OF THIS CHANGE', width), '', ...markdown(this.record.guide?.summary ?? (this.busy ? 'Bro is reading the captured changes. You can browse files while it works.' : 'No guide yet. Prepare it below, or inspect the changed files.')),
      ...(this.record.guide ? this.record.guide.assessment ? ['', this.section('FINDINGS TO EXAMINE', width, 'warning'), '', ...this.findings.slice(0, 3).flatMap(finding => this.findingCard(finding, width)), ...quiet(this.record.guide.assessment.warnings.length ? 'Assessment incomplete · See Coverage and limitations.' : this.findings.length ? `Open Findings for all ${this.findings.length} concerns, evidence, fixes and checks.` : 'No issues reported in covered material. This is not approval.'), '', this.section('QUALITY ASSESSMENT', width), '', ...markdown(this.record.guide.assessment.overview), '', ...quiet('Source assessment · execution not independently verified. See Coverage and limitations.')] : [...prose('Quality assessment not performed. Regenerate guide to assess this captured revision.')] : []),
      ...(!this.busy && this.record.guideAttempt ? ['', ...prose(this.record.guideAttempt.error ?? (this.record.guide ? 'Regeneration was interrupted. Your current guide is unchanged; choose Regenerate guide to retry.' : 'Preparation was interrupted. Choose Prepare guide to try again.'))] : []),
      '', ...quiet(`${this.record.snapshot.files.length} changed files · captured ${this.record.snapshot.target.head.slice(0, 8)}`)];
  }
  private evidenceLines(evidence: Evidence[], width: number): string[] {
    const prose = (text: string) => wrapTextWithAnsi(safeReviewText(text), Math.max(1, width));
    return evidence.flatMap(ref => {
      const key = `${ref.path}:${ref.side}:${ref.start}:${ref.end}`;
      const code = this.evidence.get(key), digits = String(ref.end).length;
      return [this.section('CAPTURED CODE', width), ...prose(`${ref.path} · ${ref.side} lines ${ref.start}–${ref.end}`), ...(!ref.valid ? ['Evidence unavailable — unresolved reference'] : this.evidenceErrors.has(key) ? prose(this.evidenceErrors.get(key)!) : code === undefined ? ['Loading captured code…'] : code.split('\n').flatMap((line, index) => this.codeLine(line, String(ref.start + index).padStart(digits), width)))];
    });
  }
  private runningStatus(narrow: boolean): string {
    const spinner = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'][Math.floor(Date.now() / 200) % 10];
    const elapsed = `${Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000))}s`;
    if (this.stage) {
      if (this.operation === 'answer') return `${spinner} ${this.stage.detail} · ${elapsed}`;
      const step = this.stage.step === 'check' ? 1 : this.stage.step === 'save' ? 2 : 0;
      const trail = [0, 1, 2].map(index => index < step ? '●' : index === step ? spinner : '○').join(' ');
      return narrow ? `${spinner} ${elapsed} · ${this.stage.detail}` : `${trail} ${this.operation === 'regenerate' ? '↻ Regenerating' : 'Preparing'} · ${this.stage.detail} · ${elapsed}`;
    }
    return `${spinner} ${this.operation === 'guide' ? 'Preparing review guide' : this.operation === 'regenerate' ? 'Regenerating guide' : 'Answering question'} · ${elapsed}`;
  }
  render(width: number): string[] {
    this.width = width;
    const height = Math.max(1, Math.min(36, this.tui.terminal.rows - 2));
    const inner = Math.max(1, width - 2);
    const fit = (text: string, size: number) => { const line = truncateToWidth(text, size, '…'); return line + ' '.repeat(Math.max(0, size - visibleWidth(line))); };
    const border = (left: string, right: string) => this.theme.fg('border', left + '─'.repeat(Math.max(0, width - 2)) + right);
    const row = (text: string) => this.theme.fg('border', '│') + fit(text, inner) + this.theme.fg('border', '│');
    this.tiny = width < 36 || height < 16;
    this.layout.height = height;
    if (this.tiny) return [border('╭', '╮'), row('Resize to at least 36×18'), row(this.busy ? 'Esc: stop and close' : 'Esc: close'), border('╰', '╯')].slice(0, height).map(line => truncateToWidth(line, width, ''));
    const narrow = width < 90;
    const navigationOnly = narrow && this.focus === 'contents';
    const leftWidth = narrow ? 0 : Math.min(38, Math.floor(inner * .32));
    const detailWidth = inner - leftWidth - (leftWidth ? 3 : 0);
    const detailRow = (text: string) => row((leftWidth ? ' '.repeat(leftWidth) + this.theme.fg('border', ' │ ') : '') + text);
    const composer = !navigationOnly && this.view.screen === 'discussion';
    const actions = navigationOnly ? [] : this.actions();
    this.action = Math.max(0, Math.min(this.action, actions.length - 1));
    const short: Record<string,string> = { 'Send question':'Send', 'Ask about this finding':'Ask', 'Ask about this file':'Ask', 'Ask about this review':'Ask', 'Ask a question':'Ask', 'Copy finding':'Copy', 'Back to files':'Back', 'View topic findings':'Topic findings', 'Edit and resend':'Edit and resend' };
    const buttons = actions.map((action, index) => {
      const focused = this.focus === 'actions' && index === this.action;
      const text = `${focused ? '›' : ''}[${narrow ? short[action] ?? action : action}]`;
      return focused ? this.theme.bold(this.theme.fg('accent', text)) : text;
    });
    const actionRows = !buttons.length ? [] : narrow ? wrapTextWithAnsi(buttons.join(' '), detailWidth) : buttons.map(button => '  ' + button);
    const availableRows = height - (narrow ? 7 : 8) - actionRows.length - (composer ? 1 : 0);
    const sticky = !navigationOnly && this.view.screen === 'finding' && this.finding && availableRows >= 4 && (this.view.offsets[this.key] ?? 0) > 0
      ? truncateToWidth(`${this.findingBadge(this.finding)}  ${this.theme.bold(label(this.finding.title))}`, detailWidth, '…') : undefined;
    const actionGap = actionRows.length && availableRows >= 8 ? 1 : 0;
    const bodyRows = availableRows - (sticky ? 1 : 0) - actionGap;
    const bodyStart = 4 + (sticky ? 1 : 0);
    if (this.isList) this.view.row = Math.max(0, Math.min(Math.max(0, this.listLength - 1), this.view.row));
    const body = [...(this.saveError ? [this.theme.fg('warning', 'Not saved · Retry saving'), ...wrapTextWithAnsi(label(this.saveError), detailWidth), ''] : []), ...(this.notice && this.notice !== 'Saved' && !this.busy ? [...wrapTextWithAnsi(label(this.notice), detailWidth).map(line => this.theme.fg('accent', line)), ''] : []), ...this.content(detailWidth)];
    this.maxOffset = Math.max(0, body.length - bodyRows);
    const listCursor = this.isList ? body.findIndex(line => line.startsWith('› ')) : 0;
    const offset = this.view.screen === 'discussion' && this.followAnswer ? this.maxOffset : this.isList && this.manualListKey !== this.key ? Math.max(0, Math.min(this.maxOffset, Math.max(0, listCursor) - bodyRows + 3)) : Math.min(this.maxOffset, this.view.offsets[this.key] ?? 0);
    this.view.offsets[this.key] = offset;
    const entries = this.entries();
    const selected = entries.findIndex(entry => entry.id === this.view.selected);
    const start = Math.max(0, Math.min(this.contentsOffset ?? selected - Math.floor(bodyRows / 2), Math.max(0, entries.length - bodyRows)));
    this.layout = { height, bodyRows, leftWidth, navigationOnly, contentsStart: start, bodyStart };
    const target = this.record.snapshot.target;
    const paneRule = (title: string, size: number, active: boolean) => this.theme.fg(active ? 'accent' : 'border', truncateToWidth(`─ ${title} ` + '─'.repeat(size), size, ''));
    const divider = leftWidth ? row(paneRule('Contents', leftWidth, this.focus === 'contents') + this.theme.fg('border', ' │ ') + paneRule(this.focus === 'input' ? 'Your draft' : this.focus === 'actions' ? 'Actions' : 'Reading', detailWidth, this.focus !== 'contents')) : border('├', '┤');
    const lines = [border('╭', '╮'), row(this.theme.fg('accent', label(`Bro · Review · ${target.repository} #${target.number}`))),
      row(this.theme.bold(this.theme.fg(this.busy ? 'accent' : this.saveError ? 'warning' : this.record.guideAttempt ? 'warning' : this.record.guide ? 'success' : 'muted', this.busy
        ? this.runningStatus(narrow)
        : this.saveError ? 'Review not saved · retry saving' : this.record.guide && this.record.guideAttempt ? `Regeneration ${this.record.guideAttempt.status === 'failed' ? 'failed' : 'stopped'} · current guide kept` : this.record.guide ? this.record.guide.assessment ? this.record.guide.assessment.warnings.length ? 'Review ready · assessment incomplete' : `✓ Review ready · ${this.record.guide.assessment.findings.length} findings` : `✓ Guide ready · ${this.record.guide.topics.length} topic${this.record.guide.topics.length === 1 ? '' : 's'}` : this.record.guideAttempt ? `Preparation ${this.record.guideAttempt.status === 'failed' ? 'failed' : 'stopped'} · Prepare guide to retry` : 'Captured changes ready'))), divider];
    for (let i = 0; i < bodyRows + (sticky ? 1 : 0); i++) {
      const entry = entries[start + i];
      let nav = entry ? `${entry.id === this.view.selected ? '›' : ' '} ${label(entry.title)}` : '';
      if (entry?.id === this.view.selected) nav = this.focus === 'contents' ? this.theme.bold(this.theme.fg('accent', nav)) : this.theme.fg('dim', nav);
      if (i === 0 && start > 0) nav = '▲ ' + nav.slice(2);
      if (i === bodyRows + (sticky ? 1 : 0) - 1 && start + i + 1 < entries.length) nav = '▼ ' + nav.slice(2);
      lines.push(row(navigationOnly ? nav : leftWidth ? fit(nav, leftWidth) + this.theme.fg('border', ' │ ') + fit(sticky && i === 0 ? sticky : body[offset + i - (sticky ? 1 : 0)] ?? '', detailWidth) : sticky && i === 0 ? sticky : body[offset + i - (sticky ? 1 : 0)] ?? ''));
    }
    if (actionGap) lines.push(detailRow(this.theme.fg('dim', '─'.repeat(detailWidth))));
    if (composer) {
      this.input.focused = this.focus === 'input' && this.focused;
      lines.push(detailRow(this.input.render(detailWidth)[0] ?? ''));
    }
    for (const action of actionRows) lines.push(detailRow(action));
    const exit = this.focus === 'contents' ? this.busy ? 'Esc stop/close' : 'Esc close' : 'Esc back';
    const primary = this.focus === 'contents' ? this.view.selected === 'close' ? 'Enter close' : 'Enter read' : this.focus === 'input' ? this.busy ? 'Typing draft' : 'Enter send' : this.focus === 'actions' ? 'Enter select' : this.view.selected === 'close' ? 'Enter close' : this.isList && this.listLength ? 'Enter open' : actions.length ? 'Enter actions' : '↑↓ read';
    const hint = `${exit} · ${primary} · Tab${narrow ? '' : this.focus === 'input' ? ' actions' : ' focus'}`;
    const more = navigationOnly ? start + bodyRows < entries.length : offset < this.maxOffset;
    const paused = this.busy && this.view.screen === 'discussion' && !this.followAnswer && this.activeTurn?.target === this.view.target && offset < this.maxOffset;
    const status = this.saveError ? 'Not saved · Retry saving' : paused ? 'New output below' : this.notice || `Private · ${target.head.slice(0,8)}`;
    lines.push(border('├', '┤'));
    if (!narrow) lines.push(row(`${this.focus === 'contents' ? 'Contents' : this.focus === 'body' ? 'Reading' : this.focus === 'input' ? 'Your draft' : 'Actions'} · ${label(status)}${more ? ' · ▼ more below' : ''}`));
    lines.push(row(hint + (narrow && more ? paused ? ' · ↓ new' : ' · ▼' : '')), border('╰', '╯'));
    return lines;
  }
  invalidate() { this.input.invalidate(); this.markdown.invalidate(); }
  dispose() {}
}
