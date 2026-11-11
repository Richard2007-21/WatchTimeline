/* WatchTimeline – shared helpers for the panel and the background extension. */
(function () {
  'use strict';
  var cs = new CSInterface();
  var nodeRequire = (typeof require === 'function') ? require : (window.cep_node && window.cep_node.require);
  var path = nodeRequire('path');
  var extPath = cs.getSystemPath(SystemPath.EXTENSION);
  var lib = function (name) { return nodeRequire(path.join(extPath, 'lib', name)); };
  var store = lib('store.js');
  var i18n = lib('i18n.js');
  var HOST_API = '1.0.1';   // must match WT_HOST_API in host/host_common.jsx

  function evalScript(code) {
    return new Promise(function (resolve) { cs.evalScript(code, resolve); });
  }

  var host = 'PPRO';
  var hostVersion = '';
  var uiLocale = '';
  try {
    var env = cs.getHostEnvironment();
    host = env.appName;
    hostVersion = env.appVersion;
    uiLocale = env.appUILocale;
  } catch (e) {}
  var isAE = host === 'AEFT';
  var hostName = isAE ? 'After Effects' : 'Premiere Pro';

  // Current language: the saved choice, else the language of the Adobe app.
  // Read from the settings file at most every 2 s.
  var langCache = { at: 0, lang: 'en' };
  function lang() {
    var now = Date.now();
    if (now - langCache.at > 2000) {
      var s = store.loadSettings();
      langCache.lang = s.language ? i18n.normLang(s.language) : i18n.langFromLocale(uiLocale);
      langCache.at = now;
    }
    return langCache.lang;
  }
  function setLang(code) {
    var s = store.saveSettings({ language: i18n.normLang(code) });
    langCache = { at: Date.now(), lang: s.language };
  }
  function t(key, params) { return i18n.t(lang(), key, params, host); }

  // Makes sure the ExtendScript functions are loaded in the host, in the
  // version this extension expects (a running host keeps old ones after an update).
  function loadHost() {
    return evalScript('typeof wt_ping === "function" ? wt_ping() : ""').then(function (v) {
      if (v === HOST_API) return;
      var dir = path.join(extPath, 'host').replace(/\\/g, '/');
      return evalScript('$.evalFile(' + JSON.stringify(dir + '/host_common.jsx') + ');' +
        '$.evalFile(' + JSON.stringify(dir + (isAE ? '/host_aeft.jsx' : '/host_ppro.jsx')) + ');');
    });
  }

  function send(type, data) {
    var e = new CSEvent(type, 'APPLICATION');
    e.data = JSON.stringify(data || {});
    cs.dispatchEvent(e);
  }

  function on(type, fn) {
    cs.addEventListener(type, function (ev) {
      var d = ev.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = {}; } }
      fn(d || {});
    });
  }

  var actions = lib('actions.js').createActions({ store: store, evalScript: evalScript, host: host });
  var extVersion = lib('update.js').readVersion(extPath) || '0.0.0';

  function createBridge(role, onChange) {
    return lib('bridge.js').createBridge({
      store: store, actions: actions, host: host, hostVersion: hostVersion, hostName: hostName,
      role: role, version: extVersion, onChange: onChange
    });
  }

  window.WT = {
    cs: cs, host: host, hostVersion: hostVersion, hostName: hostName, isAE: isAE, version: extVersion,
    i18n: i18n, lang: lang, setLang: setLang, t: t, require: nodeRequire, lib: lib, path: path, extPath: extPath,
    store: store, actions: actions, evalScript: evalScript, loadHost: loadHost, send: send, on: on,
    createBridge: createBridge,
    EVT_CHANGED: 'com.watchtimeline.changed', EVT_PING: 'com.watchtimeline.ping', EVT_PONG: 'com.watchtimeline.pong',
    BG_ID: 'com.watchtimeline.background'
  };
})();
