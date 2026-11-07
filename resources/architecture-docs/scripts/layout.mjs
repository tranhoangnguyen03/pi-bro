/** Pure layout: condense strongly connected components, then rank the DAG.
 * A cycle shares a column; its downstream nodes do not get trapped there.
 */
export function layoutGraph(nodes, edges) {
  const successors = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) successors.get(e.from).push(e.to);
  const indices = new Map(), low = new Map(), stack = [], active = new Set(), groups = [], groupOf = new Map();
  let next = 0;
  function visit(id) {
    indices.set(id, next); low.set(id, next++); stack.push(id); active.add(id);
    for (const other of successors.get(id)) {
      if (!indices.has(other)) { visit(other); low.set(id, Math.min(low.get(id), low.get(other))); }
      else if (active.has(other)) low.set(id, Math.min(low.get(id), indices.get(other)));
    }
    if (low.get(id) === indices.get(id)) {
      const group = []; let member;
      do { member = stack.pop(); active.delete(member); groupOf.set(member, groups.length); group.push(member); } while (member !== id);
      groups.push(group);
    }
  }
  for (const n of nodes) if (!indices.has(n.id)) visit(n.id);
  const dag = groups.map(() => new Set()), degree = groups.map(() => 0), rank = groups.map(() => 0);
  for (const e of edges) {
    const from = groupOf.get(e.from), to = groupOf.get(e.to);
    if (from !== to && !dag[from].has(to)) { dag[from].add(to); degree[to]++; }
  }
  const queue = groups.map((_, i) => i).filter(i => !degree[i]);
  for (let i = 0; i < queue.length; i++) {
    for (const to of dag[queue[i]]) {
      rank[to] = Math.max(rank[to], rank[queue[i]] + 1);
      if (--degree[to] === 0) queue.push(to);
    }
  }
  const levels = [...new Set(rank)].sort((a, b) => a - b);
  const column = new Map(nodes.map(n => [n.id, levels.indexOf(rank[groupOf.get(n.id)])]));
  const columns = levels.map(() => []);
  for (const n of nodes) columns[column.get(n.id)].push(n);
  for (const list of columns) list.sort((a, b) => a.label.localeCompare(b.label));
  const W = 224, H = 80, DY = 144, P = 52;
  const lanes = levels.map(() => 0);
  for (const e of edges) if (column.get(e.from) === column.get(e.to)) lanes[column.get(e.from)]++;
  const positions = new Map(); let x = P;
  columns.forEach((list, col) => {
    list.forEach((n, row) => positions.set(n.id, { x, y: P + row * DY, column: col }));
    x += W + Math.max(100, 60 + lanes[col] * 24);
  });
  const used = levels.map(() => 0);
  const routes = edges.map(e => {
    const a = positions.get(e.from), b = positions.get(e.to);
    if (a.column === b.column) {
      // Enter and leave on the right. Separate lanes keep feedback arrows and
      // their rotated labels out of component boxes and out of the next column.
      const right = a.x + W, lane = right + 36 + 24 * used[a.column]++;
      const y = a.y + 24, y2 = b.y + 56;
      return { d: `M${right} ${y} H${lane} V${y2} H${right}`, labelX: lane - 5, labelY: (y + y2) / 2, rotation: -90 };
    }
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mid = Math.max(25, (x2 - x1) * .4);
    return { d: `M${x1} ${y1} C${x1 + mid} ${y1},${x2 - mid} ${y2},${x2} ${y2}`, labelX: (x1 + x2) / 2, labelY: (y1 + y2) / 2 - 8, rotation: 0 };
  });
  return { nodeWidth: W, nodeHeight: H, width: x + P, height: P * 2 + Math.max(1, ...columns.map(c => c.length)) * DY, positions: Object.fromEntries(positions), routes };
}
