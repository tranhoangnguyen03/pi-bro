import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE=path.resolve(HERE,'../assets/architecture-viewer.html');
export const sha=(text)=>crypto.createHash('sha256').update(text).digest('hex');

function nonempty(value,name,max=5000){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(name+' must be non-empty text');return value;}
export function safeRelative(value,name){
  if(typeof value!=='string'||!value||value.includes('\\')||path.posix.isAbsolute(value)||value.startsWith('/')||value.split('/').some(x=>x===''||x==='.'||x==='..')||/[\x00-\x1f?#]/.test(value)||/^[A-Za-z]:/.test(value)) throw new Error('Unsafe '+name+': '+String(value));
  return value;
}
export function validateGraph(g){
  if(!g||typeof g!=='object'||Array.isArray(g))throw new Error('Graph must be an object');
  if(!g.project||typeof g.project!=='object')throw new Error('Graph needs project');
  nonempty(g.project.name,'project.name',200);nonempty(g.project.summary,'project.summary',2000);
  if(g.project.revision!==undefined)nonempty(g.project.revision,'project.revision',500);
  if(!Array.isArray(g.nodes)||!g.nodes.length||g.nodes.length>250)throw new Error('Graph needs 1–250 nodes');
  if(!Array.isArray(g.edges)||g.edges.length>1500)throw new Error('Invalid graph edges');
  if(g.flows!==undefined&&!Array.isArray(g.flows))throw new Error('Invalid flows');
  const ids=new Set();
  for(const n of g.nodes){
    if(!n||typeof n!=='object'||typeof n.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(n.id)||ids.has(n.id))throw new Error('Invalid/duplicate node id');
    ids.add(n.id);nonempty(n.label,'node.label',120);nonempty(n.description,'node.description',2000);
    if(n.kind!==undefined)nonempty(n.kind,'node.kind',80);
    if(n.sources!==undefined){if(!Array.isArray(n.sources)||n.sources.length>30)throw new Error('Invalid node sources');for(const p of n.sources)safeRelative(p,'source');}
    if(n.doc!==undefined)safeRelative(n.doc,'doc');
  }
  for(const e of g.edges){if(!e||!ids.has(e.from)||!ids.has(e.to))throw new Error('Edge references a missing node');nonempty(e.label,'edge.label',250);}
  const flowIDs=new Set();for(const f of g.flows||[]){if(!f||typeof f.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(f.id)||flowIDs.has(f.id))throw new Error('Invalid/duplicate flow id');flowIDs.add(f.id);nonempty(f.label,'flow.label',150);if(!Array.isArray(f.steps)||!f.steps.length||f.steps.some(id=>!ids.has(id)))throw new Error('Flow references a missing node');}
  return g;
}
const escapeHTML=(s)=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function renderGraph(raw,graph){
  validateGraph(graph);
  const template=fs.readFileSync(TEMPLATE,'utf8');
  const fallback='<ul>'+graph.nodes.map(n=>'<li><strong>'+escapeHTML(n.label)+'</strong> — '+escapeHTML(n.description)+'</li>').join('')+'</ul>';
  const json=JSON.stringify(graph).replaceAll('<','\\u003c').replaceAll('>','\\u003e').replaceAll('&','\\u0026');
  const values={
    '__TITLE__':escapeHTML(graph.project.name),
    '__SUMMARY__':escapeHTML(graph.project.summary),
    '__REVISION__':escapeHTML(graph.project.revision||'repository snapshot'),
    '__SHA__':sha(raw),
    '__DATA__':json,
    '__NOSCRIPT__':fallback
  };
  return template.replace(/__TITLE__|__SUMMARY__|__REVISION__|__SHA__|__DATA__|__NOSCRIPT__/g,m=>values[m]);
}
export function render(root,checkOnly=false){
  const docs=path.join(root,'docs','architecture');
  const raw=fs.readFileSync(path.join(docs,'architecture.graph.json'),'utf8');
  const graph=validateGraph(JSON.parse(raw));
  const html=renderGraph(raw,graph);
  const file=path.join(docs,'architecture.html');
  if(checkOnly){
    if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==html)throw new Error('architecture.html is missing or stale; re-render the graph');
  } else fs.writeFileSync(file,html);
  return {graph,html,file};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const root=path.resolve(process.argv[2]||'.');const result=render(root,process.argv.includes('--check'));console.log((process.argv.includes('--check')?'Checked ':'Rendered ')+path.relative(root,result.file));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
