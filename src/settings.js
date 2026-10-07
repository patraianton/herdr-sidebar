'use strict';
// settings.json in the plugin config folder: duty thresholds and the names of
// the star kinds. herdr passes the folder as HERDR_PLUGIN_CONFIG_DIR; the helper
// names it itself. Read once per process.
const path = require('node:path');
const { loadJson } = require('./store');

let dir = null;
let cache = null;

function useConfigDir(d) { dir = d || null; cache = null; }

function settings() {
  if (!cache) {
    const d = dir || process.env.HERDR_PLUGIN_CONFIG_DIR;
    const s = d ? loadJson(path.join(d, 'settings.json'), {}) : {};
    cache = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  }
  return cache;
}

module.exports = { settings, useConfigDir };
