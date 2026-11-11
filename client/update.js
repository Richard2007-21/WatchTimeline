/* WatchTimeline – update banner: looks for a new release on GitHub and installs it. */
(function () {
  'use strict';
  var T = WT.t;
  var path = WT.path;
  var upd = WT.lib('update.js');
  var skill = WT.lib('skill.js');
  var $ = function (id) { return document.getElementById(id); };

  var STATE_FILE = path.join(WT.store.appDataDir(), 'update-check.json');
  var RECHECK_MS = 30 * 60 * 1000;   // the module itself asks GitHub at most every 6 h

  // The version Premiere / After Effects loaded. After an update the files on
  // disk are newer: then a restart is needed.
  var running = upd.readVersion(WT.extPath) || '0.0.0';
  var info = null;        // last result of upd.check()
  var checking = false;
  var busy = null;        // 'download' | 'unpack' | 'install' while updating
  var failed = null;      // error text of the last failed update
  var closed = false;     // banner closed with ✕ (until the next start)
  var notesOpen = false;
  var log = function () {};

  function diskVersion() { return upd.readVersion(WT.extPath) || running; }
  function restartPending() { return upd.compareVersions(diskVersion(), running) > 0; }
  function mode() { return upd.installMode(WT.extPath); }

  function fmtDate(t) {
    var d = new Date(t);
    var p = function (n) { return n < 10 ? '0' + n : n; };
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function render() {
    renderBanner();
    renderSettings();
  }

  function renderBanner() {
    var b = $('updateBanner');
    var latest = info && info.latest;
    var restart = restartPending();
    var show = restart || busy || (info && info.available && !closed);
    b.hidden = !show;
    if (!show) return;

    b.className = 'update' + (restart ? ' done' : failed ? ' failed' : '');
    $('upClose').hidden = !!busy;
    $('upNotes').hidden = !(notesOpen && latest && latest.notes && !restart);
    $('upNotes').textContent = latest && latest.notes || '';
    $('upNotesBtn').hidden = !(latest && latest.notes) || restart;
    $('upNotesBtn').textContent = T(notesOpen ? 'upNotesHide' : 'upNotes');

    if (restart) {
      $('upTitle').textContent = T('upDoneTitle', { version: diskVersion() });
      $('upText').textContent = T('upDoneText');
      $('upActions').hidden = true;
      return;
    }
    $('upActions').hidden = false;
    var auto = mode() === 'auto' && latest && latest.zipUrl;
    $('upInstall').disabled = !!busy;
    $('upNotesBtn').disabled = !!busy;
    if (busy) {
      $('upTitle').textContent = T('upBusy_' + busy, { version: latest.version });
      $('upText').textContent = T('upBusyText');
      $('upInstallLabel').textContent = T('upInstall');
      return;
    }
    $('upTitle').textContent = T('upTitle', { version: latest.version });
    $('upText').textContent = failed ? T('upFailed', { error: failed }) :
      T(auto ? 'upText' : mode() === 'dev' ? 'upTextDev' : 'upTextManual', { current: running });
    $('upInstallLabel').textContent = T(auto && !failed ? 'upInstall' : 'upDownload');
  }

  function renderSettings() {
    if (!$('upVersion')) return;
    $('upVersion').textContent = T('upVersion', { version: running });
    $('btnCheckUpdates').disabled = checking || !!busy;
    var s;
    if (restartPending()) s = T('upDoneTitle', { version: diskVersion() });
    else if (checking) s = T('upChecking');
    else if (!info) s = '';
    else if (info.available) s = T('upAvailable', { version: info.latest.version });
    else if (info.error && !info.checkedAt) s = T('upError', { error: info.error });
    else s = T('upLatest', { time: info.checkedAt ? fmtDate(info.checkedAt) : '–' }) +
      (info.error ? ' ' + T('upOffline') : '');
    $('upState').textContent = s;
  }

  // force: the user asked (button or menu); ignores the 6 h cache and the setting.
  function check(force) {
    if (checking || busy) return Promise.resolve(info);
    if (!force && WT.store.loadSettings().checkUpdates === false) return Promise.resolve(info);
    checking = true;
    renderSettings();
    return upd.check({ current: diskVersion(), stateFile: STATE_FILE, force: !!force }).then(function (r) {
      var wasAvailable = info && info.available && info.latest.version;
      info = r;
      checking = false;
      if (r.available && r.latest.version !== wasAvailable) { closed = false; failed = null; }
      if (force) {
        if (r.error && !r.checkedAt) log(T('upError', { error: r.error }), 'warn');
        else if (r.available) log(T('upAvailable', { version: r.latest.version }), 'ok');
        else log(T('upLatestLog', { version: running }), 'ok');
      } else if (r.available && r.latest.version !== wasAvailable) {
        log(T('upAvailable', { version: r.latest.version }), 'ok');
      }
      render();
      return r;
    });
  }

  function openPage() {
    var url = info && info.latest ? info.latest.url : upd.RELEASES_URL;
    try { WT.cs.openURLInDefaultBrowser(url); } catch (e) {}
  }

  function install() {
    var latest = info && info.latest;
    if (!latest || busy) return;
    if (failed || mode() !== 'auto' || !latest.zipUrl) { openPage(); return; }
    failed = null;
    busy = 'download';
    render();
    upd.install({
      release: latest, extPath: WT.extPath, current: running,
      onStep: function (s) { busy = s; render(); }
    }).then(function (v) {
      busy = null;
      // The new files bring a new Claude skill: renew the installed copy too.
      try {
        var st = skill.status(WT.extPath);
        if (st.state === 'ok' || st.state === 'old') skill.install(WT.extPath);
      } catch (e) {}
      log(T('upInstalledLog', { version: v }), 'ok');
      render();
    }, function (err) {
      busy = null;
      failed = String(err && err.message || err);
      log(T('upFailed', { error: failed }), 'error');
      render();
    });
  }

  function init(logFn) {
    log = logFn || log;
    $('upInstall').onclick = install;
    $('upClose').onclick = function () { closed = true; render(); };
    $('upNotesBtn').onclick = function () { notesOpen = !notesOpen; render(); };
    $('btnCheckUpdates').onclick = function () { check(true); };
    // Show the cached answer at once, then ask GitHub when it is old.
    setTimeout(function () { check(false); }, 3000);
    setInterval(function () { check(false); }, RECHECK_MS);
    render();
  }

  window.WTUpdate = { init: init, check: check, render: render, install: install };
})();
