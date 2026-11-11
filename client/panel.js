/* WatchTimeline – main panel: target, new note, list of notes, settings and help. */
(function () {
  'use strict';
  var store = WT.store;
  var actions = WT.actions;
  var cs = WT.cs;
  var path = WT.path;
  var T = WT.t;
  var skill = WT.lib('skill.js');
  var IS_WIN = WT.require('os').platform() === 'win32';
  var $ = function (id) { return document.getElementById(id); };

  var ctx = null;            // last answer of wt_context()
  var hostDown = false;      // the host did not answer
  var project = null;        // { path, name, host }
  var data = store.emptyData(null);
  var dataStamp = '';        // notes file + change time: shows changes made by Claude
  var scopeChoice = null;    // scope the user clicked; null = pick automatically
  var view = 'main';
  var editor = null;         // { id, mode: 'redo' | 'answer' | 'edit', text }
  var sure = null;           // { key, timer }: a delete button waiting for the second click
  var showDone = false;
  var flashId = null;
  var lastMove = 0;          // last mouse move over the panel
  var bridge = null;         // answers Claude here when the background service does not run
  var bgSeen = 0;
  var toastTimer = null;
  var busyCtx = false;

  // ---------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function icon(name) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    var use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#' + name);
    svg.appendChild(use);
    return svg;
  }

  function button(cls, iconName, label, title) {
    var b = el('button', cls);
    if (iconName) b.appendChild(icon(iconName));
    if (label) b.appendChild(el('span', '', label));
    if (title) b.title = title;
    return b;
  }

  function toast(msg, kind) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, kind === 'warn' ? 4500 : 2600);
  }

  function errText(r) {
    var key = 'err_' + r.error;
    var text = T(key);
    if (text !== key) return text;
    return T('err', { error: r.detail || r.error });
  }

  function isItem() { return !!(ctx && ctx.container && ctx.container.type === 'item'); }

  // ---------------------------------------------------------------- language

  function applyI18n() {
    document.documentElement.lang = WT.lang();
    var each = function (sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); };
    each('[data-i18n]', function (n) { n.textContent = T(n.getAttribute('data-i18n')); });
    each('[data-i18n-title]', function (n) { n.title = T(n.getAttribute('data-i18n-title')); });
    each('[data-i18n-placeholder]', function (n) { n.placeholder = T(n.getAttribute('data-i18n-placeholder')); });
    each('[data-i18n-aria]', function (n) { n.setAttribute('aria-label', T(n.getAttribute('data-i18n-aria'))); });
    each('[data-lang]', function (b) { b.classList.toggle('active', b.getAttribute('data-lang') === WT.lang()); });
    if (IS_WIN) $('showFolder').textContent = T('showFolder_win');
    setViewTitle();
    setupFlyout();
    WTUpdate.render();
    renderAll();
  }

  function setLanguage(code) {
    if (code === WT.lang()) return;
    WT.setLang(code);
    applyI18n();
    toast(T('langChanged'), 'ok');
  }

  // ---------------------------------------------------------------- context (where the next note goes)

  function sameProject(a, b) {
    return !!a === !!b && (!a || (a.path === b.path && a.name === b.name));
  }

  function setContext(c) {
    hostDown = !!(c && c.error);
    ctx = hostDown ? null : c;
    var p = ctx ? actions.projectOf(ctx) : null;
    if (!sameProject(p, project)) {
      project = p;
      dataStamp = '';
      editor = null;
      scopeChoice = null;
    }
    checkData();
    renderTarget();
  }

  function refreshContext(spin) {
    if (busyCtx) return Promise.resolve();
    busyCtx = true;
    if (spin) {
      $('refresh').classList.remove('spin');
      void $('refresh').offsetWidth;
      $('refresh').classList.add('spin');
    }
    return actions.context().then(function (c) {
      busyCtx = false;
      setContext(c);
    }, function () { busyCtx = false; });
  }

  // 'time' | 'selection' | 'whole' for the next note, or null when nothing can be noted.
  function currentScope() {
    if (!ctx || !ctx.container) return null;
    if (isItem()) return 'whole';
    var hasSel = ctx.selection && ctx.selection.length > 0;
    if (scopeChoice === 'selection' && !hasSel) return 'time';
    if (scopeChoice) return scopeChoice;
    return hasSel ? 'selection' : 'time';
  }

  // A clip with linked audio is two track items: shown as one, "Name (V1 + A1)".
  function groupItems(items) {
    var groups = [];
    var by = {};
    (items || []).forEach(function (i) {
      var key = i.kind === 'layer' ? 'L' + i.index + '|' + i.name : i.name + '|' + i.start + '|' + i.end;
      if (!by[key]) { by[key] = { name: i.name, parts: [] }; groups.push(by[key]); }
      by[key].parts.push(i);
    });
    return groups;
  }

  function groupLabel(g) {
    var tracks = g.parts.map(function (p) { return p.track; }).filter(Boolean);
    if (tracks.length) return g.name + ' (' + tracks.join(' + ') + ')';
    if (g.parts.length > 1) return g.name + ' (' + T('avBoth') + ')';
    if (g.parts[0].mediaType === 'Audio') return g.name + ' (' + T('avAudio') + ')';
    return g.name;
  }

  function itemNames(items, max) {
    var groups = groupItems(items);
    var text = groups.slice(0, max).map(groupLabel).join(', ');
    if (groups.length > max) text += ' ' + T('more', { n: groups.length - max });
    return text;
  }

  function renderTarget() {
    var card = $('targetCard');
    var compose = $('compose');
    $('proj').textContent = project ? (project.name || '') : T('noProject');
    var off = !ctx || !ctx.project || !ctx.container;
    card.classList.toggle('off', off);
    compose.classList.toggle('off', off);
    $('noteText').disabled = off;
    $('btnAdd').disabled = off;
    if (off) {
      $('targetKind').textContent = '';
      $('targetTc').textContent = '';
      var noProj = !ctx || !ctx.project;
      $('targetName').textContent = hostDown ? T('err_host-failed') : T(noProj ? 'noProjectTitle' : 'noContainerTitle');
      $('targetText').textContent = hostDown ? T('hostDown') : T(noProj ? 'noProjectText' : 'noContainerText');
      $('scopeDesc').textContent = '';
      return;
    }
    var c = ctx.container;
    $('targetKind').textContent = T(c.type === 'sequence' ? 'kindSequence' : c.type === 'comp' ? 'kindComp' : 'kindItem');
    $('targetName').textContent = c.name;
    $('targetName').title = c.name;
    $('targetTc').textContent = isItem() ? '' : ctx.timecode;
    $('targetText').textContent = '';

    var scope = currentScope();
    var n = groupItems(ctx.selection).length;
    Array.prototype.forEach.call(document.querySelectorAll('#scope button'), function (b) {
      var s = b.getAttribute('data-scope');
      var disabled = isItem() ? s !== 'whole' : (s === 'selection' && n === 0);
      b.disabled = disabled;
      b.classList.toggle('active', s === scope);
      b.setAttribute('aria-checked', s === scope ? 'true' : 'false');
      b.title = s === 'time' ? T('scopeTimeTip') : s === 'whole' ? T('scopeWholeTip') :
        T(n ? 'scopeSelectionTip' : 'scopeSelectionNone');
    });
    $('selCount').hidden = n === 0;
    $('selCount').textContent = n;

    var desc = $('scopeDesc');
    desc.textContent = '';
    var text;
    if (isItem()) text = T('descItem', { name: c.name });
    else if (scope === 'selection') text = T('descSelection', { n: n, items: itemNames(ctx.selection, n === 1 ? 1 : 2) });
    else if (scope === 'whole') text = T('descWhole', { name: c.name });
    else text = T('descTime', { tc: ctx.timecode });
    desc.appendChild(el('span', '', text));
  }

  // ---------------------------------------------------------------- notes

  // Reads the notes again when the file changed (Claude works through the bridge).
  function checkData() {
    var file = project ? store.projectFile(project) : '';
    var stamp = file + '|' + (file ? store.mtime(file) : 0);
    if (stamp === dataStamp) return false;
    dataStamp = stamp;
    data = project ? store.load(project) : store.emptyData(null);
    renderNotes();
    renderClaudeBar();
    return true;
  }

  function reload() {
    dataStamp = '';
    checkData();
  }

  function whereLabel(n) {
    var t = n.target || {};
    var c = t.container || {};
    var parts = [];
    if (n.scope === 'selection' && t.items && t.items.length) parts.push(itemNames(t.items, 1));
    else if (n.scope === 'whole' && c.type === 'item') parts.push(T('kindItem'));
    else if (n.scope === 'whole') parts.push(T('scopeWhole'));
    // The container, when it is not the one in front.
    if (c.name && (!ctx || !ctx.container || ctx.container.id !== c.id || c.type === 'item')) parts.push(c.name);
    return parts.join(' · ');
  }

  function timeBadge(n) {
    var t = n.target || {};
    if (t.container && t.container.type === 'item') return '';
    if (n.scope === 'whole') return '';
    return t.timecode || store.timecode(t.time, t.fps);
  }

  // The lines after the first text: what Claude did, what the user said then.
  function threadOf(n) {
    var lines = n.history.filter(function (h) {
      return h.type === 'fixed' || h.type === 'question' || h.type === 'reopened' || h.type === 'answered';
    }).filter(function (h) { return h.text; });
    return lines.slice(-4);
  }

  function renderNote(n) {
    var li = el('li', 'note ' + n.status);
    li.setAttribute('data-id', n.id);
    if (flashId === n.id) { li.classList.add('flash'); flashId = null; }

    var main = el('div', 'note-main');
    main.setAttribute('role', 'button');
    main.tabIndex = 0;
    main.title = T('jumpTip');
    var top = el('div', 'note-top');
    var tc = timeBadge(n);
    if (tc) top.appendChild(el('span', 'tc', tc));
    top.appendChild(el('span', 'where', whereLabel(n)));
    if (n.status === 'question') top.appendChild(el('span', 'badge', T('badgeQuestion')));
    main.appendChild(top);
    main.appendChild(el('p', 'note-text', n.text));
    var thread = threadOf(n);
    if (thread.length) {
      var ul = el('ul', 'thread');
      thread.forEach(function (h, i) {
        var byClaude = h.by === 'claude';
        var item = el('li', (byClaude ? 'claude' : 'user') + (h.type === 'question' ? ' ask' : '') + (i < thread.length - 2 ? ' older' : ''));
        if (byClaude) item.appendChild(el('b', '', T(h.type === 'question' ? 'claudeAsks' : 'claudeDid')));
        item.appendChild(document.createTextNode(h.text));
        ul.appendChild(item);
      });
      main.appendChild(ul);
    }
    main.onclick = function () { jump(n.id); };
    main.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(n.id); } };
    li.appendChild(main);

    if (editor && editor.id === n.id) {
      li.appendChild(renderEditor(n));
      return li;
    }

    var acts = el('div', 'note-acts');
    var b;
    if (n.status === 'review') {
      b = button('accept', 'i-check', T('btnAccept'), T('btnAcceptTip'));
      b.onclick = function () { run(actions.accept(project, n.id)); };
      acts.appendChild(b);
      b = button('', 'i-redo', T('btnRedo'), T('btnRedoTip'));
      b.onclick = function () { openEditor(n, 'redo'); };
      acts.appendChild(b);
    } else if (n.status === 'question') {
      b = button('primary', 'i-chat', T('btnAnswer'));
      b.onclick = function () { openEditor(n, 'answer'); };
      acts.appendChild(b);
    }
    acts.appendChild(el('span', 'sp'));
    if (n.status === 'open' || n.status === 'question') {
      b = button('icon', 'i-edit', '', T('btnEditTip'));
      b.onclick = function () { openEditor(n, 'edit'); };
      acts.appendChild(b);
    }
    var key = 'del:' + n.id;
    if (sure && sure.key === key) {
      b = button('sure', 'i-trash', T('btnDeleteSure'));
      b.onclick = function () { clearSure(); run(actions.remove(project, n.id)); };
    } else {
      b = button('icon', 'i-trash', '', T('btnDeleteTip'));
      b.onclick = function () { askSure(key); };
    }
    acts.appendChild(b);
    li.appendChild(acts);
    return li;
  }

  function renderEditor(n) {
    var box = el('div', 'note-edit');
    var ta = el('textarea');
    ta.rows = 2;
    ta.spellcheck = false;
    ta.value = editor.text;
    ta.placeholder = T(editor.mode === 'redo' ? 'redoPlaceholder' : editor.mode === 'answer' ? 'answerPlaceholder' : 'notePlaceholder');
    ta.oninput = function () { editor.text = ta.value; };
    ta.onkeydown = function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitEditor(); }
      if (e.key === 'Escape') { editor = null; renderNotes(); }
    };
    box.appendChild(ta);
    var row = el('div', 'btnrow small');
    var ok = button('primary', '', T(editor.mode === 'redo' ? 'redoSend' : editor.mode === 'answer' ? 'answerSend' : 'editSave'));
    ok.onclick = submitEditor;
    var cancel = button('', '', T('cancel'));
    cancel.onclick = function () { editor = null; renderNotes(); };
    row.appendChild(ok);
    row.appendChild(cancel);
    box.appendChild(row);
    return box;
  }

  function openEditor(n, mode) {
    editor = { id: n.id, mode: mode, text: mode === 'edit' ? n.text : '' };
    renderNotes();
    var ta = document.querySelector('.note[data-id="' + n.id + '"] textarea');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  function submitEditor() {
    if (!editor) return;
    var text = editor.text.trim();
    if (!text) { toast(T('addEmpty'), 'warn'); return; }
    var e = editor;
    editor = null;
    run(e.mode === 'edit' ? actions.edit(project, e.id, text) : actions.reopen(project, e.id, text));
  }

  function askSure(key) {
    clearSure();
    sure = { key: key, timer: setTimeout(function () { sure = null; renderNotes(); }, 3500) };
    renderNotes();
  }

  function clearSure() {
    if (sure) clearTimeout(sure.timer);
    sure = null;
  }

  function section(status, titleKey, hintKey, notes) {
    var sec = el('div', 'sec');
    var h = el('h4');
    h.appendChild(el('i', 'dot ' + status));
    h.appendChild(el('span', '', T(titleKey)));
    h.appendChild(el('span', 'count', String(notes.length)));
    sec.appendChild(h);
    if (hintKey) sec.appendChild(el('p', 'sec-hint', T(hintKey)));
    var ul = el('ul');
    notes.forEach(function (n) { ul.appendChild(renderNote(n)); });
    sec.appendChild(ul);
    return sec;
  }

  function renderNotes() {
    var box = $('notes');
    // Keep the text and the cursor of an open editor.
    var active = document.activeElement;
    var keep = active && active.tagName === 'TEXTAREA' && active.closest('.note-edit') ?
      { start: active.selectionStart, end: active.selectionEnd } : null;
    box.innerHTML = '';
    var all = store.sortNotes(data.notes);
    if (editor && !all.some(function (n) { return n.id === editor.id; })) editor = null;
    var review = all.filter(function (n) { return n.status === 'review'; });
    var open = all.filter(function (n) { return n.status === 'open' || n.status === 'question'; });
    var done = all.filter(function (n) { return n.status === 'done'; });
    if (review.length) box.appendChild(section('review', 'secReview', 'secReviewHint', review));
    if (open.length) box.appendChild(section('open', 'secOpen', '', open));
    if (showDone && done.length) box.appendChild(section('done', 'secDone', '', done));
    $('empty').hidden = review.length + open.length > 0 || !project || (showDone && done.length > 0);
    $('doneBar').hidden = done.length === 0;
    $('doneToggle').textContent = T(showDone ? 'doneHide' : 'doneShow') + (showDone ? '' : ' (' + done.length + ')');
    $('doneClear').hidden = !showDone || done.length === 0;
    $('doneClear').textContent = T(sure && sure.key === 'clear' ? 'doneClearSure' : 'doneClear');
    if (keep && editor) {
      var ta = document.querySelector('.note[data-id="' + editor.id + '"] textarea');
      if (ta) { ta.focus(); try { ta.setSelectionRange(keep.start, keep.end); } catch (e) {} }
    }
  }

  // Runs an action that changes notes, then shows the new state.
  function run(promise) {
    return promise.then(function (r) {
      if (r && r.error) toast(errText(r), 'warn');
      reload();
      return r;
    });
  }

  function jump(id) {
    if (!project) return;
    var n = store.findNote(data, id);
    actions.jump(project, id).then(function (r) {
      if (r.error === 'container-missing') toast(T('jumpMissing', { name: (n && n.target.container && n.target.container.name) || '' }), 'warn');
      else if (r.error) toast(errText(r), 'warn');
      else if (r.missing > 0) toast(T('jumpPartial'), 'warn');
      refreshContext();
    });
  }

  function addNote() {
    var ta = $('noteText');
    var text = ta.value.trim();
    if (!text) { toast(T('addEmpty'), 'warn'); ta.focus(); return; }
    var scope = currentScope();
    if (!scope) return;
    $('btnAdd').disabled = true;
    actions.add(text, scope).then(function (r) {
      $('btnAdd').disabled = false;
      if (r.error) {
        toast(errText(r), 'warn');
        refreshContext();
        return;
      }
      ta.value = '';
      scopeChoice = null;
      flashId = r.note.id;
      var t = r.note.target || {};
      var where = r.note.scope === 'time' ? t.timecode : (whereLabel(r.note) || (t.container && t.container.name) || '');
      toast(T('added', { where: where }), 'ok');
      reload();
      refreshContext();
      var li = document.querySelector('.note[data-id="' + r.note.id + '"]');
      if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
    });
  }

  // ---------------------------------------------------------------- claude bar

  function renderClaudeBar() {
    var bar = $('claudeBar');
    var st = skill.status(WT.extPath);
    var n = store.counts(data).open;
    var missing = st.state === 'none';
    bar.classList.toggle('warn', missing);
    bar.classList.toggle('has-open', !missing && n > 0);
    if (missing) {
      $('cbTitle').textContent = T('skillMissing');
      $('cbHint').textContent = '';
      $('btnCopyLabel').textContent = T('btnSkillInstall');
      $('btnCopy').title = '';
      $('btnCopy').onclick = installSkill;
      return;
    }
    $('cbTitle').textContent = n ? T('claudeWaiting', { n: n }) : T('claudeNone');
    $('cbHint').textContent = T('claudeHint');
    $('btnCopyLabel').textContent = T('btnCopy');
    $('btnCopy').title = T('btnCopyTip');
    $('btnCopy').onclick = copyPrompt;
  }

  function copyPrompt() {
    var ta = el('textarea');
    ta.value = T('claudePrompt');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(T('copied'), 'ok'); } catch (e) {}
    document.body.removeChild(ta);
  }

  function installSkill() {
    try {
      skill.install(WT.extPath);
      toast(T('skillInstalled'), 'ok');
    } catch (e) {
      toast(T('skillFailed', { error: String(e && e.message || e) }), 'warn');
    }
    renderClaudeBar();
    renderSettings();
  }

  // ---------------------------------------------------------------- settings

  function renderSettings() {
    var s = store.loadSettings();
    $('s-manual').checked = s.reviewMode !== 'auto';
    $('s-auto').checked = s.reviewMode === 'auto';
    $('s-markers').checked = s.markers !== false;
    $('s-checkUpdates').checked = s.checkUpdates !== false;
    var st = skill.status(WT.extPath);
    $('skillState').textContent = st.state === 'ok' ? T('skillOk', { version: st.have }) :
      st.state === 'old' ? T('skillOld', { have: st.have || '?', version: st.version }) :
      st.state === 'dev' ? T('skillDev') : T('skillNone');
    $('btnSkill').hidden = st.state === 'ok' || st.state === 'dev' || st.state === 'foreign';
    $('btnSkillLabel').textContent = T(st.state === 'old' ? 'btnSkillUpdate' : 'btnSkillInstall');
    $('skillPath').textContent = T('skillPath', { path: st.path });
    $('dataPath').textContent = store.appDataDir();
    WTUpdate.render();
  }

  function setupSettings() {
    var save = function (patch) {
      store.saveSettings(patch);
      toast(T('settingsSaved'), 'ok');
    };
    $('s-manual').onchange = $('s-auto').onchange = function () {
      save({ reviewMode: $('s-auto').checked ? 'auto' : 'manual' });
    };
    $('s-markers').onchange = function () { save({ markers: $('s-markers').checked }); };
    $('s-checkUpdates').onchange = function () { save({ checkUpdates: $('s-checkUpdates').checked }); };
    $('btnSkill').onclick = installSkill;
    $('showFolder').onclick = function (e) {
      e.preventDefault();
      var dir = store.appDataDir();
      store.mkdirp(dir);
      var cp = WT.require('child_process');
      try {
        if (IS_WIN) cp.execFile('explorer.exe', [dir]);
        else cp.execFile('/usr/bin/open', [dir]);
      } catch (err) {}
    };
  }

  // ---------------------------------------------------------------- views

  function setViewTitle() {
    $('viewName').textContent = view === 'settings' ? T('viewSettings') : view === 'help' ? T('viewHelp') : 'WatchTimeline';
  }

  function show(name) {
    view = name;
    ['main', 'settings', 'help'].forEach(function (v) { $('view-' + v).hidden = v !== name; });
    $('back').hidden = name === 'main';
    $('claudeBar').hidden = name !== 'main';
    setViewTitle();
    if (name === 'settings') renderSettings();
    if (name === 'main') { reload(); refreshContext(); }
  }

  function renderAll() {
    renderTarget();
    renderNotes();
    renderClaudeBar();
    if (view === 'settings') renderSettings();
  }

  // Menu in the panel tab (☰), in the current language.
  function setupFlyout() {
    var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); };
    var xml = '<Menu>' +
      '<MenuItem Id="settings" Label="' + esc(T('viewSettings')) + '"/>' +
      '<MenuItem Id="help" Label="' + esc(T('viewHelp')) + '"/>' +
      '<MenuItem Label="---"/>' +
      '<MenuItem Id="checkUpdates" Label="' + esc(T('menuUpdates')) + '"/>' +
      '</Menu>';
    try { cs.setPanelFlyoutMenu(xml); } catch (e) {}
  }

  function runMenu(id) {
    if (id === 'settings' || id === 'help') show(id);
    if (id === 'checkUpdates') { show('settings'); WTUpdate.check(true); }
  }

  // ---------------------------------------------------------------- theme and keys

  function applyTheme() {
    try {
      var c = cs.getHostEnvironment().appSkinInfo.panelBackgroundColor.color;
      var light = (c.red + c.green + c.blue) / 3 > 128;
      document.body.classList.toggle('light', light);
      var hex = function (v) { var h = Math.round(v).toString(16); return h.length < 2 ? '0' + h : h; };
      document.documentElement.style.setProperty('--bg', '#' + hex(c.red) + hex(c.green) + hex(c.blue));
    } catch (e) {}
  }

  // Without this the host keeps Cmd+Enter and the clipboard shortcuts for itself.
  function claimKeys() {
    var keys = [];
    if (IS_WIN) {
      [13, 65, 67, 86, 88, 90].forEach(function (k) { keys.push({ keyCode: k, ctrlKey: true }); });
    } else {
      [36, 0, 8, 9, 7, 6].forEach(function (k) { keys.push({ keyCode: k, metaKey: true }); });
      keys.push({ keyCode: 6, metaKey: true, shiftKey: true });
    }
    try { cs.registerKeyEventsInterest(JSON.stringify(keys)); } catch (e) {}
  }

  // ---------------------------------------------------------------- bridge fallback

  // The background service answers Claude. When it does not run (it starts
  // with the host, so not right after installing), the panel answers itself.
  function watchBridge() {
    if (!bridge) bridge = WT.createBridge('panel', reload);
    var bgAlive = Date.now() - bgSeen < 15000 || bridge.otherAlive('background');
    if (bgAlive) {
      if (bridge.isRunning()) bridge.stop();
      return;
    }
    if (!bridge.isRunning()) bridge.start();
  }

  // ---------------------------------------------------------------- start

  function tick() {
    if (document.hidden) return;
    checkData();
    // Ask the host only while the user is at the panel: a script call can
    // interrupt a running preview in After Effects.
    if (view === 'main' && (Date.now() - lastMove < 4000 || document.hasFocus())) refreshContext();
  }

  function init() {
    document.body.classList.toggle('ae', WT.isAE);
    applyTheme();
    cs.addEventListener(CSInterface.THEME_COLOR_CHANGED_EVENT, applyTheme);
    claimKeys();

    Array.prototype.forEach.call(document.querySelectorAll('[data-lang]'), function (b) {
      b.onclick = function () { setLanguage(b.getAttribute('data-lang')); };
    });
    $('helpBtn').onclick = function () { show(view === 'help' ? 'main' : 'help'); };
    $('settingsBtn').onclick = function () { show(view === 'settings' ? 'main' : 'settings'); };
    $('back').onclick = function () { show('main'); };
    $('refresh').onclick = function () { refreshContext(true); };
    Array.prototype.forEach.call(document.querySelectorAll('#scope button'), function (b) {
      b.onclick = function () {
        scopeChoice = b.getAttribute('data-scope');
        renderTarget();
        $('noteText').focus();
      };
    });
    $('btnAdd').onclick = addNote;
    $('noteText').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addNote(); }
    });
    $('doneToggle').onclick = function (e) { e.preventDefault(); showDone = !showDone; renderNotes(); };
    $('doneClear').onclick = function (e) {
      e.preventDefault();
      if (sure && sure.key === 'clear') { clearSure(); run(actions.clearDone(project)); }
      else askSure('clear');
    };
    setupSettings();
    try {
      cs.addEventListener('com.adobe.csxs.events.flyoutMenuClicked', function (e) { runMenu(e.data && e.data.menuId); });
    } catch (e) {}

    document.addEventListener('mousemove', function () { lastMove = Date.now(); });
    document.addEventListener('mouseenter', function () { lastMove = Date.now(); refreshContext(); });
    window.addEventListener('focus', function () { refreshContext(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { reload(); refreshContext(); } });

    WT.on(WT.EVT_PONG, function () { bgSeen = Date.now(); });
    WT.on(WT.EVT_CHANGED, function () { reload(); });

    WTUpdate.init(function (msg, kind) { toast(msg, kind === 'error' ? 'warn' : kind); });
    applyI18n();

    WT.loadHost().then(function () {
      refreshContext();
      var timers = [setInterval(tick, 1000)];
      // Start the background service (it answers Claude while the panel is closed).
      try { cs.requestOpenExtension(WT.BG_ID, ''); } catch (e) {}
      WT.send(WT.EVT_PING, {});
      setTimeout(watchBridge, 4000);
      timers.push(setInterval(function () { WT.send(WT.EVT_PING, {}); watchBridge(); }, 10000));
      // CEP keeps timers alive when the page reloads: stop them, and the bridge.
      window.addEventListener('beforeunload', function () {
        timers.forEach(clearInterval);
        if (bridge) bridge.stop();
      });
    });
  }

  window.WTPanel = {
    refresh: refreshContext, reload: reload, show: show,
    state: function () { return { ctx: ctx, project: project, data: data, view: view, scope: currentScope() }; }
  };
  init();
})();
