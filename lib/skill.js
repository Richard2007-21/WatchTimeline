/*
 * WatchTimeline – installs the Claude skill that comes with the extension.
 *
 * The skill lives in <extension>/skill/watch-timeline. Claude Code looks for
 * personal skills in ~/.claude/skills/<name>, so "install" copies it there.
 * Plain Node.js (CEP runs Node 8 to 17): no fs.rmSync / cpSync.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');

var NAME = 'watch-timeline';

function sourceDir(extPath) { return path.join(extPath, 'skill', NAME); }

function targetDir() {
  if (process.env.WATCHTIMELINE_SKILL_DIR) return process.env.WATCHTIMELINE_SKILL_DIR;
  return path.join(os.homedir(), '.claude', 'skills', NAME);
}

function readVersion(dir) {
  try { return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim() || null; } catch (e) { return null; }
}

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

function rmrf(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    fs.readdirSync(p).forEach(function (n) { rmrf(path.join(p, n)); });
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

function copyRec(src, dst) {
  var st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    mkdirp(dst);
    fs.readdirSync(src).forEach(function (n) {
      if (n === '.DS_Store') return;
      copyRec(path.join(src, n), path.join(dst, n));
    });
  } else {
    fs.writeFileSync(dst, fs.readFileSync(src));
    try { fs.chmodSync(dst, st.mode & 511); } catch (e) {}
  }
}

// Is the folder our skill? Nothing else is ever replaced.
function isOurs(dir) {
  try {
    var md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    return /^name:\s*watch-timeline\s*$/m.test(md);
  } catch (e) { return false; }
}

/*
 * { state, version, have, path }
 *   'none'    not installed
 *   'ok'      installed, same version as the extension brings
 *   'old'     installed, another version
 *   'dev'     a symlink (developer setup): never touched
 *   'foreign' a folder of that name that is not this skill: never touched
 */
function status(extPath) {
  var src = sourceDir(extPath);
  var dst = targetDir();
  var out = { state: 'none', version: readVersion(src), have: null, path: dst };
  var st;
  try { st = fs.lstatSync(dst); } catch (e) { return out; }
  if (st.isSymbolicLink()) { out.state = 'dev'; out.have = readVersion(dst); return out; }
  if (!isOurs(dst)) { out.state = 'foreign'; return out; }
  out.have = readVersion(dst);
  out.state = out.have && out.have === out.version ? 'ok' : 'old';
  return out;
}

// Copies the skill to ~/.claude/skills. Returns the new status; throws on failure.
function install(extPath) {
  var src = sourceDir(extPath);
  var dst = targetDir();
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('skill folder is missing in the extension');
  var cur = status(extPath);
  if (cur.state === 'dev') return cur;
  if (cur.state === 'foreign') throw new Error('another folder named ' + NAME + ' is in the way: ' + dst);
  var stage = dst + '.new';
  rmrf(stage);
  copyRec(src, stage);
  if (cur.state !== 'none') rmrf(dst);
  mkdirp(path.dirname(dst));
  fs.renameSync(stage, dst);
  return status(extPath);
}

module.exports = { NAME: NAME, sourceDir: sourceDir, targetDir: targetDir, status: status, install: install, readVersion: readVersion };
