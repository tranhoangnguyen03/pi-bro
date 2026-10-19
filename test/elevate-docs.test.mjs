import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const file = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('Elevate appears in README, reference guide, built-in help, and docs index', async () => {
  const [readme, guide, help, index] = await Promise.all([
    file('README.md'), file('docs/reference/commands.md'), file('src/explain-modal.ts'), file('docs/README.md'),
  ]);
  assert.match(readme, /\[Elevate\]\(docs\/elevate\.md\)/);
  assert.match(guide, /\/bro elevate \[request\]/);
  assert.match(index, /\[Improve a request before sending it\]/);
  assert.match(index, /\[Improve a request before sending it\]\(elevate\.md\)/);
  assert.match(help, /## Elevate/);
});

test('Elevate guide explains the goal, example, actions, editor replacement, and access limits', async () => {
  const guide = await file('docs/elevate.md');
  for (const phrase of [
    '## Start here', '## The two questions Elevate asks', '## Example: before and after',
    '## Controls in the modal', 'What happens to the original editor draft?',
    '## What Elevate can and cannot do', '## Troubleshooting',
    'Grok', '**Messages (default):**', '**Full:**', '**no fixed history cap**', '**not**',
  ]) assert.ok(guide.includes(phrase), `Missing ${JSON.stringify(phrase)} in Elevate guide`);
});

test('Developer and manual test guides cover Elevate', async () => {
  const [dev, testing] = await Promise.all([file('docs/DEVELOPMENT.md'), file('docs/TESTING.md')]);
  assert.match(dev, /## Elevate architecture and invariants/);
  assert.match(dev, /elevate-engine\.ts/);
  assert.match(dev, /elevate\.ts/);
  assert.match(testing, /## Elevate/);
  assert.match(testing, /Ctrl\+Shift\+E/);
});

// The controls are buttons now, so a stale instruction here would send a user hunting for a key that
// no longer exists. Documented button labels are checked against the ones the modal actually builds,
// so a renamed or missing button fails here instead of shipping.
test('Elevate controls are documented as buttons, not retired bare keys', async () => {
  const [guide, testing, help, readme, source] = await Promise.all([
    file('docs/elevate.md'), file('docs/TESTING.md'), file('src/explain-modal.ts'), file('README.md'), file('src/elevate.ts'),
  ]);
  for (const phrase of [
    '## Controls in the modal', '[Rewrite with N selected]', '[Insert into editor]',
    'Nothing is selected at first', 'the highlighted',
  ]) assert.ok(guide.includes(phrase), `Missing ${JSON.stringify(phrase)} in the Elevate guide`);
  // Space and Enter both toggle, and Tab is the way to the buttons. A stale rule here would tell the
  // user to press Enter to leave the list, which no longer does that.
  assert.match(guide, /`Space` or `Enter` \| Tick or untick/);
  assert.match(guide, /`Tab` \| Move focus to the buttons/);
  assert.doesNotMatch(guide, /`Enter` \| Move focus to the buttons/);

  // Every button the guide tells the user to press must exist as a real button in the modal source,
  // so renaming or dropping one fails here instead of shipping a dead instruction.
  const built = [...source.matchAll(/label: (?:"([^"]+)"|`([^`]+)`)/g)].map((m) => (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, "N"));
  const documented = [...guide.matchAll(/\[([A-Z][^\]\n]{2,30})\]/g)].map((m) => m[1]).filter((label) => !/\.md|docs/.test(label));
  for (const label of documented) {
    const stem = label.replace(/ with N selected/, "").replace(/N selected/, "").trim();
    assert.ok(built.some((real) => real.startsWith(stem)), `the guide documents [${label}] but the modal builds no such button`);
  }
  // `[Back]` is documented, so it must be a real button, not a promise without an implementation.
  assert.match(source, /label: "Back"/, 'the guide documents [Back] but the modal has no Back button');

  // Retired instructions must not survive in shipped documentation or the built-in help.
  for (const [name, text] of [['guide', guide], ['testing', testing], ['help', help], ['README', readme]]) {
    for (const stale of [/`1`–`5`/, /`a` \/ `n`/, /\*\*All findings start selected\*\*/, /1–5 toggles/, /a all, n none/, /Press `i`/, /Press `r` to retry/, /\bi inserts\b/, /\bb revisits\b/, /single-line request field/, /press Enter, or pass it/]) {
      assert.doesNotMatch(text, stale, `${name} still documents the retired control ${stale}`);
    }
  }
});
