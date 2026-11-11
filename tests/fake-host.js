// WatchTimeline tests: a stand-in for Premiere Pro / After Effects.
// createHost() returns { evalScript, state }: evalScript runs the calls the
// extension sends (wt_context("…"), wt_capture("…"), …) against a small model.
'use strict';

function createHost(kind) {
  const isAE = kind === 'AEFT';
  const state = {
    project: { path: isAE ? '/tmp/Film/Film.aep' : '/tmp/Film/Film.prproj', name: isAE ? 'Film.aep' : 'Film.prproj' },
    container: isAE ? { type: 'comp', name: 'Main', id: '12' } : { type: 'sequence', name: 'Cut 1', id: 'seq-1' },
    time: 12.4,
    fps: 25,
    duration: 60,
    selection: [],
    markers: [],      // { id, name, comment, color, time, where }
    jumps: [],
    evals: [],
    frames: [],
    fail: null        // set to an error key to make every call fail
  };

  const tc = (s) => {
    const total = Math.round(s * state.fps);
    const p = (n) => (n < 10 ? '0' + n : String(n));
    const sec = Math.floor(total / state.fps);
    return p(Math.floor(sec / 3600)) + ':' + p(Math.floor(sec / 60) % 60) + ':' + p(sec % 60) + ':' + p(total % state.fps);
  };

  const api = {
    wt_ping: () => '1.0.1',
    wt_context: () => ({
      host: kind, project: state.project, container: state.container, time: state.time, ticks: String(Math.round(state.time * 254016000000)),
      timecode: state.container ? tc(state.time) : '', fps: state.fps, duration: state.duration, selection: state.selection
    }),
    wt_capture: (a) => {
      if (!state.project) return { error: 'no-project' };
      if (!state.container) return { error: 'no-container' };
      const scope = a && (a.scope === 'selection' || a.scope === 'whole') ? a.scope : 'time';
      const t = { container: state.container, time: state.time, fps: state.fps, start: state.time, end: state.time, items: [] };
      if (scope === 'selection') {
        if (!state.selection.length) return { error: 'no-selection' };
        t.items = state.selection.map((s) => Object.assign({}, s));
        t.start = Math.min.apply(null, t.items.map((i) => i.start));
        t.end = Math.max.apply(null, t.items.map((i) => i.end));
        if (t.time < t.start || t.time > t.end) t.time = t.start;
      } else if (scope === 'whole') { t.start = 0; t.end = state.duration; }
      t.timecode = tc(t.time); t.startTimecode = tc(t.start); t.endTimecode = tc(t.end);
      return { host: kind, project: state.project, scope, target: t };
    },
    wt_markerAdd: (a) => {
      const m = { id: a.id, name: a.name, comment: a.comment, color: a.color, time: a.scope === 'selection' ? a.start : a.time, where: 'sequence', guid: 'g-' + a.id };
      state.markers.push(m);
      return { markers: [{ where: m.where, guid: m.guid, time: m.time }] };
    },
    wt_markerUpdate: (a) => {
      const hits = state.markers.filter((m) => m.id === a.id);
      hits.forEach((m) => { m.name = a.name; m.comment = a.comment; m.color = a.color; });
      return { updated: hits.length };
    },
    wt_markerRemove: (a) => {
      const before = state.markers.length;
      state.markers = state.markers.filter((m) => m.id !== a.id);
      return { removed: before - state.markers.length };
    },
    wt_jump: (a) => {
      if (!a.container || a.container.id !== state.container.id) return { error: 'container-missing' };
      state.jumps.push(a);
      state.time = a.time;
      return { ok: true, selected: (a.items || []).length, missing: 0 };
    },
    wt_inspect: (a) => ({ host: kind, scope: a.scope, time: a.time, clips: [{ name: 'A.mp4', isTarget: (a.items || []).length > 0 }] }),
    wt_frame: (a) => {
      state.frames.push(a);
      require('fs').writeFileSync(a.path + '.png', 'PNG');
      return { ok: true, path: a.path + '.png' };
    },
    wt_run: (a) => {
      const code = require('fs').readFileSync(a.file, 'utf8');
      state.evals.push({ code, undo: a.undo });
      try { return { ok: true, value: eval(code) }; } catch (e) { return { error: 'script-error', detail: e.message, line: 1 }; }   // eslint-disable-line no-eval
    }
  };

  // The extension sends: name("<json as a string literal>")
  function evalScript(code) {
    const m = /^(\w+)\((.*)\)$/s.exec(code);
    return new Promise((resolve) => {
      setTimeout(() => {
        if (state.fail === 'evalscript') return resolve('EvalScript error.');
        if (!m || !api[m[1]]) return resolve('EvalScript error.');
        const arg = m[2] ? JSON.parse(JSON.parse(m[2])) : null;
        const r = state.fail ? { error: state.fail } : api[m[1]](arg);
        resolve(typeof r === 'string' ? r : JSON.stringify(r));
      }, 1);
    });
  }

  return { evalScript, state, tc };
}

module.exports = { createHost };
