// WatchTimeline test: notes, actions, the bridge and the skill's command line,
// against a stand-in host (tests/fake-host.js). No Adobe app needed.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFile } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtimeline-test-'));
process.env.WATCHTIMELINE_HOME = path.join(TMP, 'home');

const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'lib', 'store.js'));
const { createActions, jsxString } = require(path.join(ROOT, 'lib', 'actions.js'));
const { createBridge } = require(path.join(ROOT, 'lib', 'bridge.js'));
const i18n = require(path.join(ROOT, 'lib', 'i18n.js'));
const { createHost } = require('./fake-host.js');
const WT = path.join(ROOT, 'skill', 'watch-timeline', 'scripts', 'wt.js');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [WT].concat(args), { env: Object.assign({}, process.env) }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout, err: stderr });
    });
  });
}

function setup(kind) {
  const host = createHost(kind || 'PPRO');
  const actions = createActions({ store, evalScript: host.evalScript, host: kind || 'PPRO' });
  const project = { path: host.state.project.path, name: host.state.project.name, host: kind || 'PPRO' };
  try { fs.unlinkSync(store.projectFile(project)); } catch (e) {}
  store.saveSettings({ reviewMode: 'manual', markers: true });
  return { host, actions, project };
}

// ---------------------------------------------------------------- store

test('settings: defaults and saving', () => {
  const s = store.loadSettings();
  assert.strictEqual(s.reviewMode, 'manual');
  assert.strictEqual(s.markers, true);
  store.saveSettings({ reviewMode: 'auto', language: 'de' });
  assert.strictEqual(store.loadSettings().reviewMode, 'auto');
  assert.strictEqual(store.loadSettings().language, 'de');
  assert.strictEqual(store.loadSettings().markers, true);
  store.saveSettings({ reviewMode: 'nonsense' });
  assert.strictEqual(store.loadSettings().reviewMode, 'manual');
});

test('project files: one per project, outside the project folder', () => {
  const a = store.projectFile({ path: '/Users/x/Film/Film.prproj', host: 'PPRO' });
  const b = store.projectFile({ path: '/Users/x/Other/Film.prproj', host: 'PPRO' });
  assert.notStrictEqual(a, b);
  assert.ok(a.indexOf(process.env.WATCHTIMELINE_HOME) === 0);
  assert.ok(/Film-[0-9a-f]{10}\.json$/.test(a));
  assert.ok(/unsaved-AEFT-[0-9a-f]{10}\.json$/.test(store.projectFile({ path: '', host: 'AEFT' })));
  // Windows paths: case does not matter.
  assert.strictEqual(store.projectKey({ path: 'C:\\Film\\A.aep' }), store.projectKey({ path: 'c:/film/a.aep' }));
});

test('note life cycle: open → review → reopened → review → done', () => {
  const d = store.emptyData({ path: '/p.prproj' });
  const n = store.addNote(d, { text: '  Make it brighter ', scope: 'time', host: 'PPRO', target: { time: 3 } });
  assert.strictEqual(n.text, 'Make it brighter');
  assert.strictEqual(n.status, 'open');
  assert.ok(/^[0-9a-f]{6}$/.test(n.id) && !/^\d+$/.test(n.id));
  assert.throws(() => store.addNote(d, { text: '   ' }));

  store.fixNote(d, n.id, 'Exposure +0.5', 'manual');
  assert.strictEqual(n.status, 'review');
  assert.strictEqual(n.result, 'Exposure +0.5');

  store.reopenNote(d, n.id, 'even brighter');
  assert.strictEqual(n.status, 'open');
  assert.strictEqual(n.text, 'Make it brighter');          // the first words stay
  assert.strictEqual(n.feedback, 'even brighter');

  store.fixNote(d, n.id, 'Exposure +1.0', 'manual');
  assert.strictEqual(n.feedback, '');
  store.acceptNote(d, n.id);
  assert.strictEqual(n.status, 'done');
  assert.deepStrictEqual(n.history.map((h) => h.by + ':' + h.type),
    ['user:created', 'claude:fixed', 'user:reopened', 'claude:fixed', 'user:accepted']);
  assert.deepStrictEqual(store.counts(d), { open: 0, question: 0, review: 0, done: 1, total: 1 });
  assert.strictEqual(store.clearDone(d).length, 1);
  assert.strictEqual(d.notes.length, 0);
});

