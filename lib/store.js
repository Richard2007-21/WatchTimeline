/*
 * WatchTimeline – storage: settings and the notes of every project.
 *
 * Nothing is written next to the project file. Everything lives in the
 * application data folder:
 *   macOS    ~/Library/Application Support/WatchTimeline
 *   Windows  %APPDATA%\WatchTimeline
 *
 *   settings.json            panel settings
 *   projects/<name>-<hash>.json   notes of one project
 *   bridge/…                 request queue between the Claude skill and the host
 *   frames/…                 frames rendered for Claude
 *
 * A note:
 *   { id, text, status, scope, host, target, markers, result, question, feedback,
 *     created, updated, history: [{ t, by, type, text }] }
 * history is the thread of the note: created, fixed (Claude), reopened (user),
 * question (Claude), answered (user), accepted, edited.
 * status: open → (Claude) → review → (user) → done
 *         open → (Claude) → question → (user answers) → open
 */
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');

var IS_WIN = os.platform() === 'win32';
var APP = 'WatchTimeline';
var STATUSES = ['open', 'question', 'review', 'done'];
var SCOPES = ['time', 'selection', 'whole'];

var DEFAULT_SETTINGS = {
  language: '',          // '' = language of the Adobe app
  reviewMode: 'manual',  // 'manual': you tick a note off yourself · 'auto': it leaves the list when Claude is done
  markers: true,         // show every note as a marker in the timeline
  checkUpdates: true     // ask GitHub for a new release now and then
};

// ---------------------------------------------------------------- files

function appDataDir() {
  if (process.env.WATCHTIMELINE_HOME) return process.env.WATCHTIMELINE_HOME;
  if (IS_WIN) return path.join(process.env.APPDATA || os.homedir(), APP);
  if (os.platform() === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', APP);
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), APP);
}

function mkdirp(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

// Writes through a temporary file, so a reader never sees half a file.
function writeJSON(file, value) {
  mkdirp(path.dirname(file));
  var tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows cannot rename over a file that another process has open.
    try { fs.writeFileSync(file, JSON.stringify(value, null, 2)); } finally { try { fs.unlinkSync(tmp); } catch (e2) {} }
  }
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch (e) { return 0; }
}

// ---------------------------------------------------------------- settings

function settingsFile() { return path.join(appDataDir(), 'settings.json'); }

function loadSettings() {
  var s = readJSON(settingsFile(), {}) || {};
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    out[k] = s[k] === undefined ? DEFAULT_SETTINGS[k] : s[k];
  });
  if (out.reviewMode !== 'auto') out.reviewMode = 'manual';
  out.markers = out.markers !== false;
  out.checkUpdates = out.checkUpdates !== false;
  return out;
}

function saveSettings(s) {
  var cur = loadSettings();
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { if (s[k] !== undefined) cur[k] = s[k]; });
  writeJSON(settingsFile(), cur);
  return cur;
}

// ---------------------------------------------------------------- project files

// project: { path, name, host }. Unsaved projects share one file per host.
function projectKey(project) {
  var p = project || {};
  var id = p.path ? String(p.path) : 'unsaved-' + (p.host || 'x');
  var norm = id.replace(/\\/g, '/');
  if (IS_WIN || /^[A-Za-z]:\//.test(norm)) norm = norm.toLowerCase();     // Windows: case does not matter
  var base = path.posix.basename(norm).replace(/\.(prproj|aepx?|aet)$/i, '')
    .replace(/[^A-Za-z0-9\-_. ]+/g, '_').replace(/^[. ]+/, '').slice(0, 40) || 'project';
  return base + '-' + crypto.createHash('sha1').update(norm).digest('hex').slice(0, 10);
}

function projectFile(project) {
  return path.join(appDataDir(), 'projects', projectKey(project) + '.json');
}

function emptyData(project) {
  var p = project || {};
  return { version: 1, project: { path: p.path || '', name: p.name || '', host: p.host || '' }, notes: [] };
}

function load(project) {
  var d = readJSON(projectFile(project), null);
  if (!d || typeof d !== 'object' || !(d.notes instanceof Array)) d = emptyData(project);
  return d;
}

function save(project, data) {
  data.project = { path: (project && project.path) || '', name: (project && project.name) || '', host: (project && project.host) || '' };
  writeJSON(projectFile(project), data);
}

// The panel, the background service and (through the bridge) the skill can
// change the same file. A lock file keeps read-change-write in one piece.
function withLock(file, fn) {
  var lock = file + '.lock';
  mkdirp(path.dirname(file));
  var start = Date.now();
  var fd = null;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST') break;                       // cannot lock (read-only?): go on without
      var age = Date.now() - mtime(lock);
      if (age > 3000 || Date.now() - start > 1500) { try { fs.unlinkSync(lock); } catch (e2) {} }
      if (Date.now() - start > 4000) break;
    }
  }
  try { return fn(); } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e3) {} try { fs.unlinkSync(lock); } catch (e4) {} }
  }
}

// Reads the notes, lets fn change them and writes them back. Returns fn's result.
function update(project, fn) {
  var file = projectFile(project);
  return withLock(file, function () {
    var data = load(project);
    var result = fn(data);
    save(project, data);
    return result;
  });
}

// ---------------------------------------------------------------- notes (pure functions on data)

function now() { return new Date().toISOString(); }

function newId(data) {
  for (;;) {
    var id = crypto.randomBytes(3).toString('hex');
    if (/^\d+$/.test(id)) continue;                         // never looks like a number
    if (!data.notes.some(function (n) { return n.id === id; })) return id;
  }
}

