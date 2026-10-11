'use strict';
// The $lavish mark: a violet ◉ on a workspace where an agent is waiting for your answer
// on a Lavish review page (lavish-axi, https://github.com/kunchenguid/lavish-axi).
//
// The agent shows an HTML page and then waits with `lavish-axi poll <page>` until you send
// feedback. Every process started in a herdr pane inherits HERDR_PANE_ID, so the waiting
// process names its own pane, even when the page lives outside the window's folder. Windows
// does not show another process's environment, so a PowerShell probe reads it from the
// process block (observed x64 offsets). The pane is remembered for the page, and the mark
// stays while the page is still open in lavish-axi's state.json and you have not answered it
// since it last changed: an agent often keeps waiting after your answer in case you add
// something, but the next move is its own. A page that needs no answer (a report you have read)
// can be taken off by hand with F5. The mark comes back when the agent changes the page.
// Windows only; elsewhere no workspace is marked.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Not herdr's own ● / ○: those already open the same line as the agent's state.
const MARK = '◉';
const COLOR = '#a371f7';

const PROBE = String.raw`
$ErrorActionPreference='Stop'
$polls=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' AND CommandLine LIKE '%lavish-axi%'" | Where-Object { $_.CommandLine -match '\spoll\s' })
if($polls.Count -eq 0){ '[]'; exit 0 }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SidebarLavishProbe {
  [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h,int c,ref PBI p,int l,out int r);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(int a,bool i,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr h,IntPtr a,byte[] b,int s,out int r);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr r1; public IntPtr Peb; public IntPtr r2a; public IntPtr r2b; public IntPtr Pid; public IntPtr r3; }
  static IntPtr RdPtr(IntPtr h,long a){ byte[] b=new byte[8]; int r; ReadProcessMemory(h,(IntPtr)a,b,8,out r); return (IntPtr)BitConverter.ToInt64(b,0); }
  static ushort RdU16(IntPtr h,long a){ byte[] b=new byte[2]; int r; ReadProcessMemory(h,(IntPtr)a,b,2,out r); return BitConverter.ToUInt16(b,0); }
  public static string[] Info(int pid){
    IntPtr h=OpenProcess(0x0400|0x0010,false,pid);
    if(h==IntPtr.Zero) return new string[]{null,null};
    try{
      PBI pbi=new PBI(); int r;
      if(NtQueryInformationProcess(h,0,ref pbi,Marshal.SizeOf(pbi),out r)!=0) return new string[]{null,null};
      long pp=(long)RdPtr(h,(long)pbi.Peb+0x20);
      string pane=null; IntPtr env=RdPtr(h,pp+0x80); int sz=65536;
      while(sz>=4096){ byte[] buf=new byte[sz]; int rd;
        if(ReadProcessMemory(h,env,buf,sz,out rd)){ foreach(string ln in System.Text.Encoding.Unicode.GetString(buf,0,rd).Split('\0')){ if(ln.StartsWith("HERDR_PANE_ID=")){ pane=ln.Substring(14); break; } } break; } sz/=2; }
      string cwd=null; ushort n=RdU16(h,pp+0x38); IntPtr bp=RdPtr(h,pp+0x40);
      if(n>0 && n<2048){ byte[] cb=new byte[n]; int rd2; if(ReadProcessMemory(h,bp,cb,n,out rd2)) cwd=System.Text.Encoding.Unicode.GetString(cb,0,rd2); }
      return new string[]{pane,cwd};
    } finally { CloseHandle(h); }
  }
}
"@
$rows=@($polls | ForEach-Object {
  $i=[SidebarLavishProbe]::Info([int]$_.ProcessId)
  $m=[regex]::Match([string]$_.CommandLine,'\spoll\s+"?([^"]+?\.html?)(?:"|\s|$)')
  [pscustomobject]@{ pane=$i[0]; cwd=$i[1]; file=$(if($m.Success){$m.Groups[1].Value}else{$null}) }
})
ConvertTo-Json -InputObject $rows -Compress
`;

// Comparable form of a Windows path: forward slashes, lower case, no trailing slash.
const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function parseProbe(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  const v = JSON.parse(text);
  return (Array.isArray(v) ? v : [v]).filter(r => r && typeof r === 'object');
}

