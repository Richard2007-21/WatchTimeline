/*
 * WatchTimeline – bridge between the Claude skill and the host.
 *
 * The skill cannot talk to Premiere Pro or After Effects directly. It writes
 * a request file, the extension (which runs inside the host) answers with a
 * response file. No network port is opened: only programs of the same user
 * account can reach the folder.
 *
 *   <app data>/bridge/<HOST>-<version>/
 *     alive-background.json   heartbeat, rewritten every 1.5 s
 *     in/<id>.json            request  { id, cmd, args }
 *     work/<id>.json          request that is being worked on
 *     out/<id>.json           response { id, ok, result } or { id, ok: false, error }
 *
 * createBridge({ store, actions, host, hostVersion, hostName, role, version, onChange })
 */
'use strict';

var fs = require('fs');
var path = require('path');

var HEARTBEAT_MS = 1500;
var POLL_MS = 250;
var STALE_MS = 10 * 60 * 1000;

// Bridges started in this process. CEP keeps Node.js modules and timers alive
// when a page reloads: a bridge of the old page would go on taking requests it
// can no longer answer. start() stops such leftovers.
var started = [];

function instanceName(host, hostVersion) {
  return (String(host || 'HOST') + '-' + String(hostVersion || '0')).replace(/[^A-Za-z0-9.\-]+/g, '_');
}

function bridgeRoot(store) { return path.join(store.appDataDir(), 'bridge'); }

