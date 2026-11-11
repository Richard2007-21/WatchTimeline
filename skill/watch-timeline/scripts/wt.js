#!/usr/bin/env node
/*
 * wt – command line of the WatchTimeline skill.
 *
 * Talks to the WatchTimeline extension that runs inside Premiere Pro or After
 * Effects. Requests are files in the application data folder; the extension
 * answers with a file. No network, no dependencies, Node.js 14 or later.
 *
 *   node wt.js help
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ALIVE_MS = 6500;        // a heartbeat older than this means: not running
const PICKUP_MS = 10000;      // a request nobody took after this means: not answering

// ---------------------------------------------------------------- bridge

function appDataDir() {
  if (process.env.WATCHTIMELINE_HOME) return process.env.WATCHTIMELINE_HOME;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'WatchTimeline');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'WatchTimeline');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'WatchTimeline');
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// The hosts that answer right now: [{ dir, host, hostName, hostVersion, project, version }]
function instances() {
  const root = path.join(appDataDir(), 'bridge');
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    const dir = path.join(root, name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^alive-.*\.json$/.test(f)); } catch (e) { continue; }
    let best = null;
    for (const f of files) {
      const a = readJSON(path.join(dir, f));
      if (a && typeof a.t === 'number' && (!best || a.t > best.t)) best = a;
    }
    if (best && Date.now() - best.t < ALIVE_MS) out.push(Object.assign({ dir }, best));
  }
  return out;
}

class WtError extends Error {
  constructor(key, detail, line) {
    super(detail ? key + ': ' + detail : key);
    this.key = key;
    this.detail = detail || '';
    this.line = line || 0;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(inst, cmd, args, timeoutMs) {
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  const inFile = path.join(inst.dir, 'in', id + '.json');
  const outFile = path.join(inst.dir, 'out', id + '.json');
  const tmpDir = path.join(inst.dir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(path.dirname(inFile), { recursive: true });
  const tmp = path.join(tmpDir, id + '.req');
  fs.writeFileSync(tmp, JSON.stringify({ id, cmd, args: args || {}, t: Date.now() }));
  fs.renameSync(tmp, inFile);
  const start = Date.now();
  for (;;) {
    const res = readJSON(outFile);
    if (res) {
      try { fs.unlinkSync(outFile); } catch (e) {}
      if (!res.ok) throw new WtError(res.error || 'failed', res.detail, res.line);
      return res.result;
    }
    const waited = Date.now() - start;
    if (waited > PICKUP_MS && fs.existsSync(inFile)) {
      try { fs.unlinkSync(inFile); } catch (e) {}
      throw new WtError('not-answering', (inst.hostName || inst.host) + ' did not take the request. Is a dialog open in the app?');
    }
    if (waited > timeoutMs) throw new WtError('timeout', 'No answer after ' + Math.round(timeoutMs / 1000) + ' s. The app may be busy or showing a dialog.');
    await sleep(waited < 2000 ? 60 : 200);
  }
}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { _: [] };
  const flags = { '--json': 'json', '--all': 'all', '--no-undo': 'noUndo', '--here': 'here', '-h': 'help', '--help': 'help' };
  const values = {
    '--host': 'host', '--summary': 'summary', '--question': 'question', '--time': 'time', '--out': 'out',
    '--note': 'note', '--timeout': 'timeout', '--status': 'status', '--code': 'code', '-e': 'code'
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (flags[key]) opts[flags[key]] = true;
    else if (values[key]) {
      const v = eq > 0 && a.startsWith('--') ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new WtError('usage', 'Missing value for ' + key);
      opts[values[key]] = v;
    } else if (a.startsWith('-') && a.length > 1 && isNaN(Number(a))) throw new WtError('usage', 'Unknown option ' + a);
    else opts._.push(a);
  }
  return opts;
}

function hostFilter(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return null;
  if (/^(ppro|premiere|pr|premiere-pro|premierepro)$/.test(n)) return 'PPRO';
  if (/^(ae|aeft|after-effects|aftereffects|after)$/.test(n)) return 'AEFT';
  throw new WtError('usage', '--host must be "ppro" or "ae"');
}

const NOT_RUNNING = 'WatchTimeline does not answer. Premiere Pro or After Effects must be running with a project open and ' +
  'the WatchTimeline extension installed. Opening the panel (Window > Extensions > WatchTimeline) starts it for sure. ' +
  'After starting the app, wait a few seconds and try again.';

function alive(opts) {
  const want = hostFilter(opts.host);
  const list = instances().filter((i) => !want || i.host === want);
  if (!list.length) throw new WtError('not-running', NOT_RUNNING);
  return list;
}

// The one host a command goes to. With a note id: the host that knows the note.
async function pick(opts, noteId, timeoutMs) {
  const list = alive(opts);
  if (list.length === 1) return list[0];
  if (noteId) {
    for (const inst of list) {
      try {
        await request(inst, 'note', { id: noteId }, timeoutMs);
        return inst;
      } catch (e) { /* not in this host */ }
    }
    throw new WtError('note-missing', 'No running app has a note ' + noteId);
  }
  throw new WtError('usage', 'Premiere Pro and After Effects both run. Add --host ppro or --host ae.');
}