// Pages still open in lavish-axi's state.json: the time of your last answer (0 when none), the
// session key and the local link. null when the state cannot be read (then every wait counts:
// a mark too many beats a missing one).
function openPages(stateText) {
  try {
    const sessions = JSON.parse(stateText).sessions || {};
    const open = new Map();
    for (const s of Object.values(sessions)) {
      if (s && s.status === 'open' && s.file) {
        open.set(norm(s.file), { answered: Date.parse(s.last_answer_at) || 0, key: String(s.key || ''), url: String(s.url || '') });
      }
    }
    return open;
  } catch {
    return null;
  }
}

// The address lavish-axi gives out for its pages from outside (LAVISH_AXI_PUBLIC_URL or
// publicUrl in its config.json), origin only; '' when there is none.
function publicBase(env = process.env) {
  let raw = env.LAVISH_AXI_PUBLIC_URL || '';
  if (!raw) {
    try { raw = JSON.parse(fs.readFileSync(path.join(path.dirname(stateFile(env)), 'config.json'), 'utf8').replace(/^﻿/, '')).publicUrl || ''; } catch {}
  }
  try { return raw ? new URL(raw).origin : ''; } catch { return ''; }
}

// A page's short name: its folder for an index.html, else the file name without .html.
function pageName(file) {
  const base = path.win32.basename(file);
  return /^index\.html?$/i.test(base) ? path.win32.basename(path.win32.dirname(file)) : base.replace(/\.html?$/i, '');
}

// Last change of a page file in ms; a page that cannot be read counts as just changed.
function fileMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return Infinity; }
}

// The page a wait is for. A page path given relative to the waiting process's folder is
// resolved there.
const pageOf = p => (path.win32.isAbsolute(p.file) || !p.cwd ? p.file : path.win32.join(p.cwd, p.file));

// Open and not answered since it last changed.
function unanswered(file, open, mtime) {
  if (!open.has(norm(file))) return false;
  const { answered } = open.get(norm(file));
  return !(answered && mtime(file) <= answered);
}

// A remembered page wants your answer: open, and neither answered nor taken off with F5
// (v.seen) since it last changed.
function wanted(v, open, mtime) {
  return unanswered(v.file, open, mtime) && !(v.seen && mtime(v.file) <= v.seen);
}

// Panes with at least one wait on a page that is still open and was not answered since it
// last changed; with open === null (state unreadable), every wait.
function waitingPanes(polls, open, mtime = fileMtime) {
  const panes = new Set();
  for (const p of polls) {
    if (!p.pane || !p.file) continue;
    if (open === null || unanswered(pageOf(p), open, mtime)) panes.add(String(p.pane));
  }
  return panes;
}

// Remember which pane waited on each page last (pages: norm(file) -> { pane, file, seen? }) and
// forget pages that are no longer open. Returns the panes whose pages still want an answer.
function rememberPages(pages, polls, open, mtime = fileMtime) {
  for (const p of polls) {
    if (!p.pane || !p.file) continue;
    const file = pageOf(p);
    if (open.has(norm(file))) pages[norm(file)] = { ...pages[norm(file)], pane: String(p.pane), file };
  }
  for (const k of Object.keys(pages)) if (!open.has(k)) delete pages[k];
  const panes = new Set();
  for (const v of Object.values(pages)) if (wanted(v, open, mtime)) panes.add(v.pane);
  return panes;
}

// The links of every page a pane waited on that is still open, per pane: the Claude status line
// of that pane shows them. The pages that want an answer come first (waiting: true), then the
// ones answered or taken off; the most recently changed first within each (pages: as kept by
// rememberPages).
function paneLinks(pages, open, mtime = fileMtime, base = '') {
  const rows = [];
  for (const v of Object.values(pages)) {
    const s = open.get(norm(v.file));
    if (!s) continue;
    const url = base && s.key ? `${base}/session/${s.key}` : s.url;
    if (url) rows.push({ pane: v.pane, name: pageName(v.file), url, waiting: wanted(v, open, mtime), changed: mtime(v.file) });
  }
  const order = (a, b) => (a === b ? 0 : a > b ? 1 : -1);
  rows.sort((a, b) => order(b.waiting, a.waiting) || order(b.changed, a.changed));
  const links = {};
  for (const r of rows) (links[r.pane] = links[r.pane] || []).push({ name: r.name, url: r.url, waiting: r.waiting });
  return links;
}