function createBridge(opts) {
  var store = opts.store;
  var actions = opts.actions;
  var role = opts.role || 'background';
  var dir = path.join(bridgeRoot(store), instanceName(opts.host, opts.hostVersion));
  var dirs = { in: path.join(dir, 'in'), work: path.join(dir, 'work'), out: path.join(dir, 'out'), tmp: path.join(dir, 'tmp') };
  var timers = [];
  var busy = false;
  var lastProject = null;
  var running = false;

  function ensureDirs() {
    Object.keys(dirs).forEach(function (k) { store.mkdirp(dirs[k]); });
  }

  function aliveFile(r) { return path.join(dir, 'alive-' + (r || role) + '.json'); }

  function heartbeat() {
    try {
      store.writeJSON(aliveFile(), {
        t: Date.now(), role: role, pid: process.pid, host: opts.host, hostName: opts.hostName || opts.host,
        hostVersion: opts.hostVersion || '', version: opts.version || '', project: lastProject
      });
    } catch (e) {}
  }

  // Is another server (e.g. the background service) answering already?
  function otherAlive(otherRole) {
    var a = store.readJSON(aliveFile(otherRole), null);
    return !!(a && Date.now() - a.t < HEARTBEAT_MS * 4);
  }

  function cleanup() {
    ['in', 'work', 'out', 'tmp'].forEach(function (k) {
      var names = [];
      try { names = fs.readdirSync(dirs[k]); } catch (e) {}
      names.forEach(function (n) {
        var f = path.join(dirs[k], n);
        if (Date.now() - store.mtime(f) > STALE_MS) { try { fs.unlinkSync(f); } catch (e) {} }
      });
    });
  }

  // ---------------------------------------------------------------- commands

  function withProject() {
    return actions.context().then(function (ctx) {
      if (ctx.error) return { error: ctx.error, detail: ctx.detail };
      var project = actions.projectOf(ctx);
      if (!project) return { error: 'no-project' };
      lastProject = { path: project.path, name: project.name };
      return { ctx: ctx, project: project };
    });
  }

  function publicNote(n) {
    return {
      id: n.id, status: n.status, text: n.text, scope: n.scope, target: n.target,
      result: n.result || '', question: n.question || '', feedback: n.feedback || '', created: n.created, updated: n.updated,
      history: n.history
    };
  }

  function waitForFile(file, ms) {
    // The hosts write frames a moment after the call returns.
    var candidates = [file, file + '.png', file.replace(/\.png$/i, '') + '.png'];
    return new Promise(function (resolve) {
      var start = Date.now();
      var lastSize = -1;
      (function check() {
        var hit = '';
        for (var i = 0; i < candidates.length && !hit; i++) {
          try { if (fs.statSync(candidates[i]).size > 0) hit = candidates[i]; } catch (e) {}
        }
        if (hit) {
          var size = fs.statSync(hit).size;
          if (size === lastSize) return resolve(hit);
          lastSize = size;
        }
        if (Date.now() - start > ms) return resolve(hit);
        setTimeout(check, 300);
      })();
    });
  }

  var commands = {
    ping: function () {
      return withProject().then(function (p) {
        return { host: opts.host, hostName: opts.hostName, hostVersion: opts.hostVersion, version: opts.version, role: role,
          project: p.project ? { path: p.project.path, name: p.project.name } : null };
      });
    },

    context: function () {
      return withProject().then(function (p) {
        if (p.error) return p;
        var data = store.load(p.project);
        p.ctx.counts = store.counts(data);
        p.ctx.reviewMode = store.loadSettings().reviewMode;
        return p.ctx;
      });
    },

    // args.status: 'open' (default) | 'all' | any status
    notes: function (args) {
      return withProject().then(function (p) {
        if (p.error) return p;
        var data = store.load(p.project);
        var want = args.status || 'open';
        var notes = store.sortNotes(data.notes).filter(function (n) {
          return want === 'all' || n.status === want;
        });
        return {
          host: opts.host, hostName: opts.hostName, project: { path: p.project.path, name: p.project.name },
          container: p.ctx.container, counts: store.counts(data), reviewMode: store.loadSettings().reviewMode,
          notes: notes.map(publicNote)
        };
      });
    },

    note: function (args) {
      return withProject().then(function (p) {
        if (p.error) return p;
        var n = store.findNote(store.load(p.project), args.id);
        return n ? { note: publicNote(n) } : { error: 'note-missing' };
      });
    },

    // What is at the spot of the note (or at args.time in the note's sequence/comp).
    inspect: function (args) {
      return withProject().then(function (p) {
        if (p.error) return p;
        var target;
        if (args.id) {
          var n = store.findNote(store.load(p.project), args.id);
          if (!n) return { error: 'note-missing' };
          target = JSON.parse(JSON.stringify(n.target));
          target.scope = n.scope;
        } else {
          if (!p.ctx.container) return { error: 'no-container' };
          target = { container: p.ctx.container, time: p.ctx.time, start: p.ctx.time, end: p.ctx.time, items: [], scope: 'time' };
        }
        if (args.time !== undefined && args.time !== null && isFinite(Number(args.time))) {
          target.time = Number(args.time);
          delete target.ticks;
          if (target.scope === 'time') { target.start = target.time; target.end = target.time; }
        }
        if (args.all) target.all = true;
        return actions.call('wt_inspect', target);
      });
    },

    // Renders one frame as PNG, so Claude can look at the spot.
    frame: function (args) {
      return withProject().then(function (p) {
        if (p.error) return p;
        var target;
        var name = 'frame';
        if (args.id) {
          var n = store.findNote(store.load(p.project), args.id);
          if (!n) return { error: 'note-missing' };
          target = { container: n.target.container, time: n.target.time, ticks: n.target.ticks };
          name = n.id;
        } else {
          if (!p.ctx.container) return { error: 'no-container' };
          target = { container: p.ctx.container, time: p.ctx.time, ticks: p.ctx.ticks };
        }
        if (args.time !== undefined && args.time !== null && isFinite(Number(args.time))) {
          target.time = Number(args.time);
          delete target.ticks;
        }
        var out = args.out ? String(args.out) : path.join(store.appDataDir(), 'frames', name + '-' + Date.now() + '.png');
        store.mkdirp(path.dirname(out));
        target.path = out.replace(/\.png$/i, '');
        return actions.call('wt_frame', target).then(function (r) {
          if (r.error) return r;
          return waitForFile(target.path, 20000).then(function (file) {
            if (!file) return { error: 'frame-failed', detail: 'The host did not write ' + out };
            // After Effects, 32-bit project: white is a tenth of the range. Make it a normal picture.
            if (r.bpc === 32) { try { require('./png.js').scale(file, 10); } catch (e) {} }
            return { path: file, time: target.time, container: target.container };
          });
        });
      });
    },

    // Runs ExtendScript: args.file (absolute path) or args.code.
    eval: function (args, req) {
      var file = args.file ? String(args.file) : '';
      if (!file && args.code) {
        file = path.join(dirs.tmp, req.id + '.jsx');
        fs.writeFileSync(file, String(args.code));
      }
      if (!file) return Promise.resolve({ error: 'no-script' });
      if (!fs.existsSync(file)) return Promise.resolve({ error: 'script-missing', detail: file });
      return actions.call('wt_run', { file: file.replace(/\\/g, '/'), undo: args.undo === false ? '' : String(args.undo || 'WatchTimeline') });
    },

    done: function (args) {
      return withProject().then(function (p) {
        if (p.error) return p;
        return actions.resolve(p.project, args.id, args.summary).then(function (r) {
          if (r.note) r.note = publicNote(r.note);
          return r;
        });
      });
    },

    ask: function (args) {
      return withProject().then(function (p) {
        if (p.error) return p;
        return actions.ask(p.project, args.id, args.question).then(function (r) {
          if (r.note) r.note = publicNote(r.note);
          return r;
        });
      });
    },

    jump: function (args) {
      return withProject().then(function (p) {
        if (p.error) return p;
        return actions.jump(p.project, args.id);
      });
    }
  };

  // ---------------------------------------------------------------- queue

  function respond(id, body) {
    body.id = id;
    try { store.writeJSON(path.join(dirs.out, id + '.json'), body); } catch (e) {}
    try { fs.unlinkSync(path.join(dirs.work, id + '.json')); } catch (e2) {}
  }

  function handle(req) {
    var fn = commands[req.cmd];
    if (!fn) return Promise.resolve({ error: 'unknown-command', detail: String(req.cmd) });
    var p;
    try { p = Promise.resolve(fn(req.args || {}, req)); } catch (e) { p = Promise.resolve({ error: 'bridge-failed', detail: String(e && e.message || e) }); }
    return p.then(function (r) { return r; }, function (e) {
      return { error: 'bridge-failed', detail: String(e && e.message || e) };
    });
  }

  function tick() {
    if (busy || !running) return;
    var names;
    try { names = fs.readdirSync(dirs.in).filter(function (n) { return /\.json$/.test(n); }).sort(); } catch (e) { ensureDirs(); return; }
    if (!names.length) return;
    var name = names[0];
    var claimed = path.join(dirs.work, name);
    try { fs.renameSync(path.join(dirs.in, name), claimed); } catch (e2) { return; }   // another server took it
    var req = store.readJSON(claimed, null);
    var id = name.replace(/\.json$/, '');
    if (!req || !req.cmd) { respond(id, { ok: false, error: 'bad-request' }); return; }
    busy = true;
    handle(req).then(function (r) {
      busy = false;
      if (r && r.error) respond(id, { ok: false, error: r.error, detail: r.detail || '', line: r.line || 0 });
      else respond(id, { ok: true, result: r === undefined ? null : r });
      if (opts.onChange && /^(done|ask)$/.test(req.cmd)) { try { opts.onChange(req.cmd); } catch (e3) {} }
      setTimeout(tick, 0);
    });
  }

  function start() {
    if (running) return;
    started.slice().forEach(function (b) { if (b.key === key) b.stop(); });
    started.push(self);
    running = true;
    ensureDirs();
    cleanup();
    heartbeat();
    timers.push(setInterval(heartbeat, HEARTBEAT_MS));
    timers.push(setInterval(tick, POLL_MS));
    timers.push(setInterval(cleanup, 60 * 1000));
  }

  function stop() {
    var was = running;
    running = false;
    timers.forEach(clearInterval);
    timers = [];
    var i = started.indexOf(self);
    if (i >= 0) started.splice(i, 1);
    if (was) { try { fs.unlinkSync(aliveFile()); } catch (e) {} }
  }

  var key = dir + '|' + role;
  var self = {
    key: key, start: start, stop: stop, tick: tick, dir: dir, dirs: dirs, isRunning: function () { return running; },
    otherAlive: otherAlive, handle: handle, commands: commands
  };
  return self;
}

module.exports = { createBridge: createBridge, instanceName: instanceName, bridgeRoot: bridgeRoot, HEARTBEAT_MS: HEARTBEAT_MS };