// ---------------------------------------------------------------- output

function secs(n) {
  return (Math.round(Number(n) * 100) / 100) + ' s';
}

function containerText(c) {
  if (!c) return 'unknown place';
  const kind = c.type === 'sequence' ? 'sequence' : c.type === 'comp' ? 'composition' : 'project item';
  return kind + ' "' + c.name + '"';
}

function itemText(i) {
  if (i.kind === 'layer') return 'layer #' + i.index + ' "' + i.name + '" (' + (i.layerKind || 'layer') + ', ' + secs(i.start) + ' to ' + secs(i.end) + ')';
  return 'clip "' + i.name + '"' + (i.track ? ' on ' + i.track : '') + ' (' + secs(i.start) + ' to ' + secs(i.end) + ')';
}

function targetText(n) {
  const t = n.target || {};
  const c = containerText(t.container);
  if (t.container && t.container.type === 'item') return 'the whole ' + c;
  if (n.scope === 'selection') {
    return 'ONLY ' + (t.items || []).map(itemText).join(', ') + ' in ' + c + '; the user looked at ' + t.timecode + ' (' + secs(t.time) + ')';
  }
  if (n.scope === 'whole') return 'the whole ' + c + '; the user looked at ' + t.timecode + ' (' + secs(t.time) + ')';
  return 'ONLY the spot at ' + t.timecode + ' (' + secs(t.time) + ') in ' + c;
}

function threadLines(n) {
  const names = { fixed: 'Claude changed', question: 'Claude asked', reopened: 'User, not happy yet', answered: 'User answered' };
  return (n.history || []).filter((h) => names[h.type] && h.text).map((h) => '    ' + names[h.type] + ': ' + h.text.replace(/\n/g, '\n      '));
}

function noteText(n) {
  const lines = ['[' + n.id + '] ' + n.status.toUpperCase() + ' – ' + targetText(n), '  Note: ' + n.text.replace(/\n/g, '\n    ')];
  const t = n.target || {};
  if (t.properties && t.properties.length) {
    lines.push('  Selected properties: ' + t.properties.map((p) => p.layer + ' > ' + p.path).join('; '));
  }
  const thread = threadLines(n);
  if (thread.length) {
    const changed = (n.history || []).some((h) => h.type === 'fixed');
    lines.push('  Thread so far' + (changed ? ' (your earlier change is still in the project):' : ':'));
    lines.push.apply(lines, thread);
  }
  return lines.join('\n');
}

function print(value) {
  process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
}

// ---------------------------------------------------------------- commands

