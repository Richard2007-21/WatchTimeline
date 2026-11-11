/*
 * WatchTimeline – everything that touches both the notes and the host
 * (Premiere Pro or After Effects). Used by the panel and by the bridge.
 *
 *   createActions({ store, evalScript, host })
 *
 * evalScript(code) → Promise<string> runs ExtendScript in the host.
 * Every action returns a Promise. Problems come back as { error: 'key' }.
 */
'use strict';

// Marker colours. Premiere: setColorByIndex · After Effects: label index.
var MARKER_COLORS = {
  PPRO: { open: 3, question: 4, review: 0 },   // orange, yellow, green
  AEFT: { open: 11, question: 2, review: 9 }   // orange, yellow, green
};

// A string literal ExtendScript (ES3) can read. The JSON inside is plain
// ASCII: every other character is written as \\uXXXX, so line separators and
// umlauts survive the two rounds of parsing (literal, then wt_parse).
function jsxString(value) {
  var json = JSON.stringify(value === undefined ? null : value)
    .replace(/[\u007f-\uffff]/g, function (c) {
      return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
  return JSON.stringify(json);
}

function createActions(opts) {
  var store = opts.store;
  var evalScript = opts.evalScript;
  var host = opts.host || 'PPRO';

  // Calls a function of host/*.jsx with one JSON argument.
  function call(fn, arg) {
    return evalScript(fn + '(' + jsxString(arg) + ')').then(function (r) {
      if (typeof r !== 'string' || r === '' || r === 'undefined' || r.indexOf('EvalScript error') === 0) {
        return { error: 'host-failed', detail: String(r) };
      }
      try { return JSON.parse(r); } catch (e) { return { error: 'host-failed', detail: r.slice(0, 300) }; }
    }, function (e) {
      return { error: 'host-failed', detail: String(e && e.message || e) };
    });
  }

  function projectOf(ctx) {
    var p = (ctx && ctx.project) || null;
    if (!p) return null;
    return { path: p.path || '', name: p.name || '', host: host };
  }

  function context() { return call('wt_context'); }

  function markerSpec(note) {
    var prefix = note.status === 'review' ? '✓ ' : (note.status === 'question' ? '? ' : '');
    var colors = MARKER_COLORS[host] || MARKER_COLORS.PPRO;
    var comment = note.text;
    if (note.status === 'open' && note.feedback) comment += '\n\n' + note.feedback;
    if (note.status === 'review' && note.result) comment += '\n\nClaude: ' + note.result;
    if (note.status === 'question' && note.question) comment += '\n\nClaude: ' + note.question;
    return {
      id: note.id,
      name: prefix + 'WT: ' + store.short(note.text, 70),
      comment: comment,
      color: colors[note.status] === undefined ? colors.open : colors[note.status]
    };
  }

  function markerArgs(note) {
    var t = note.target || {};
    var a = markerSpec(note);
    a.container = t.container || null;
    a.scope = note.scope;
    a.time = t.time || 0;
    a.start = t.start === undefined ? a.time : t.start;
    a.end = t.end === undefined ? a.time : t.end;
    a.items = t.items || [];
    a.markers = note.markers || [];
    return a;
  }

  // Shows the state of the note on its marker. Never fails the action itself.
  function syncMarker(note, removed) {
    if (!note || !note.target || !note.target.container) return Promise.resolve();
    if (removed || note.status === 'done') {
      if (!note.markers || !note.markers.length) return Promise.resolve();
      return call('wt_markerRemove', markerArgs(note));
    }
    if (!note.markers || !note.markers.length) return Promise.resolve();
    return call('wt_markerUpdate', markerArgs(note));
  }

  // ---- used by the panel

  function list(project) {
    return store.load(project);
  }

  // text + scope ('time' | 'selection' | 'whole') → new note at the current spot.
  function add(text, scope) {
    text = String(text || '').trim();
    if (!text) return Promise.resolve({ error: 'empty-text' });
    return call('wt_capture', { scope: scope }).then(function (cap) {
      if (cap.error) return cap;
      var project = projectOf(cap);
      if (!project) return { error: 'no-project' };
      var note = store.update(project, function (data) {
        return store.addNote(data, { text: text, scope: cap.scope || scope, host: host, target: cap.target });
      });
      if (!store.loadSettings().markers) return { note: note, project: project };
      return call('wt_markerAdd', markerArgs(note)).then(function (m) {
        if (m && m.markers && m.markers.length) {
          note = store.update(project, function (data) {
            var n = store.findNote(data, note.id);
            if (n) n.markers = m.markers;
            return n || note;
          });
        }
        return { note: note, project: project, markerError: m && m.error ? m.error : '' };
      });
    });
  }

  function change(project, id, fn, removed) {
    var note = store.update(project, function (data) { return fn(data); });
    if (!note) return Promise.resolve({ error: 'note-missing' });
    return syncMarker(note, removed).then(function () {
      if (note.status === 'done' || removed) {
        if (!removed) store.update(project, function (data) { var n = store.findNote(data, note.id); if (n) n.markers = []; });
        note.markers = [];
      }
      return { note: note };
    });
  }

  function accept(project, id) {
    return change(project, id, function (d) { return store.acceptNote(d, id); });
  }

  function reopen(project, id, text) {
    return change(project, id, function (d) { return store.reopenNote(d, id, text); });
  }

  function edit(project, id, text) {
    return change(project, id, function (d) { return store.editNote(d, id, text); });
  }

  function remove(project, id) {
    return change(project, id, function (d) { return store.removeNote(d, id); }, true);
  }

  function clearDone(project) {
    var gone = store.update(project, function (d) { return store.clearDone(d); });
    return Promise.resolve({ removed: gone.length });
  }

  // ---- used by Claude through the bridge

  function resolve(project, id, summary) {
    var mode = store.loadSettings().reviewMode;
    return change(project, id, function (d) { return store.fixNote(d, id, summary, mode); });
  }

  function ask(project, id, question) {
    return change(project, id, function (d) { return store.askNote(d, id, question); });
  }

  // ---- both

  // Moves the playhead to the note and selects its clips or layers.
  function jump(project, id) {
    var note = store.findNote(store.load(project), id);
    if (!note) return Promise.resolve({ error: 'note-missing' });
    return call('wt_jump', note.target);
  }

  return {
    call: call, context: context, projectOf: projectOf, list: list, add: add, accept: accept, reopen: reopen,
    edit: edit, remove: remove, clearDone: clearDone, resolve: resolve, ask: ask, jump: jump,
    markerSpec: markerSpec
  };
}

module.exports = { createActions: createActions, jsxString: jsxString, MARKER_COLORS: MARKER_COLORS };
