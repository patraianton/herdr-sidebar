'use strict';
// JSON files: tolerant reads, atomic writes, the empty plugin state.
const fs = require('node:fs');
const path = require('node:path');

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows: a reader or an antivirus can hold the file for a moment.
      if (attempt >= 5) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      const until = Date.now() + 50;
      while (Date.now() < until) { /* short wait */ }
    }
  }
}

function emptyState() {
  return {
    version: 1,
    categories: [],   // [{ id, name, units: [unitKey] }] in display order
    units: {},        // unitKey -> { path, label, seen } memory for re-binding
    headers: {},      // categoryId | '__none' -> header workspace id
    detached: {},     // workspace id -> { checkout, repoKey, repoRoot, parentLabel, name, at }
    duty: {},         // duty id -> duty record (see duty.js)
    hotkeys: [],      // [{ slot, key, target: { wsId, label, path, tabId?, tabLabel? } }] (see hotkeys.js)
    stars: [],        // [{ target: { wsId, label, path } }] (see stars.js)
    lastApplied: null, // workspace ids in the order the helper last saw or set
    lastCycleAt: null, // time of the last reconcile (continuity of observation)
    nextId: 1,
  };
}

function loadState(file) {
  const s = loadJson(file, null);
  const base = emptyState();
  if (!s || typeof s !== 'object') return base;
  return { ...base, ...s };
}

module.exports = { loadJson, saveJson, emptyState, loadState };
