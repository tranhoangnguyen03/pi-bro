import assert from 'node:assert/strict';
import test from 'node:test';
import { readerCounts } from './reader-counts.ts';
test('counts source-visible syntax and includes list words', () => {
 const c = readerCounts('# Heading\n- **First** item.\n2. Next — item!');
 assert.equal(c.words, 9);
 assert.equal(c.headers, 1); assert.equal(c.bulletLines, 2);
 assert.equal(c.boldSpans, 1); assert.equal(c.emDashes, 1);
 assert.ok(c.sentences >= 2);
 assert.equal(readerCounts('').words, 0);
});