// The notice after F5.
function toggleNote(r) {
  const names = list => list.join(', ');
  if (r && r.off && r.off.length) return `Dot off: ${names(r.off)}. The link stays in the agent's status line; the dot comes back when the agent changes the page.`;
  if (r && r.back && r.back.length) return `Dot back: ${names(r.back)}.`;
  return 'No Lavish page in this window.';
}

// Alt+5: the next workspace down the sidebar with the dot, round to the first.
function nextMarked(workspaces) {
  const marked = w => Boolean(w.tokens && w.tokens.lavish);
  const here = workspaces.findIndex(w => w.focused);
  return workspaces.find((w, i) => i > here && marked(w)) || workspaces.find(marked) || null;
}

function stateFile(env = process.env) {
  const dir = env.LAVISH_AXI_STATE_DIR || path.join(os.homedir(), '.lavish-axi');
  return path.join(dir, 'state.json');
}

// The script travels base64-encoded: its quotes and here-string would not survive the
// command line otherwise.
function defaultRun(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// refresh() -> Set of pane ids whose Lavish page still wants your answer.
//
// The dot follows the page, not the waiting process: a window often waits in rounds (no wait
// between them), or stops waiting and picks your answer up later from lavish-axi's queue. So
// each page is remembered with the pane that waited on it last (load/save keep that across
// helper restarts) until the page is no longer open; a failed probe only means no new pages
// are learned this round. With the state unreadable, only the live waits count.
//
// toggle(panes) is F5 on the workspace with these panes: its pages that want an answer count
// as read from now on (the links stay), or, when none does, the pages taken off there before
// come back. Returns { off | back: [page names], panes: the new Set }.
function makeWatch({ run = defaultRun, readState = () => fs.readFileSync(stateFile(), 'utf8'), mtime = fileMtime, platform = process.platform, load = () => ({}), save = () => {}, base = publicBase } = {}) {
  let pages = null;
  let saved = '';
  const loadPages = () => {
    if (pages !== null) return;
    try { pages = (load() || {}).pages || {}; } catch { pages = {}; }
  };
  const readOpen = () => { try { return openPages(readState()); } catch { return null; } };
  const publish = (polls, open) => {
    const panes = rememberPages(pages, polls, open, mtime);
    let links = {};
    try { links = paneLinks(pages, open, mtime, base()); } catch {}
    const now = JSON.stringify({ pages, panes: [...panes].sort(), links });
    if (now !== saved) { saved = now; try { save(JSON.parse(now)); } catch {} }
    return panes;
  };
  return {
    async refresh() {
      if (platform !== 'win32') return new Set();
      loadPages();
      let polls = [];
      let probeError = null;
      try { polls = parseProbe(await run(PROBE)); } catch (e) { probeError = e; }
      const open = readOpen();
      if (open === null) {
        if (probeError) throw probeError;
        return waitingPanes(polls, null, mtime);
      }
      const panes = publish(polls, open);
      if (probeError && !Object.keys(pages).length) throw probeError;
      return panes;
    },
    toggle(paneIds, now = Date.now()) {
      if (platform !== 'win32') throw new Error('The Lavish dot works on Windows only.');
      loadPages();
      const open = readOpen();
      if (open === null) throw new Error('Could not read the Lavish state (state.json).');
      const mine = Object.values(pages).filter(v => paneIds.has(v.pane) && open.has(norm(v.file)));
      const waiting = mine.filter(v => wanted(v, open, mtime));
      const r = {};
      if (waiting.length) {
        for (const v of waiting) v.seen = now;
        r.off = waiting.map(v => pageName(v.file));
      } else {
        const back = mine.filter(v => v.seen && unanswered(v.file, open, mtime));
        for (const v of back) delete v.seen;
        r.back = back.map(v => pageName(v.file));
      }
      r.panes = publish([], open);
      return r;
    },
  };
}

module.exports = { MARK, COLOR, PROBE, makeWatch, nextMarked, toggleNote, _internal: { norm, parseProbe, openPages, waitingPanes, rememberPages, paneLinks, pageName, publicBase } };
