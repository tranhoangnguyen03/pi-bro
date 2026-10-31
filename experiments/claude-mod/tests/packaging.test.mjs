import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, existsSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
const root=join(dirname(fileURLToPath(import.meta.url)),"../../..");
const plugin=join(root,"experiments/claude-mod");
const json=path=>JSON.parse(readFileSync(path,"utf8"));
test("GitHub marketplace identifies a complete bundled Claude Mod",()=>{
  const marketplace=json(join(root,".claude-plugin/marketplace.json"));
  const entry=marketplace.plugins.find(p=>p.name==="bro-simplify-experimental");
  assert.ok(entry);
  assert.equal(entry.source,"./experiments/claude-mod");
  const manifest=json(join(plugin,".claude-plugin/plugin.json"));
  assert.equal(manifest.name,entry.name);
  assert.equal(manifest.version,entry.version);
  const hooks=json(join(plugin,"hooks/hooks.json"));
  for(const module of hooks.modules)assert.ok(existsSync(join(plugin,"hooks",module)),"missing hook module "+module);
  assert.ok(existsSync(join(plugin,"runner/execute.mjs")));
  assert.ok(existsSync(join(plugin,"hooks/settings.js")));
});
test("Node runner lives within package and imports no parent repo modules",()=>{
  const text=readFileSync(join(plugin,"runner/execute.mjs"),"utf8");
  assert.doesNotMatch(text,/from\s+["']\.\.\/\.\./);
});
