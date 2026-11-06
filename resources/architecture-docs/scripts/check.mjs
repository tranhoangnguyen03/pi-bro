import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, safeRelative } from './render.mjs';

export function check(root){
  const docs=path.join(root,'docs','architecture'),errors=[];
  let result;
  try{result=render(root,true);}catch(e){errors.push(e.message);}
  const walk=(dir)=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const name=path.join(dir,entry.name);
      if(entry.isSymbolicLink()){errors.push('Symlink inside architecture docs: '+path.relative(root,name));continue;}
      if(entry.isDirectory())walk(name);
      else if(entry.name.endsWith('.md')||entry.name.endsWith('.mmd')){
        const text=fs.readFileSync(name,'utf8');
        const re=/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
        for(const match of text.matchAll(re)){
          let target=match[1].split('#')[0];
          if(!target||/^(https?:|mailto:|data:)/i.test(target))continue;
          try{target=decodeURIComponent(target);}catch{errors.push('Invalid URL in '+name);continue;}
          const abs=path.resolve(path.dirname(name),target);
          if(!abs.startsWith(path.resolve(root)+path.sep)){errors.push('Link escapes repo: '+target+' in '+path.relative(root,name));continue;}
          if(!fs.existsSync(abs))errors.push('Broken link: '+target+' in '+path.relative(root,name));
        }
      }
    }
  };
  if(!fs.existsSync(path.join(docs,'README.md')))errors.push('Missing docs/architecture/README.md');
  if(fs.existsSync(docs))walk(docs);else errors.push('Missing docs/architecture/');
  if(result){
    for(const node of result.graph.nodes){
      for(const src of node.sources||[]){
        try{safeRelative(src,'source');if(!fs.existsSync(path.join(root,src)))errors.push('Missing graph source: '+src);}catch(e){errors.push(e.message);}
      }
      if(node.doc&&!fs.existsSync(path.join(docs,node.doc)))errors.push('Missing graph guide: '+node.doc);
    }
    if(!result.html.includes('id="graph-data"')||result.html.includes('src="https://')||result.html.includes('href="https://'))errors.push('HTML viewer is not self-contained');
  }
  if(errors.length)throw new Error(errors.join('\n'));
  return {nodes:result.graph.nodes.length,edges:result.graph.edges.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const root=path.resolve(process.argv[2]||'.');const out=check(root);console.log('Architecture docs OK · '+out.nodes+' nodes · '+out.edges+' edges');}
  catch(e){console.error(e.message);process.exitCode=1;}
}
