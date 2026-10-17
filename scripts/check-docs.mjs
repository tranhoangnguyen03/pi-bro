#!/usr/bin/env node
/** Offline docs checks. No model, network or npm package is needed. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const githubSlug = (heading) => heading
 .replace(/<[^>]*>/g, '').replace(/[`*_~]/g, '').toLowerCase()
 .replace(/[^\p{L}\p{N} -]/gu,'').trim().replace(/\s+/g,'-');

export function markdownIndex(content) {
 const slugs=new Map();const links=[];let fence='',min=0;let h1Count=0;
 for(const line of content.split(/\r?\n/)) {
  const token=/^\s*(`{3,}|~{3,})/.exec(line);
  if(token){const ch=token[1][0];if(!fence){fence=ch;min=token[1].length;}else if(fence===ch&&token[1].length>=min)fence='';continue;}
  if(fence)continue;
  const heading=/^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
  if(heading){if(/^#\s/.test(line))h1Count++;let name=githubSlug(heading[1]);const count=slugs.get(name)??0;slugs.set(name,count+1);if(count)slugs.set(name+'-'+count,1);}
  // Ordinary Markdown links and images; skip external schemes at resolution time.
  for(const m of line.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g))links.push(m[1].replace(/^<|>$/g,''));
  // Raw HTML imagery is used in pi-bro's README hero.
  for(const m of line.matchAll(/\b(?:src|href)=["']([^"']+)["']/g))links.push(m[1]);
 }
 return {slugs:new Set(slugs.keys()),links,h1Count};
}

export async function checkDocs(root) {
 const errs=[],seen=[];
 const docs=['README.md','CONTRIBUTING.md','SECURITY.md','docs/README.md','docs/getting-started.md','docs/user-guide.md','docs/guided-review.md','docs/elevate.md','docs/pig-compatibility.md','docs/DEVELOPMENT.md','docs/TESTING.md','docs/examples.md'];
 for (const directory of ['docs/features','docs/reference']) {
  for(const name of await readdir(join(root,directory)))if(name.endsWith('.md'))docs.push(directory+'/'+name);
 }
 const parsed=new Map();
 for(const file of docs){const text=await readFile(join(root,file),'utf8'); const index=markdownIndex(text); parsed.set(file,index); seen.push(file); if(index.h1Count!==1)errs.push(`${file}: expected exactly one top-level # heading; got ${index.h1Count}`);}
 for(const [file,{links}] of parsed){
  for(const link of links){
   if(link.startsWith('//')||/^[a-z][a-z0-9+.-]*:/i.test(link))continue;
   const [raw,hash]=link.split('#'); if(!raw&&!hash)continue;
   let target=file;
   if(raw){if(raw.startsWith('/')){errs.push(`${file}: root-absolute local link ${link}`);continue;}
    target=relative(root,resolve(root,dirname(file),decodeURIComponent(raw))).split(sep).join('/');
    if(target==='..'||target.startsWith('../')){errs.push(`${file}: link leaves the repository ${link}`);continue;}
   }
   let exists=false;
   try{await stat(join(root,target));exists=true;}catch{};
   if(!exists){errs.push(`${file}: missing target ${link}`);continue;}
   if(hash && target.endsWith('.md')){
    const idx=parsed.get(target)??markdownIndex(await readFile(join(root,target),'utf8'));
    if(!idx.slugs.has(decodeURIComponent(hash).toLowerCase()))errs.push(`${file}: missing anchor ${link}`);
   }
  }
 }
 const bro=await readFile(join(root,'src/bro.ts'),'utf8');
 const commandChunk=bro.split('const COMMANDS = [')[1]?.split('];')[0];
 if(!commandChunk)errs.push('src/bro.ts: no COMMANDS list found');
 else{
  const values=[...commandChunk.matchAll(/\bvalue:\s*"([a-z][a-z-]*)"/g)].map(m=>m[1]);
  const reference=await readFile(join(root,'docs/reference/commands.md'),'utf8');
  for(const cmd of values)if(!new RegExp('\\/bro\\s+'+cmd+'\\b').test(reference))errs.push(`docs/reference/commands.md: undocumented registered subcommand /bro ${cmd}`);
 }
 const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 for(const file of ['docs/README.md','docs/getting-started.md','docs/user-guide.md','docs/guided-review.md','docs/elevate.md','docs/examples.md','docs/features','docs/reference'])if(!pkg.files?.includes(file))errs.push(`package.json: user docs missing from npm files list: ${file}`);
 const readme=await readFile(join(root,'README.md'),'utf8');
 if(!readme.includes('/bro text A request limit means'))errs.push('README.md: expected a fully runnable first-use example');
 if(readme.includes('/bro file docs/report.pdf'))errs.push('README.md: unmarked placeholder in first-use commands');
 const privacy=await readFile(join(root,'docs/reference/data-and-permissions.md'),'utf8');
 if(!privacy.includes('prompt instruction')&&!privacy.includes('prompt instructions'))errs.push('Access reference needs a warning that prompts are not enforced limits');
 return {checked:seen.length,errors:errs};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=resolve(process.argv[2]??process.cwd());
 try{const r=await checkDocs(root);if(r.errors.length){console.error(r.errors.join('\n'));process.exitCode=1;}else console.log(`Docs OK: checked ${r.checked} Markdown pages, local links/anchors, and registered commands.`);}catch(e){console.error(e);process.exitCode=1;}
}
