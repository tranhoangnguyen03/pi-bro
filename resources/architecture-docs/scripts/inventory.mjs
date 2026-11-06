import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

const EXCLUDE = new Set(['.git', 'node_modules', '.venv', 'venv', '.next', 'dist', 'build', 'coverage', '.cache', '__pycache__', '.turbo']);
const SECRET = /(^|\/)(\.env(?:\..*)?|\.?credentials(?:\..*)?|auth\.json|id_rsa|id_ed25519|.*\.pem|.*\.key)$/i;

export function listProjectFiles(root) {
  let candidates;
  try {
    const data = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    candidates = data.split('\0').filter(Boolean);
  } catch {
    candidates = [];
    const visit = (dir, prefix = '') => {
      for (const dirent of readdirSync(dir, { withFileTypes: true })) {
        if (EXCLUDE.has(dirent.name) || (prefix === '' && dirent.name === '.git')) continue;
        const rel = prefix ? prefix + '/' + dirent.name : dirent.name;
        if (dirent.isDirectory()) visit(path.join(dir, dirent.name), rel);
        else if (dirent.isFile()) candidates.push(rel);
      }
    };
    visit(root);
  }
  const unique = [...new Set(candidates)].sort();
  return unique.filter(p => {
    const rel = p.replaceAll('\\', '/');
    if (path.isAbsolute(rel) || rel.split('/').includes('..') || rel.split('/').some(x => EXCLUDE.has(x)) || SECRET.test(rel)) return false;
    try { return lstatSync(path.join(root, p)).isFile(); } catch { return false; }
  });
}

export function inventory(root, files = listProjectFiles(root)) {
  const count = {};
  const top = {};
  for (const file of files) {
    const ext = path.extname(file).toLowerCase() || '(none)';
    count[ext] = (count[ext] || 0) + 1;
    const folder = file.split('/')[0];
    top[folder] = (top[folder] || 0) + 1;
  }
  const meaningful = /(readme|package\.json|pyproject\.toml|go\.mod|cargo\.toml|dockerfile|compose|dbt_project\.yml|schema\.yml|workflow|dag|app\.py|main\.[a-z]+|src\/bro\.ts|agents\.md)/i;
  return {
    files: files.length,
    byExtension: Object.fromEntries(Object.entries(count).sort((a,b) => b[1]-a[1]).slice(0,20)),
    topLevel: Object.fromEntries(Object.entries(top).sort((a,b) => b[1]-a[1]).slice(0,25)),
    landmarks: files.filter(f => meaningful.test(f)).slice(0,120),
    existingArchitectureDocs: files.filter(f => f.startsWith('docs/architecture/')).slice(0,150)
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const root = path.resolve(process.argv[2] || '.');
  console.log(JSON.stringify(inventory(root), null, 2));
}