test('automatic mode, questions, edit, remove, id prefix', () => {
  const d = store.emptyData({ path: '/p.prproj' });
  const a = store.addNote(d, { text: 'one', target: { time: 9, container: { name: 'B' } } });
  const b = store.addNote(d, { text: 'two', target: { time: 2, container: { name: 'B' } } });
  const c = store.addNote(d, { text: 'three', target: { time: 5, container: { name: 'A' } } });
  assert.deepStrictEqual(store.sortNotes(d.notes).map((n) => n.text), ['three', 'two', 'one']);

  store.fixNote(d, a.id, 'did it', 'auto');
  assert.strictEqual(a.status, 'done');

  store.askNote(d, b.id, 'Which clip?');
  assert.strictEqual(b.status, 'question');
  assert.strictEqual(b.question, 'Which clip?');
  store.reopenNote(d, b.id, 'the second one');
  assert.strictEqual(b.status, 'open');
  assert.strictEqual(b.question, '');
  assert.strictEqual(b.history[b.history.length - 1].type, 'answered');

  store.editNote(d, c.id, 'three!');
  assert.strictEqual(c.text, 'three!');
  assert.strictEqual(store.findNote(d, c.id.slice(0, 4)), c);
  assert.strictEqual(store.findNote(d, 'zzzzzz'), null);
  assert.strictEqual(store.findNote(d, ''), null);
  store.removeNote(d, c.id);
  assert.strictEqual(d.notes.length, 2);
});

test('texts: both languages have the same keys', () => {
  const de = Object.keys(i18n.DICTS.de).sort();
  const en = Object.keys(i18n.DICTS.en).sort();
  assert.deepStrictEqual(de, en);
  assert.strictEqual(i18n.t('de', 'scopeWhole', {}, 'AEFT'), 'Ganze Komposition');
  assert.strictEqual(i18n.t('de', 'scopeWhole', {}, 'PPRO'), 'Ganze Sequenz');
  assert.strictEqual(i18n.t('en', 'claudeWaiting', { n: 1 }), '1 note is waiting for Claude');
  assert.strictEqual(i18n.t('en', 'descSelection', { n: 2, items: 'a, b' }, 'AEFT'), 'Only 2 layers: a, b');
});

test('jsxString survives two rounds of parsing', () => {
  const value = { t: 'Grüße „x“ \u2028 😀', p: 'C:\\a\\b', q: 'say "hi"\nnew' };
  const lit = jsxString(value);
  assert.ok(/^[\x20-\x7e]*$/.test(lit));
  assert.deepStrictEqual(JSON.parse(JSON.parse(lit)), value);
});

// ---------------------------------------------------------------- actions

test('add: note at the playhead with a marker', async () => {
  const { host, actions, project } = setup();
  const r = await actions.add('Cut this shorter', 'time');
  assert.ok(r.note && !r.error);
  assert.strictEqual(r.note.scope, 'time');
  assert.strictEqual(r.note.target.timecode, '00:00:12:10');
  assert.strictEqual(r.note.target.container.name, 'Cut 1');
  assert.strictEqual(host.state.markers.length, 1);
  assert.strictEqual(host.state.markers[0].name, 'WT: Cut this shorter');
  assert.strictEqual(host.state.markers[0].color, 3);
  const saved = store.load(project).notes[0];
  assert.strictEqual(saved.markers[0].guid, 'g-' + saved.id);
});

test('add: selection, whole, and nothing selected', async () => {
  const { host, actions, project } = setup();
  assert.strictEqual((await actions.add('x', 'selection')).error, 'no-selection');
  assert.strictEqual((await actions.add('   ', 'time')).error, 'empty-text');
  host.state.selection = [{ kind: 'clip', name: 'Interview.mp4', track: 'V1', nodeId: 'n1', start: 20, end: 30 }];
  const r = await actions.add('Louder', 'selection');
  assert.strictEqual(r.note.scope, 'selection');
  assert.strictEqual(r.note.target.items[0].name, 'Interview.mp4');
  assert.strictEqual(r.note.target.time, 20);             // playhead was outside the clip
  const w = await actions.add('Colour', 'whole');
  assert.strictEqual(w.note.target.end, 60);
  assert.strictEqual(store.load(project).notes.length, 2);
});