function findNote(data, id) {
  id = String(id || '').trim().toLowerCase();
  if (!id) return null;
  for (var i = 0; i < data.notes.length; i++) if (data.notes[i].id === id) return data.notes[i];
  var hits = data.notes.filter(function (n) { return n.id.indexOf(id) === 0; });
  return hits.length === 1 ? hits[0] : null;
}

function touch(note, entry) {
  note.updated = now();
  if (entry) {
    entry.t = note.updated;
    note.history.push(entry);
  }
}

function addNote(data, input) {
  var text = String(input.text || '').trim();
  if (!text) throw new Error('empty-text');
  var t = now();
  var note = {
    id: newId(data),
    text: text,
    status: 'open',
    scope: SCOPES.indexOf(input.scope) >= 0 ? input.scope : 'time',
    host: input.host || '',
    target: input.target || {},
    markers: [],
    result: '',      // what Claude said it changed (last run)
    question: '',    // what Claude wants to know before it can go on
    feedback: '',    // what the user said after Claude's last run
    created: t,
    updated: t,
    history: [{ t: t, by: 'user', type: 'created', text: text }]
  };
  data.notes.push(note);
  return note;
}

// Claude changed what the note asks for.
function fixNote(data, id, summary, reviewMode) {
  var n = findNote(data, id);
  if (!n) return null;
  n.status = reviewMode === 'auto' ? 'done' : 'review';
  n.result = String(summary || '').trim();
  n.question = '';
  n.feedback = '';
  touch(n, { by: 'claude', type: 'fixed', text: n.result });
  return n;
}

// Claude could not do it or needs to know something first.
function askNote(data, id, question) {
  var n = findNote(data, id);
  if (!n) return null;
  n.status = 'question';
  n.question = String(question || '').trim();
  n.feedback = '';
  touch(n, { by: 'claude', type: 'question', text: n.question });
  return n;
}

// The user ticked the note off.
function acceptNote(data, id) {
  var n = findNote(data, id);
  if (!n) return null;
  n.status = 'done';
  n.question = '';
  touch(n, { by: 'user', type: 'accepted', text: '' });
  return n;
}

// The user is not happy yet, or answers a question: back to open. The note keeps
// its text; the new words are the next line of the thread (note.feedback).
function reopenNote(data, id, text) {
  var n = findNote(data, id);
  if (!n) return null;
  text = String(text || '').trim();
  var type = n.status === 'question' ? 'answered' : 'reopened';
  n.status = 'open';
  n.question = '';
  n.feedback = text;
  touch(n, { by: 'user', type: type, text: text });
  return n;
}

function editNote(data, id, text) {
  var n = findNote(data, id);
  text = String(text || '').trim();
  if (!n || !text) return null;
  if (text === n.text) return n;
  n.text = text;
  touch(n, { by: 'user', type: 'edited', text: text });
  return n;
}

function removeNote(data, id) {
  var n = findNote(data, id);
  if (!n) return null;
  data.notes.splice(data.notes.indexOf(n), 1);
  return n;
}

function clearDone(data) {
  var gone = data.notes.filter(function (n) { return n.status === 'done'; });
  data.notes = data.notes.filter(function (n) { return n.status !== 'done'; });
  return gone;
}

function counts(data) {
  var c = { open: 0, question: 0, review: 0, done: 0, total: data.notes.length };
  data.notes.forEach(function (n) { if (c[n.status] !== undefined) c[n.status]++; });
  return c;
}

// Notes in the order of the timeline: container, then time.
function sortNotes(notes) {
  return notes.slice().sort(function (a, b) {
    var ca = (a.target && a.target.container && a.target.container.name) || '';
    var cb = (b.target && b.target.container && b.target.container.name) || '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    var ta = (a.target && a.target.time) || 0;
    var tb = (b.target && b.target.time) || 0;
    if (ta !== tb) return ta - tb;
    return a.created < b.created ? -1 : 1;
  });
}

// ---------------------------------------------------------------- text helpers

function short(text, max) {
  var s = String(text || '').replace(/\s+/g, ' ').trim();
  max = max || 60;
  return s.length > max ? s.slice(0, max - 1).replace(/\s+$/, '') + '…' : s;
}

// Simple timecode HH:MM:SS:FF, only used when the host gave none.
function timecode(seconds, fps) {
  var f = Math.round(fps) || 25;
  var total = Math.max(0, Math.round((Number(seconds) || 0) * (Number(fps) || 25)));
  var p = function (n) { return n < 10 ? '0' + n : String(n); };
  var s = Math.floor(total / f);
  return p(Math.floor(s / 3600)) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60) + ':' + p(total % f);
}

module.exports = {
  APP: APP, STATUSES: STATUSES, SCOPES: SCOPES, DEFAULT_SETTINGS: DEFAULT_SETTINGS, IS_WIN: IS_WIN,
  appDataDir: appDataDir, mkdirp: mkdirp, readJSON: readJSON, writeJSON: writeJSON, mtime: mtime,
  settingsFile: settingsFile, loadSettings: loadSettings, saveSettings: saveSettings,
  projectKey: projectKey, projectFile: projectFile, emptyData: emptyData, load: load, save: save, update: update,
  findNote: findNote, addNote: addNote, fixNote: fixNote, askNote: askNote, acceptNote: acceptNote,
  reopenNote: reopenNote, editNote: editNote, removeNote: removeNote, clearDone: clearDone,
  counts: counts, sortNotes: sortNotes, short: short, timecode: timecode
};
