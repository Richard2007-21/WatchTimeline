// WatchTimeline test: installing the Claude skill (lib/skill.js) and the skill folder itself.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtimeline-skill-test-'));
process.env.WATCHTIMELINE_SKILL_DIR = path.join(TMP, 'claude', 'skills', 'watch-timeline');
const skill = require(path.join(ROOT, 'lib', 'skill.js'));
const upd = require(path.join(ROOT, 'lib', 'update.js'));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 5).join('\n      ')); }
}

// A copy of the extension with only what the installer needs.
function fakeExtension(version) {
  const ext = fs.mkdtempSync(path.join(TMP, 'ext-'));
  const dir = path.join(ext, 'skill', 'watch-timeline', 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(ext, 'skill', 'watch-timeline', 'SKILL.md'), '---\nname: watch-timeline\ndescription: x\n---\n');
  fs.writeFileSync(path.join(ext, 'skill', 'watch-timeline', 'VERSION'), version + '\n');
  fs.writeFileSync(path.join(dir, 'wt.js'), '// ' + version);
  return ext;
}

test('the skill in this repository is complete and matches the extension version', () => {
  const dir = skill.sourceDir(ROOT);
  const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.ok(/^---\nname: watch-timeline\ndescription: .{80,}\n---\n/.test(md), 'front matter');
  assert.ok(md.split('\n').length < 500, 'SKILL.md stays short');
  ['scripts/wt.js', 'references/premiere.md', 'references/after-effects.md', 'VERSION'].forEach((f) => {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  });
  // Every file the skill text links to exists.
  (md.match(/\]\(([^)#]+)\)/g) || []).forEach((m) => {
    const rel = m.slice(2, -1);
    if (!/^https?:/.test(rel)) assert.ok(fs.existsSync(path.join(dir, rel)), rel);
  });
  assert.strictEqual(skill.readVersion(dir), upd.readVersion(ROOT));
  assert.strictEqual(require(path.join(ROOT, 'package.json')).version, upd.readVersion(ROOT));
  // The host scripts and the panel agree on the version of the host functions.
  const hostApi = /WT_HOST_API = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'host', 'host_common.jsx'), 'utf8'))[1];
  const panelApi = /HOST_API = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'client', 'common.js'), 'utf8'))[1];
  assert.strictEqual(hostApi, panelApi);
});

test('the host scripts are plain ASCII code (ExtendScript reads them in the system encoding)', () => {
  ['host.jsx', 'host_common.jsx', 'host_ppro.jsx', 'host_aeft.jsx'].forEach((f) => {
    const lines = fs.readFileSync(path.join(ROOT, 'host', f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) return;
      const code = line.split('//')[0];
      assert.ok(/^[\x00-\x7f]*$/.test(code), f + ':' + (i + 1) + ' ' + line);
    });
  });
});

test('install, same version, newer version', () => {
  const ext = fakeExtension('1.0.0');
  assert.strictEqual(skill.status(ext).state, 'none');
  let st = skill.install(ext);
  assert.strictEqual(st.state, 'ok');
  assert.strictEqual(st.have, '1.0.0');
  assert.ok(fs.existsSync(path.join(skill.targetDir(), 'scripts', 'wt.js')));

  const newer = fakeExtension('1.1.0');
  st = skill.status(newer);
  assert.strictEqual(st.state, 'old');
  assert.strictEqual(st.have, '1.0.0');
  assert.strictEqual(st.version, '1.1.0');
  fs.writeFileSync(path.join(skill.targetDir(), 'leftover.txt'), 'old');
  st = skill.install(newer);
  assert.strictEqual(st.state, 'ok');
  assert.strictEqual(st.have, '1.1.0');
  assert.ok(!fs.existsSync(path.join(skill.targetDir(), 'leftover.txt')), 'old files are gone');
  assert.strictEqual(fs.readFileSync(path.join(skill.targetDir(), 'scripts', 'wt.js'), 'utf8'), '// 1.1.0');
});

test('a link or a foreign folder is never replaced', () => {
  const ext = fakeExtension('1.0.0');
  const dst = skill.targetDir();
  fs.rmSync(dst, { recursive: true, force: true });
  fs.symlinkSync(skill.sourceDir(ext), dst);
  assert.strictEqual(skill.status(ext).state, 'dev');
  assert.strictEqual(skill.install(ext).state, 'dev');
  assert.ok(fs.lstatSync(dst).isSymbolicLink());
  fs.unlinkSync(dst);

  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, 'SKILL.md'), '---\nname: something-else\n---\n');
  assert.strictEqual(skill.status(ext).state, 'foreign');
  assert.throws(() => skill.install(ext));
  assert.ok(/something-else/.test(fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8')));
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
console.log(failures ? '\n' + failures + ' test(s) failed' : '\nskill tests passed');
process.exit(failures ? 1 : 0);