test('add: without markers when the setting is off', async () => {
  const { host, actions } = setup();
  store.saveSettings({ markers: false });
  const r = await actions.add('No marker please', 'time');
  assert.ok(r.note);
  assert.strictEqual(host.state.markers.length, 0);
});

test('resolve (manual): note goes to review, marker turns green; accept removes it', async () => {
  const { host, actions, project } = setup('AEFT');
  const { note } = await actions.add('Titel größer', 'time');
  assert.strictEqual(host.state.markers[0].color, 11);
  let r = await actions.resolve(project, note.id, 'Skalierung 120 %');
  assert.strictEqual(r.note.status, 'review');
  assert.strictEqual(host.state.markers[0].color, 9);
  assert.ok(host.state.markers[0].name.indexOf('\u2713 WT: ') === 0);
  assert.ok(host.state.markers[0].comment.indexOf('Claude: Skalierung 120 %') > 0);

  r = await actions.reopen(project, note.id, 'noch größer');
  assert.strictEqual(r.note.status, 'open');
  assert.strictEqual(host.state.markers[0].color, 11);
  assert.ok(host.state.markers[0].comment.indexOf('noch größer') > 0);

  await actions.resolve(project, note.id, 'Skalierung 140 %');
  r = await actions.accept(project, note.id);
  assert.strictEqual(r.note.status, 'done');
  assert.strictEqual(host.state.markers.length, 0);
  assert.deepStrictEqual(store.load(project).notes[0].markers, []);
});

test('resolve (automatic): note is done at once and its marker is gone', async () => {
  const { host, actions, project } = setup();
  store.saveSettings({ reviewMode: 'auto' });
  const { note } = await actions.add('Remove the gap', 'time');
  const r = await actions.resolve(project, note.id, 'Gap closed');
  assert.strictEqual(r.note.status, 'done');
  assert.strictEqual(host.state.markers.length, 0);
});

test('ask, edit, remove, jump, clearDone', async () => {
  const { host, actions, project } = setup();
  const a = (await actions.add('Fix it', 'time')).note;
  let r = await actions.ask(project, a.id, 'Fix what exactly?');
  assert.strictEqual(r.note.status, 'question');
  assert.strictEqual(host.state.markers[0].color, 4);
  r = await actions.edit(project, a.id, 'Fix the audio pop');
  assert.strictEqual(host.state.markers[0].name, '? WT: Fix the audio pop');

  host.state.time = 40;
  r = await actions.jump(project, a.id);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(host.state.time, 12.4);
  assert.strictEqual((await actions.jump(project, 'nope')).error, 'note-missing');

  r = await actions.remove(project, a.id);
  assert.strictEqual(store.load(project).notes.length, 0);
  assert.strictEqual(host.state.markers.length, 0);
  assert.strictEqual((await actions.accept(project, a.id)).error, 'note-missing');

  const b = (await actions.add('Another', 'time')).note;
  await actions.resolve(project, b.id, 'ok');
  await actions.accept(project, b.id);
  assert.strictEqual((await actions.clearDone(project)).removed, 1);
});

test('host errors come back as errors, not exceptions', async () => {
  const { host, actions } = setup();
  host.state.fail = 'evalscript';
  assert.strictEqual((await actions.add('x', 'time')).error, 'host-failed');
  assert.strictEqual((await actions.context()).error, 'host-failed');
});

// ---------------------------------------------------------------- bridge + command line

test('command line: says so when no app runs', async () => {
  fs.rmSync(path.join(process.env.WATCHTIMELINE_HOME, 'bridge'), { recursive: true, force: true });
  const r = await cli(['notes']);
  assert.strictEqual(r.code, 2);
  assert.ok(/does not answer/.test(r.err));
  const s = await cli(['status']);
  assert.strictEqual(s.code, 2);
  assert.strictEqual(JSON.parse(s.err).error, 'not-running');
});

