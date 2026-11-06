import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, safeRelative } from './render.mjs';
import { localPath } from './inventory.mjs';

// Match the repository checker’s backtick/tilde fence handling, plus inline
// code spans. Mermaid is its own language and must not be parsed as Markdown.
export function markdownLinks(text) {
  let fence = '', width = 0;
  const prose = [];
  for (const line of text.split(/\r?\n/)) {
    const token = /^\s*(`{3,}|~{3,})/.exec(line);
    if (token) {
      if (!fence) { fence = token[1][0]; width = token[1].length; }
      else if (token[1][0] === fence && token[1].length >= width) fence = '';
      prose.push('');
    } else prose.push(fence || /^( {4}|\t)/.test(line) ? '' : line);
  }
  const source = prose.join('\n').replace(/(`+)(?!`)[\s\S]*?\1(?!`)/g, '');
  return [...source.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/g)]
    .map(m => m[1].replace(/^<|>$/g, ''));
}

/** Validate the files that would exist after import, not just the model's view.
 * Omitted assets resolve against the original repo; staging helpers never do.
 * knownFiles is optional for the standalone CLI; the pipeline supplies it.
 */
export function check(root, { repositoryRoot = root, knownFiles } = {}) {
  root = path.resolve(root);
  repositoryRoot = path.resolve(repositoryRoot);
  const docs = localPath(root, 'docs/architecture'), errors = [];
  const known = knownFiles ? new Set(knownFiles) : undefined;
  const knownTarget = relative => !known || known.has(relative) || [...known].some(p => p.startsWith(relative + '/'));
  const targetExists = relative => {
    if (relative === '.bro-architecture-support' || relative.startsWith('.bro-architecture-support/')) {
      throw new Error('Reference to temporary architecture support: ' + relative);
    }
    safeRelative(relative, 'reference');
    // Only proposed documentation may resolve against the staged tree. Source
    // references and untouched/omitted assets must also exist in the real repo.
    if (relative.startsWith('docs/architecture/') && fs.existsSync(localPath(root, relative))) return true;
    return knownTarget(relative) && fs.existsSync(localPath(repositoryRoot, relative));
  };
  let result;
  try { result = render(root, true); } catch (error) { errors.push(error.message); }
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name), relative = path.relative(root, name).split(path.sep).join('/');
      if (entry.isSymbolicLink()) { errors.push('Symlink inside architecture docs: ' + relative); continue; }
      if (entry.isDirectory()) walk(name);
      else if (entry.name.endsWith('.md')) {
        for (const link of markdownLinks(fs.readFileSync(name, 'utf8'))) {
          if (!link || link.startsWith('#') || /^(https?:|mailto:|data:)/i.test(link)) continue;
          try {
            const target = decodeURIComponent(link.split('#')[0]);
            if (path.isAbsolute(target) || target.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(target)) throw new Error('Unsafe local link: ' + link);
            const resolved = path.relative(root, path.resolve(path.dirname(name), target)).split(path.sep).join('/');
            if (!targetExists(resolved)) throw new Error('Broken link: ' + link);
          } catch (error) {
            errors.push((error instanceof URIError ? 'Invalid URL: ' + link : error.message) + ' in ' + relative);
          }
        }
      }
    }
  };
  if (!fs.existsSync(path.join(docs, 'README.md'))) errors.push('Missing docs/architecture/README.md');
  if (fs.existsSync(docs)) walk(docs); else errors.push('Missing docs/architecture/');
  if (result) {
    for (const node of result.graph.nodes) {
      for (const src of node.sources || []) {
        try { if (!targetExists(src)) errors.push('Missing graph source: ' + src); } catch (error) { errors.push(error.message); }
      }
      if (node.doc) {
        try { if (!targetExists('docs/architecture/' + safeRelative(node.doc, 'doc'))) errors.push('Missing graph guide: ' + node.doc); }
        catch (error) { errors.push(error.message); }
      }
    }
    if (!result.html.includes('id="graph-data"') || result.html.includes('src="https://') || result.html.includes('href="https://')) errors.push('HTML viewer is not self-contained');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { nodes: result.graph.nodes.length, edges: result.graph.edges.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const out = check(path.resolve(process.argv[2] || '.')); console.log('Architecture docs OK · ' + out.nodes + ' nodes · ' + out.edges + ' edges'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
