'use strict';
// Pure ordering logic: units, re-binding, desired order, learning from drags.
const { normPath } = require('./paths');

const NONE_ID = '__none';
const NONE_LABEL = '━━ NO CATEGORY ━━';
const HEADER_RE = /^━━ .+ ━━$/;
const DEAD_MS = 30 * 24 * 3600 * 1000;

function headerLabel(name) { return `━━ ${String(name).trim().toUpperCase()} ━━`; }
function isHeaderLabel(label) { return HEADER_RE.test(String(label || '')); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

// A unit is what moves as one block in the sidebar: a worktree group (herdr
// draws all members of one repo at the first member's position when the repo
// has a non-linked member and at least two members) or a single workspace.
// opts.flat: herdr lists worktree copies on lines of their own
// ([ui.sidebar.spaces] group_worktrees = false), so there are no groups.
function buildUnits(workspaces, paths, headerIds, opts = {}) {
  const live = workspaces.filter(w => !headerIds.has(w.workspace_id));
  const byRepo = new Map();
  for (const w of live) {
    if (!w.worktree || !w.worktree.repo_key) continue;
    const k = normPath(w.worktree.repo_key);
    if (!byRepo.has(k)) byRepo.set(k, []);
    byRepo.get(k).push(w);
  }
  const grouped = new Map();
  for (const [k, members] of byRepo) {
    if (!opts.flat && members.length >= 2 && members.some(m => !m.worktree.is_linked_worktree)) grouped.set(k, members);
  }
  const units = [];
  const unitOf = {};
  const byKey = {};
  for (const w of live) {
    const id = w.workspace_id;
    if (unitOf[id]) continue;
    const rk = w.worktree && w.worktree.repo_key ? normPath(w.worktree.repo_key) : null;
    let unit;
    if (rk && grouped.has(rk)) {
      const members = grouped.get(rk);
      const parents = members.filter(m => !m.worktree.is_linked_worktree);
      const kids = members.filter(m => m.worktree.is_linked_worktree);
      const anchor = parents[0];
      unit = {
        key: `repo:${rk}`, kind: 'group', repoKey: rk,
        wsIds: [...parents, ...kids].map(m => m.workspace_id),
        anchorId: anchor.workspace_id, label: anchor.label,
        path: normPath(anchor.worktree.repo_root || anchor.worktree.checkout_path),
        linked: false,
        children: kids.map(m => ({ wsId: m.workspace_id, label: m.label, checkout: m.worktree.checkout_path })),
        members: [...parents, ...kids].map(m => ({ wsId: m.workspace_id, label: m.label, path: normPath(m.worktree.checkout_path) })),
        extraParents: parents.slice(1).map(m => ({ wsId: m.workspace_id, label: m.label, checkout: m.worktree.checkout_path })),
      };
    } else {
      const p = w.worktree && w.worktree.checkout_path ? w.worktree.checkout_path : paths[id];
      unit = {
        key: `ws:${id}`, kind: 'ws', repoKey: rk, wsIds: [id], anchorId: id, label: w.label,
        path: normPath(p), linked: !!(w.worktree && w.worktree.is_linked_worktree),
        children: [], extraParents: [],
      };
    }
    for (const m of unit.wsIds) unitOf[m] = unit.key;
    units.push(unit);
    byKey[unit.key] = unit;
  }
  return { units, unitOf, byKey };
}

function findReplacement(key, rec, units, assigned) {
  if (key.startsWith('ws:') && rec && rec.path) {
    const cand = units.units.filter(x => x.kind === 'ws' && !assigned.has(x.key) && x.path === rec.path);
    const best = cand.find(x => x.label === rec.label) || cand[0];
    return best ? [best] : [];
  }
  if (key.startsWith('repo:')) {
    const rk = key.slice(5);
    return units.units.filter(x => !assigned.has(x.key) && x.repoKey === rk);
  }
  return [];
}

// Bind stored category members to the live units. Returns a new state.
// opts.continuous: the helper saw the previous cycle too, so a key whose record
// was refreshed in that cycle is the same workspace even if a `cd` changed its
// folder and name. Without continuity (helper just started, herdr restarted, or
// the key was absent last cycle) a key whose folder and name both changed is
// treated as an id reused by an unrelated workspace.
function reconcile(state, units, now, opts = {}) {
  const s = clone(state);
  const prevCycle = state.lastCycleAt;
  const continuousKey = k => !!opts.continuous && prevCycle != null && !!s.units[k] && s.units[k].seen >= prevCycle;
  const assigned = new Set();
  for (const c of s.categories) for (const k of c.units) if (units.byKey[k]) assigned.add(k);

  for (const c of s.categories) {
    const next = [];
    for (const k of c.units) {
      const u = units.byKey[k];
      const rec = s.units[k];
      if (u) {
        if (u.kind === 'ws' && rec && rec.path && u.path && rec.path !== u.path && rec.label !== u.label && !continuousKey(k)) {
          assigned.delete(k); // the id now belongs to an unrelated workspace
          delete s.units[k];
          continue;
        }
        next.push(k);
        continue;
      }
      const repl = findReplacement(k, rec, units, assigned);
      if (repl.length) {
        for (const x of repl) { next.push(x.key); assigned.add(x.key); }
        delete s.units[k];
      } else {
        next.push(k); // keep: the project may come back
      }
    }
    c.units = next;
  }

  // A live group that is not placed inherits the slot of a member placed alone.
  for (const u of units.units) {
    if (u.kind !== 'group' || assigned.has(u.key)) continue;
    const members = new Map(u.members.map(m => [`ws:${m.wsId}`, m]));
    const ownMember = k => {
      const m = members.get(k);
      const rec = s.units[k];
      return !!m && (!rec || rec.path === m.path || rec.label === m.label);
    };
    let placed = false;
    for (const c of s.categories) {
      const next = [];
      for (const k of c.units) {
        if (!ownMember(k)) { next.push(k); continue; }
        if (!placed) { next.push(u.key); placed = true; assigned.add(u.key); }
        delete s.units[k];
      }
      c.units = next;
    }
  }

  const seen = new Set();
  for (const c of s.categories) {
    c.units = c.units.filter(k => {
      if (seen.has(k)) return false;
      seen.add(k);
      const u = units.byKey[k];
      if (u) { s.units[k] = { path: u.path, label: u.label, seen: now }; return true; }
      const rec = s.units[k];
      if (rec && typeof rec.seen === 'number' && now - rec.seen > DEAD_MS) { delete s.units[k]; return false; }
      return true;
    });
  }
  s.lastCycleAt = now;
  return s;
}

// After a gap in observation: detached records whose workspace now has another
// name and lives outside the copy's folder belong to a reused id.
function staleDetached(detached, workspaces, paths) {
  const byId = new Map(workspaces.map(w => [w.workspace_id, w]));
  return Object.entries(detached).filter(([id, d]) => {
    const w = byId.get(id);
    if (!w) return false;
    const p = normPath((w.worktree && w.worktree.checkout_path) || paths[id]);
    const c = normPath(d.checkout);
    const inside = !!c && (p === c || p.startsWith(`${c}/`));
    return w.label !== d.name && !inside;
  }).map(([id]) => id);
}

// Flat sidebar: a worktree copy that appeared since the last cycle (prevIds)
// stands right under its project, after the copies already there, in the
// project's category. Copies the plugin detached earlier count as copies.
function placeNewCopies(state, units, prevIds) {
  if (!prevIds) return state;
  let s = state;
  for (const u of units.units) {
    if (u.kind !== 'ws' || !u.repoKey || prevIds.has(u.anchorId)) continue;
    if (s.categories.some(c => c.units.includes(u.key))) continue;
    const sameRepo = k => {
      if (k === u.key) return false;
      const x = units.byKey[k];
      if (x) return x.repoKey === u.repoKey;
      const d = k.startsWith('ws:') && s.detached && s.detached[k.slice(3)];
      return !!d && d.repoKey === u.repoKey;
    };
    const c = s.categories.find(x => x.units.some(sameRepo));
    if (!c) continue;
    if (s === state) s = clone(state);
    const cat = s.categories.find(x => x.id === c.id);
    let at = cat.units.findIndex(sameRepo);
    while (at + 1 < cat.units.length && sameRepo(cat.units[at + 1])) at++;
    cat.units.splice(at + 1, 0, u.key);
    s.units[u.key] = { path: u.path, label: u.label, seen: s.lastCycleAt };
  }
  return s;
}

// Flat sidebar: "⎇ <project>" for every worktree copy (and for a second
// workspace on the project's own folder). The project is the first workspace
// on the repo's main checkout; with it closed, the repo's name.
function projectLabels(workspaces) {
  const out = {};
  const main = new Map();
  for (const w of workspaces) {
    if (!w.worktree || !w.worktree.repo_key || w.worktree.is_linked_worktree) continue;
    const rk = normPath(w.worktree.repo_key);
    if (!main.has(rk)) main.set(rk, w);
  }
  for (const w of workspaces) {
    if (!w.worktree || !w.worktree.repo_key) continue;
    const p = main.get(normPath(w.worktree.repo_key));
    if (p === w || (!w.worktree.is_linked_worktree && !p)) continue;
    const label = p ? p.label : w.worktree.repo_name;
    if (label) out[w.workspace_id] = label;
  }
  return out;
}

// The project of each repo: the first workspace on its main checkout.
// Returns Map repo key -> workspace id.
function projectHeads(workspaces) {
  const heads = new Map();
  for (const w of workspaces) {
    if (!w.worktree || !w.worktree.repo_key || w.worktree.is_linked_worktree) continue;
    const rk = normPath(w.worktree.repo_key);
    if (!heads.has(rk)) heads.set(rk, w.workspace_id);
  }
  return heads;
}

// A herdr build that draws a workspace under the one above it (custom token
// "nested"): in every star block and category, the copies of a project that
// stand in the same place follow it at once and are drawn under it. A copy
// whose project stands elsewhere (a star of another kind, no star, another
// category) keeps its own line and its place. repoOf: workspace id -> repo
// key or null; heads: projectHeads(). Returns { state, nested: Map copy id ->
// project id }.
function nestCopies(shown, units, repoOf, heads) {
  const nested = new Map();
  const idOf = k => (units.byKey[k] ? units.byKey[k].anchorId : null);
  const categories = shown.categories.map(c => {
    const here = new Set(c.units.map(idOf).filter(Boolean));
    const copiesOf = new Map();
    for (const k of c.units) {
      const id = idOf(k);
      const rk = id && repoOf(id);
      const head = rk && heads.get(rk);
      if (!head || head === id || !here.has(head)) continue;
      if (!copiesOf.has(head)) copiesOf.set(head, []);
      copiesOf.get(head).push(k);
    }
    if (!copiesOf.size) return c;
    const pulled = new Set([...copiesOf.values()].flat());
    const order = [];
    for (const k of c.units) {
      if (pulled.has(k)) continue;
      order.push(k);
      const kids = copiesOf.get(idOf(k)) || [];
      for (const x of kids) { order.push(x); nested.set(idOf(x), idOf(k)); }
    }
    return { ...c, units: order };
  });
  return { state: { ...shown, categories }, nested };
}

// herdr draws a nested workspace under whatever stands above it, so only the
// copies that stand right under their project (or under a copy drawn there)
// in herdr's order keep the mark — not ones left elsewhere by a paused order.
function nestedInOrder(nested, order) {
  const out = new Map();
  for (let i = 1; i < order.length; i++) {
    const head = nested.get(order[i]);
    if (head && (order[i - 1] === head || out.get(order[i - 1]) === head)) out.set(order[i], head);
  }
  return out;
}

function categoryOf(state, key) {
  const c = state.categories.find(x => x.units.includes(key));
  return c ? c.id : null;
}

// Stars on top: a project whose star kind is in onTop leaves its category in
// the sidebar and stands in one block per kind above every category (the
// category stays its home in the window). A worktree group counts by the star
// of its main project. Inside a block the order is the person's
// (state.starOrder[kind], learned from a drag inside the block); the ones not
// in it follow in the order of the categories, then herdr's order. Only the first block has a
// title: the blocks after it follow on under it, told apart by the colour of
// their stars. kindOf: workspace id -> kind; nameOf: kind -> block name.
// Returns { cats, pinned: Set of unit keys }.
function starBlocks(state, units, kindOf, onTop, nameOf) {
  const cats = [];
  const pinned = new Set();
  const kinds = [...new Set(onTop || [])].sort((a, b) => a - b);
  if (!kinds.length) return { cats, pinned };
  const seq = [];
  const seen = new Set();
  const add = k => { if (units.byKey[k] && !seen.has(k)) { seen.add(k); seq.push(k); } };
  for (const c of state.categories) c.units.forEach(add);
  for (const u of units.units) add(u.key);
  for (const kind of kinds) {
    let keys = seq.filter(k => kindOf(units.byKey[k].anchorId) === kind);
    if (!keys.length) continue;
    const own = new Map(((state.starOrder || {})[kind] || []).map((k, i) => [k, i]));
    keys = [...keys.filter(k => own.has(k)).sort((a, b) => own.get(a) - own.get(b)), ...keys.filter(k => !own.has(k))];
    keys.forEach(k => pinned.add(k));
    cats.push({ id: `star${kind}`, name: `★ ${nameOf(kind)}`, units: keys, ...(cats.length ? { untitled: true } : {}) });
  }
  return { cats, pinned };
}

// The categories as the sidebar shows them: star blocks first, then the
// categories without the projects that went up.
function withBlocks(state, blocks) {
  if (!blocks.cats.length) return state;
  return {
    ...state,
    categories: [
      ...blocks.cats,
      ...state.categories.map(c => ({ ...c, units: c.units.filter(k => !blocks.pinned.has(k)) })),
    ],
  };
}

function desiredOrder(state, units, liveOrder) {
  if (!state.categories.length) return null;
  const out = [];
  const used = new Set();
  const push = id => { if (id && !used.has(id)) { used.add(id); out.push(id); } };
  for (const c of state.categories) {
    for (const k of c.units) { const u = units.byKey[k]; if (u) u.wsIds.forEach(push); }
  }
  for (const u of units.units) u.wsIds.forEach(push);
  for (const id of liveOrder) push(id);
  return out;
}

function displaySeq(order, units) {
  const seq = [];
  const seen = new Set();
  for (const id of order) {
    const t = units.unitOf[id];
    if (t && !seen.has(t)) { seen.add(t); seq.push(t); }
  }
  return seq;
}

// herdr has no title rows of its own: a category title is a $section token
// drawn as an extra line on top of the first project of the category (on the
// parent of a worktree group). An untitled category (a star block after the
// first) gets none. Returns { wsId: title }.
function sectionTokens(state, units, order) {
  const out = {};
  if (!state.categories.length) return out;
  const catOf = new Map();
  for (const c of state.categories) for (const k of c.units) if (!catOf.has(k)) catOf.set(k, c);
  const done = new Set();
  for (const key of displaySeq(order, units)) {
    const c = catOf.get(key);
    const cid = c ? c.id : NONE_ID;
    if (done.has(cid)) continue;
    done.add(cid);
    if (c && c.untitled) continue;
    out[units.byKey[key].anchorId] = c ? headerLabel(c.name) : NONE_LABEL;
  }
  return out;
}

// Longest common subsequence; tokens are unique in each list.
function lcs(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keep = new Set();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { keep.add(a[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return keep;
}

// Compare the live order with the order the helper last applied. Units that
// left the common order were dragged by a person. herdr reports which
// workspace a drag moved (hintIds); such units count as moved for sure, which
// settles swaps that the order alone cannot. A moved unit joins the category of
// the nearest project above it (the title sits on top of a category's first
// project, so a drop right above that project lands under the previous
// category); dropped at the very top, it joins the category below. Projects
// in the star blocks (pinned) are left out: they go back up whatever happens.
// A drag inside a star block: the block keeps the order herdr shows now
// (state.starOrder[kind]). A drag out of a block changes nothing: the star
// decides where the project stands.
function learnBlockOrder(state, units, liveOrder, blocks) {
  const nothing = { state, moved: [] };
  if (!state.lastApplied || !blocks.cats.length) return nothing;
  const live = displaySeq(liveOrder, units);
  const prev = displaySeq(state.lastApplied, units);
  let s = state;
  const moved = [];
  for (const c of blocks.cats) {
    const inBlock = new Set(c.units);
    const now = live.filter(k => inBlock.has(k));
    const before = prev.filter(k => inBlock.has(k));
    const inNow = new Set(now);
    const inBefore = new Set(before);
    const a = before.filter(k => inNow.has(k));
    const b = now.filter(k => inBefore.has(k));
    if (a.join('\n') === b.join('\n')) continue;
    const kind = Number(c.id.slice('star'.length));
    if (s === state) s = clone(state);
    s.starOrder = { ...(s.starOrder || {}), [kind]: [...now, ...c.units.filter(k => !inNow.has(k))] };
    const keep = lcs(a, b);
    moved.push(...b.filter(k => !keep.has(k)));
  }
  return moved.length ? { state: s, moved } : nothing;
}

function learnFromOrder(state, units, liveOrder, hintIds = [], pinned = new Set()) {
  const nothing = { state, moved: [] };
  if (!state.lastApplied || !state.categories.length) return nothing;
  const liveSeq = displaySeq(liveOrder, units).filter(t => !pinned.has(t));
  const prevSeq = displaySeq(state.lastApplied, units).filter(t => !pinned.has(t));
  const inPrev = new Set(prevSeq);
  const inLive = new Set(liveSeq);
  const a = prevSeq.filter(t => inLive.has(t));
  const b = liveSeq.filter(t => inPrev.has(t));
  if (a.join('\n') === b.join('\n')) return nothing;
  const hinted = new Set(hintIds.map(id => units.unitOf[id]).filter(t => t && inPrev.has(t)));
  const keep = lcs(a.filter(t => !hinted.has(t)), b.filter(t => !hinted.has(t)));
  const moved = b.filter(t => !keep.has(t));
  if (!moved.length) return nothing;

  const s = clone(state);
  const movedSet = new Set(moved);
  const catOf = new Map();
  for (const c of s.categories) for (const k of c.units) if (!catOf.has(k)) catOf.set(k, c.id);
  for (const c of s.categories) c.units = c.units.filter(k => !movedSet.has(k));
  const catById = new Map(s.categories.map(c => [c.id, c]));
  const firstKept = liveSeq.find(t => !movedSet.has(t));
  let cur = firstKept === undefined ? s.categories[0].id : (catOf.get(firstKept) || NONE_ID);
  const last = {};
  for (const t of liveSeq) {
    if (!movedSet.has(t)) {
      cur = catOf.get(t) || NONE_ID;
      if (cur !== NONE_ID) last[cur] = t;
      continue;
    }
    if (cur === NONE_ID) continue; // dropped among the rest: uncategorized
    const c = catById.get(cur);
    const idx = last[cur] ? c.units.indexOf(last[cur]) + 1 : 0;
    c.units.splice(idx, 0, t);
    last[cur] = t;
  }
  return { state: s, moved };
}

module.exports = {
  NONE_ID, NONE_LABEL, headerLabel, isHeaderLabel,
  buildUnits, reconcile, placeNewCopies, projectLabels, projectHeads, nestCopies, nestedInOrder, categoryOf, starBlocks, withBlocks, desiredOrder, sectionTokens, learnBlockOrder, learnFromOrder, staleDetached,
  _internal: { displaySeq, lcs },
};