test('bridge + command line: the whole round trip', async () => {
  const { host, actions, project } = setup();
  const changes = [];
  const bridge = createBridge({ store, actions, host: 'PPRO', hostVersion: '26.0', hostName: 'Premiere Pro', role: 'background', version: '1.0.0', onChange: (c) => changes.push(c) });
  bridge.start();
  try {
    host.state.selection = [{ kind: 'clip', name: 'Interview.mp4', track: 'V1', nodeId: 'n1', start: 10, end: 30 }];
    const a = (await actions.add('Mach den Clip lauter', 'selection')).note;
    host.state.selection = [];
    host.state.time = 44;
    const b = (await actions.add('Hier ein Schnitt', 'time')).note;

    let r = await cli(['status']);
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(/Premiere Pro 26\.0/.test(r.out));
    assert.ok(/Notes: 2 open/.test(r.out));
    assert.ok(/manual/.test(r.out));

    r = await cli(['notes']);
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(r.out.indexOf('[' + a.id + '] OPEN') >= 0);
    assert.ok(/ONLY clip "Interview\.mp4" on V1/.test(r.out));
    assert.ok(/ONLY the spot at 00:00:44:00/.test(r.out));
    assert.ok(r.out.indexOf('Mach den Clip lauter') >= 0);

    r = await cli(['notes', '--json']);
    const json = JSON.parse(r.out);
    assert.strictEqual(json.notes.length, 2);
    assert.strictEqual(json.reviewMode, 'manual');
    assert.strictEqual(json.notes[0].markers, undefined);       // internal fields stay inside

    r = await cli(['inspect', a.id]);
    assert.strictEqual(JSON.parse(r.out).clips[0].isTarget, true);
    r = await cli(['inspect', '--here']);
    assert.strictEqual(JSON.parse(r.out).scope, 'time');

    r = await cli(['frame', b.id]);
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(fs.existsSync(r.out.trim()), r.out);
    assert.ok(/\.png$/.test(r.out.trim()));

    r = await cli(['eval', '--code', '(function () { return { n: 1 + 2 }; })();', '--note', a.id]);
    assert.deepStrictEqual(JSON.parse(r.out), { ok: true, value: { n: 3 } });
    assert.strictEqual(host.state.evals[0].undo, 'WatchTimeline ' + a.id);
    const script = path.join(TMP, 'x.jsx');
    fs.writeFileSync(script, 'throw new Error("boom")');
    r = await cli(['eval', script]);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(JSON.parse(r.err).error, 'script-error');
    assert.ok(/boom/.test(JSON.parse(r.err).detail));

    r = await cli(['done', a.id, '--summary', 'Lautstärke +6 dB']);
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(/to check/.test(r.out));
    assert.strictEqual(store.findNote(store.load(project), a.id).status, 'review');
    assert.deepStrictEqual(changes, ['done']);

    r = await cli(['ask', b.id, '--question=Schnitt auf allen Spuren?']);
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(store.findNote(store.load(project), b.id).question, 'Schnitt auf allen Spuren?');

    r = await cli(['notes']);
    assert.ok(/No open notes/.test(r.out));
    assert.ok(/1 wait for the user's check, 1 for an answer/.test(r.out));

    // The user answers; the note is open again and shows its thread.
    await actions.reopen(project, b.id, 'Nur Video');
    r = await cli(['notes']);
    assert.ok(/Thread so far:\n/.test(r.out));                    // a question changed nothing
    assert.ok(/Claude asked: Schnitt auf allen Spuren\?/.test(r.out));
    assert.ok(/User answered: Nur Video/.test(r.out));

    store.saveSettings({ reviewMode: 'auto' });
    r = await cli(['done', b.id, '--summary', 'Schnitt gesetzt']);
    assert.ok(/done \(removed/.test(r.out));

    r = await cli(['done', 'ffffff', '--summary', 'x']);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(JSON.parse(r.err).error, 'note-missing');
    r = await cli(['done', a.id]);
    assert.strictEqual(JSON.parse(r.err).error, 'usage');
    r = await cli(['jump', a.id]);
    assert.strictEqual(JSON.parse(r.out).ok, true);
  } finally {
    bridge.stop();
  }
});

test('two apps at once: notes of both, a note id finds its app', async () => {
  const pp = setup('PPRO');
  const ae = setup('AEFT');
  const b1 = createBridge({ store, actions: pp.actions, host: 'PPRO', hostVersion: '26.0', hostName: 'Premiere Pro', role: 'background', version: '1.0.0' });
  const b2 = createBridge({ store, actions: ae.actions, host: 'AEFT', hostVersion: '26.0', hostName: 'After Effects', role: 'background', version: '1.0.0' });
  b1.start(); b2.start();
  try {
    const a = (await pp.actions.add('in premiere', 'time')).note;
    const b = (await ae.actions.add('in after effects', 'time')).note;
    let r = await cli(['notes']);
    assert.ok(/in premiere/.test(r.out) && /in after effects/.test(r.out));
    assert.ok(/\[this app: --host ae\]/.test(r.out));
    r = await cli(['notes', '--host', 'ae']);
    assert.ok(!/in premiere/.test(r.out) && /in after effects/.test(r.out));
    r = await cli(['done', b.id, '--summary', 'ok']);
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(store.findNote(store.load(ae.project), b.id).status, 'review');
    assert.strictEqual(store.findNote(store.load(pp.project), a.id).status, 'open');
    r = await cli(['inspect', '--here']);
    assert.strictEqual(JSON.parse(r.err).error, 'usage');
  } finally {
    b1.stop(); b2.stop();
  }
});

test('two servers on one queue: every request is answered once', async () => {
  const { actions } = setup();
  const mk = (role) => createBridge({ store, actions, host: 'PPRO', hostVersion: '26.0', hostName: 'Premiere Pro', role, version: '1.0.0' });
  const b1 = mk('background');
  const b2 = mk('panel');
  b1.start(); b2.start();
  try {
    assert.strictEqual(b2.otherAlive('background'), true);
    const rs = await Promise.all([cli(['status']), cli(['status']), cli(['status']), cli(['notes'])]);
    rs.forEach((r) => assert.strictEqual(r.code, 0, r.err));
  } finally {
    b1.stop(); b2.stop();
  }
  assert.strictEqual(b2.otherAlive('background'), false);
});

test('a bridge left over from a reloaded page is stopped by the new one', async () => {
  const { actions } = setup();
  const mk = () => createBridge({ store, actions, host: 'PPRO', hostVersion: '26.0', hostName: 'Premiere Pro', role: 'background', version: '1.0.0' });
  const old = mk();
  old.start();
  const fresh = mk();
  fresh.start();
  try {
    assert.strictEqual(old.isRunning(), false);
    assert.strictEqual(fresh.isRunning(), true);
    const r = await cli(['status']);
    assert.strictEqual(r.code, 0, r.err);
  } finally {
    fresh.stop();
    old.stop();
  }
});

test('frames of 32-bit After Effects projects are brightened to a normal picture', () => {
  const png = require(path.join(ROOT, 'lib', 'png.js'));
  const zlib = require('zlib');
  // 2 x 1 pixels, 16-bit RGBA: white at a tenth of the range, and a mid grey.
  const px = (v) => { const b = Buffer.alloc(8); [v, v, v, 65535].forEach((x, i) => b.writeUInt16BE(x, i * 2)); return b; };
  const raw = Buffer.concat([Buffer.from([0]), px(6553), px(3277)]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 16; ihdr[9] = 6;
  const file = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), png.chunk('IHDR', ihdr), png.chunk('IDAT', zlib.deflateSync(raw)), png.chunk('IEND', Buffer.alloc(0))]);
  const img = png.decode(file);
  assert.strictEqual(img.bitDepth, 16);
  const out = png.decode(png.scaleBuffer(file, 10));
  assert.strictEqual(out.bitDepth, 8);
  assert.deepStrictEqual([...out.data], [255, 255, 255, 255, 128, 128, 128, 255]);
  assert.throws(() => png.decode(Buffer.from('not a png file')));
});

// ---------------------------------------------------------------- run

(async () => {
  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok  ' + name);
    } catch (e) {
      failures++;
      console.log('FAIL  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n      '));
    }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log(failures ? '\n' + failures + ' test(s) failed' : '\nAll ' + tests.length + ' tests passed');
  process.exit(failures ? 1 : 0);
})();