const HELP = `wt – WatchTimeline command line (talks to Premiere Pro / After Effects)

  node wt.js status                      Which app runs, which project, how many notes
  node wt.js notes [--all] [--json]      The open notes (the ones to work on). --all: every status
  node wt.js show <id>                   One note as JSON (target, thread)
  node wt.js inspect <id> [--time s] [--all]
                                         What is at the note's spot: clips/layers, effects, values
  node wt.js inspect --here              The same for the current playhead position
  node wt.js frame <id> [--time s] [--out file.png]
                                         Render the frame at the note's time; prints the PNG path
  node wt.js eval <file.jsx> [--note id] [--no-undo]
  node wt.js eval --code "<ExtendScript>"
                                         Run ExtendScript in the app; prints { ok, value } as JSON
                                         --no-undo: for scripts that only read (no undo step in After Effects)
  node wt.js done <id> --summary "…"     Report: the note is changed. Says what was changed
  node wt.js ask <id> --question "…"     Nothing changed: hand the note back with a question
  node wt.js jump <id>                   Move the playhead to the note and select its clips/layers

Options:  --host ppro|ae   when both apps run      --timeout <seconds>      --json`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._.shift() || 'help';
  if (cmd === 'help' || opts.help) { print(HELP); return; }
  const timeout = (Number(opts.timeout) || (cmd === 'eval' ? 600 : 90)) * 1000;
  const id = opts._[0];

  if (cmd === 'status') {
    const list = instances().filter((i) => !hostFilter(opts.host) || i.host === hostFilter(opts.host));
    if (!list.length) throw new WtError('not-running', NOT_RUNNING);
    const out = [];
    for (const inst of list) {
      let ctx = null;
      let error = '';
      try { ctx = await request(inst, 'context', {}, timeout); } catch (e) { error = e.message; }
      out.push({ host: inst.host, hostName: inst.hostName, hostVersion: inst.hostVersion, extension: inst.version, context: ctx, error });
    }
    if (opts.json) { print({ running: out }); return; }
    for (const o of out) {
      const c = o.context;
      print(o.hostName + ' ' + o.hostVersion + ' (WatchTimeline ' + o.extension + ')');
      if (!c) { print('  ' + (o.error || 'no answer')); continue; }
      print('  Project: ' + (c.project ? (c.project.name || 'unsaved') + (c.project.path ? '  [' + c.project.path + ']' : '') : 'none open'));
      print('  In front: ' + (c.container ? containerText(c.container) + (c.timecode ? ' at ' + c.timecode + ' (' + secs(c.time) + ')' : '') : 'nothing'));
      if (c.counts) {
        print('  Notes: ' + c.counts.open + ' open, ' + c.counts.question + ' waiting for the user\'s answer, ' + c.counts.review + ' to check, ' + c.counts.done + ' done');
        print('  After a change: ' + (c.reviewMode === 'auto' ? 'notes leave the list at once (automatic)' : 'the user checks and ticks off each note (manual)'));
      }
    }
    return;
  }

  if (cmd === 'notes') {
    const list = alive(opts);
    const status = opts.all ? 'all' : (opts.status || 'open');
    const out = [];
    for (const inst of list) {
      try { out.push(await request(inst, 'notes', { status }, timeout)); } catch (e) {
        out.push({ hostName: inst.hostName, host: inst.host, error: e.message, notes: [] });
      }
    }
    if (opts.json) { print(out.length === 1 ? out[0] : { hosts: out }); return; }
    for (const o of out) {
      print(o.hostName + ' – project ' + (o.project ? '"' + (o.project.name || 'unsaved') + '"' : '(none)'));
      if (o.error) { print('  ' + o.error); continue; }
      if (!o.notes.length) {
        print('  No ' + (status === 'all' ? '' : status + ' ') + 'notes.' +
          (o.counts && status === 'open' && (o.counts.review || o.counts.question) ? ' (' + o.counts.review + ' wait for the user\'s check, ' + o.counts.question + ' for an answer.)' : ''));
        continue;
      }
      print('  ' + o.notes.length + ' ' + (status === 'all' ? '' : status + ' ') + 'note' + (o.notes.length === 1 ? '' : 's') +
        (list.length > 1 ? '  [this app: --host ' + (o.host === 'AEFT' ? 'ae' : 'ppro') + ']' : '') + '\n');
      print(o.notes.map(noteText).join('\n\n'));
    }
    return;
  }

  if (cmd === 'show') {
    if (!id) throw new WtError('usage', 'show <id>');
    const inst = await pick(opts, id, timeout);
    const r = await request(inst, 'note', { id }, timeout);
    print(opts.json ? r.note : noteText(r.note) + '\n\n' + JSON.stringify(r.note.target, null, 2));
    return;
  }

  if (cmd === 'inspect') {
    if (!id && !opts.here) throw new WtError('usage', 'inspect <id>   or   inspect --here');
    const inst = await pick(opts, id, timeout);
    const args = { all: !!opts.all };
    if (id) args.id = id;
    if (opts.time !== undefined) args.time = Number(opts.time);
    print(await request(inst, 'inspect', args, timeout));
    return;
  }

  if (cmd === 'frame') {
    const inst = await pick(opts, id, timeout);
    const args = {};
    if (id) args.id = id;
    if (opts.time !== undefined) args.time = Number(opts.time);
    if (opts.out) args.out = path.resolve(opts.out);
    const r = await request(inst, 'frame', args, timeout);
    print(opts.json ? r : r.path);
    return;
  }

  if (cmd === 'eval') {
    const args = {};
    if (opts.code !== undefined) args.code = String(opts.code);
    else if (id) {
      args.file = path.resolve(id);
      if (!fs.existsSync(args.file)) throw new WtError('script-missing', args.file);
    } else throw new WtError('usage', 'eval <file.jsx>   or   eval --code "…"');
    const inst = await pick(opts, opts.note, timeout);
    args.undo = opts.noUndo ? false : 'WatchTimeline' + (opts.note ? ' ' + opts.note : '');
    const r = await request(inst, 'eval', args, timeout);
    print(r);
    return;
  }

  if (cmd === 'done') {
    if (!id || !opts.summary) throw new WtError('usage', 'done <id> --summary "what was changed"');
    const inst = await pick(opts, id, timeout);
    const r = await request(inst, 'done', { id, summary: opts.summary }, timeout);
    print(opts.json ? r : 'Note ' + r.note.id + ' → ' + (r.note.status === 'done' ?
      'done (removed from the list, marker deleted).' : 'to check (the user looks at it and ticks it off).'));
    return;
  }

  if (cmd === 'ask') {
    if (!id || !opts.question) throw new WtError('usage', 'ask <id> --question "what you need to know"');
    const inst = await pick(opts, id, timeout);
    const r = await request(inst, 'ask', { id, question: opts.question }, timeout);
    print(opts.json ? r : 'Note ' + r.note.id + ' → question for the user (shown on the note in the panel).');
    return;
  }

  if (cmd === 'jump') {
    if (!id) throw new WtError('usage', 'jump <id>');
    const inst = await pick(opts, id, timeout);
    print(await request(inst, 'jump', { id }, timeout));
    return;
  }

  throw new WtError('usage', 'Unknown command "' + cmd + '". Run: node wt.js help');
}

const HINTS = {
  'no-project': 'No project is open in the app.',
  'no-container': 'No sequence / composition is open in the app.',
  'note-missing': 'No running app has a note with that id. Run "notes --all"; if the note belongs to an app that is closed, "status" shows which apps answer.',
  'container-missing': 'The sequence / composition of the note no longer exists in the project.',
  'host-failed': 'The app did not run the command. A dialog may be open, or the extension needs a restart of the app.',
  'script-error': 'Your script threw an error. Nothing after the failing line ran.',
  'frame-failed': 'The frame could not be rendered.'
};

main().catch((e) => {
  const key = e && e.key ? e.key : 'error';
  const out = { ok: false, error: key, detail: e && e.detail !== undefined ? e.detail : String(e && e.message || e) };
  if (e && e.line) out.line = e.line;
  if (HINTS[key]) out.hint = HINTS[key];
  process.stderr.write(JSON.stringify(out, null, 2) + '\n');
  process.exitCode = key === 'not-running' ? 2 : 1;
});
