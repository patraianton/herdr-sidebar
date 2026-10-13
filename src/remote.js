'use strict';
// Remote machines working for a project. An ssh session started in a herdr pane carries the
// pane's id in LC_HERDR_PANE (the shell profile copies HERDR_PANE_ID into it, ssh sends it with
// `SendEnv LC_HERDR_PANE`, and sshd takes LC_* by default), and every process started in that
// session keeps it, a `nohup codex exec …` left running too. Every minute the helper asks each
// machine of settings.json "remotes" which of its processes carry such an id; the projects with
// those panes get `@mac` right of their name.
const { execFile } = require('node:child_process');

const ENV = 'LC_HERDR_PANE';
const COLOR = '#458588';
const NAME_RE = /^[A-Za-z0-9_.-]{1,8}$/;
// A machine that does not answer keeps its marks this many rounds, so a short network
// hiccup does not blink them away.
const KEEP_ROUNDS = 3;

// Prints "<pid> <pane id>" for every process that carries the variable. Linux reads every
// /proc/*/environ in one grep (all of them as root, your own otherwise); macOS prints the
// environment with ps, which shows it for ordinary programs (it hides it only for the
// system's own ones, and those are not what a remote run is).
const PROBE = [
  'if [ -r /proc/self/environ ]; then',
  `  grep -Hzas '^${ENV}=' /proc/[0-9]*/environ 2>/dev/null | tr '\\000' '\\n' | sed -n 's|^/proc/\\([0-9][0-9]*\\)/environ:${ENV}=\\(..*\\)$|\\1 \\2|p'`,
  'else',
  `  ps -Eww -axo pid=,command= 2>/dev/null | awk '{ for (i = 2; i <= NF; i++) if (index($i, "${ENV}=") == 1) { print $1, substr($i, ${ENV.length + 2}); break } }'`,
  'fi',
  '',
].join('\n');

// settings.json "remotes": ["mac", { "name": "dev", "ssh": "root@codex-dev" }]. A plain string is
// both the name shown and the ssh host. Bad entries are left out.
function parseRemotes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    const e = typeof r === 'string' ? { name: r, ssh: r } : r && typeof r === 'object' ? { name: r.name, ssh: r.ssh || r.name } : null;
    if (!e || !NAME_RE.test(String(e.name || '')) || typeof e.ssh !== 'string' || !e.ssh.trim() || e.ssh.trim().startsWith('-')) continue;
    if (out.some(x => x.name === e.name)) continue;
    out.push({ name: e.name, ssh: e.ssh.trim() });
  }
  return out;
}

function parseProbe(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (m) out.push({ pid: m[1], pane: m[2] });
  }
  return out;
}

// The probe goes in on stdin, so the remote login shell (bash, zsh) only starts `sh -s`. Our own
// ssh must not carry the variable, or the probe would count itself.
function runSsh(host) {
  const env = { ...process.env };
  delete env[ENV];
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-T', host, 'sh -s'],
      { encoding: 'utf8', windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim().split(/\r?\n/).pop() || err.message));
        resolve(stdout);
      });
    child.stdin.end(PROBE);
  });
}

// A process counts once it is seen in two rounds in a row: a remote run, an ssh session you keep
// open; not the one-second `ssh mac pgrep …` an agent uses to check on its run.
function makeWatch({ remotes, run = runSsh }) {
  const seen = new Map(); // name -> Set of "pid pane" from its last answer
  const kept = new Map(); // name -> { panes: Set, misses }
  return {
    remotes,
    // Returns { marks: Map pane id -> [names], errors: [[name, message]] }.
    async refresh() {
      const errors = [];
      await Promise.all(remotes.map(async r => {
        let rows;
        try { rows = parseProbe(await run(r.ssh)); } catch (e) {
          errors.push([r.name, e.message]);
          const k = kept.get(r.name);
          if (k && ++k.misses > KEEP_ROUNDS) kept.delete(r.name);
          return;
        }
        const before = seen.get(r.name) || new Set();
        const now = new Set(rows.map(x => `${x.pid} ${x.pane}`));
        const panes = new Set(rows.filter(x => before.has(`${x.pid} ${x.pane}`)).map(x => x.pane));
        seen.set(r.name, now);
        kept.set(r.name, { panes, misses: 0 });
      }));
      const marks = new Map();
      for (const r of remotes) {
        const k = kept.get(r.name);
        if (!k) continue;
        for (const pane of k.panes) marks.set(pane, [...(marks.get(pane) || []), r.name]);
      }
      return { marks, errors };
    },
  };
}

// The sidebar mark of a project: `@mac`, or `@mac+dev` when two machines work for it.
function token(names) {
  const list = [...new Set(names)];
  return list.length ? `@${list.join('+')}` : null;
}

module.exports = { ENV, COLOR, PROBE, parseRemotes, parseProbe, makeWatch, token, _internal: { runSsh } };
