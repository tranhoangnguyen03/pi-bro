import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubSlug, markdownIndex, checkDocs } from '../scripts/check-docs.mjs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

test('GitHub-style headings and repeated heading anchors',()=>{
 assert.equal(githubSlug('Backends: access and retention'),'backends-access-and-retention');
 const t=markdownIndex('## Before\n## Before\n### A `code` heading\n');
 assert.ok(t.slugs.has('before'));
 assert.ok(t.slugs.has('before-1'));
 assert.ok(t.slugs.has('a-code-heading'));
});
test('markdown parsing skips commands in code fences, preserves local links and HTML assets',()=>{
 const t=markdownIndex('See [guide](docs/guide.md#intro)\n```md\n[missing](secret.md)\n# Ignore me\n```\n<img src="images/demo.png">');
 assert.deepEqual(t.links,['docs/guide.md#intro','images/demo.png']);
 assert.ok(!t.slugs.has('ignore-me'));
});
test('site scan reports missing pages and anchors without a network call',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bro-docs-quality-'));
 const write=async(path,text)=>{await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),text);};
 try{
  for(const name of ['CONTRIBUTING.md','SECURITY.md','docs/user-guide.md'])await write(name,'# Hello\n');
  await write('package.json',JSON.stringify({files:['docs/README.md','docs/getting-started.md','docs/user-guide.md','docs/feature-map.md','docs/examples.md','docs/features','docs/reference']}));
  await write('docs/features/new/guide.md','# Guide\n[broken](missing.md)\n');
  await write('docs/plans/old.md','No heading. [broken](ignored.md)\n');
  await write('src/bro.ts','const COMMANDS = [{ value: "btw" }];');
  await write('docs/reference/commands.md','# Command reference\n/bro btw\n');
  await write('docs/reference/data-and-permissions.md','# Access\nA prompt instruction is not enforced.\n');
  await write('README.md','# Start\n/bro simplify text A request limit means\n[broken](docs/missing.md)\n[bad anchor](docs/user-guide.md#not-there)\n');
  const r=await checkDocs(root);
  assert.equal(r.errors.length,3);
  assert.ok(r.errors.some(error=>error.startsWith('docs/features/new/guide.md:')));
 }finally{await rm(root,{recursive:true,force:true});}
});
