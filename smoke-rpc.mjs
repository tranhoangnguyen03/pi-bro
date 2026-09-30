// Offline smoke driver: requests and local mutations share one acknowledgement queue.
import { spawn } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const child = spawn(process.env.BRO_SMOKE_PI_BIN, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] });
const queue = [];
let active, ended = false, timer;
function next() {
  if (active !== undefined) return;
  while (queue.length) {
    const line = queue.shift();
    const request = JSON.parse(line);
    if (request.type === 'smoke-write') {
      writeFileSync(request.path, request.text);
      continue;
    }
    if (request.type === 'smoke-copy') {
      copyFileSync(request.from, request.to);
      continue;
    }
    active = request.id;
    child.stdin.write(line + '\n');
    timer = setTimeout(() => { console.error('RPC smoke request timed out:', active); child.kill('SIGKILL'); process.exitCode = 1; }, 30000);
    return;
  }
  if (ended) child.stdin.end();
}
const input = createInterface({ input: process.stdin });
input.on('line', line => { if (line.trim()) queue.push(line); next(); });
input.on('close', () => { ended = true; next(); });
createInterface({ input: child.stdout }).on('line', line => {
  console.log(line);
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'response' && event.id === active) {
    clearTimeout(timer); active = undefined; next();
  }
});
child.stdin.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', code => {
  clearTimeout(timer);
  if (active !== undefined || queue.length) process.exitCode = 1;
  else process.exitCode ||= code ?? 1;
  input.close(); process.stdin.destroy();
});
