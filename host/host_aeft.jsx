/*
 * WatchTimeline – ExtendScript side for After Effects (needs host_common.jsx).
 * Same API as host_ppro.jsx.
 *
 * A note points at a composition (container), a time in it and, for the scope
 * "selection", at layers. A footage item or folder selected in the Project
 * panel can be a container too (type "item"). Times are seconds from the
 * start of the composition. Layers are 1-based.
 */

if (typeof WT_LAST_COMP === 'undefined') {
    var WT_LAST_COMP = 0;
    var WT_LAST_PROJECT = '';
}

function wt_isAE() {
    return true;
}

function wt_project() {
    var p = null;
    try { p = app.project; } catch (e) {}
    if (!p) return null;
    var f = p.file;
    return { path: f ? String(f.fsName) : '', name: f ? String(f.displayName) : '' };
}

function wt_tc(comp, seconds) {
    try { return String(timeToCurrentFormat(seconds + comp.displayStartTime, comp.frameRate)); } catch (e) {}
    return wt_simpleTc(seconds, comp.frameRate);
}

/*
 * The item the user works in. While a panel like this one has the focus,
 * After Effects sometimes reports no active item: then the composition that
 * was active last is used.
 */
function wt_active() {
    var it = null;
    var proj = wt_project();
    var key = proj ? proj.path : '';
    try { it = app.project.activeItem; } catch (e) {}
    if (it instanceof CompItem) {
        WT_LAST_COMP = it.id;
        WT_LAST_PROJECT = key;
        return it;
    }
    if (it) return it;
    if (WT_LAST_COMP && WT_LAST_PROJECT === key) {
        try {
            var c = app.project.itemByID(WT_LAST_COMP);
            if (c instanceof CompItem) return c;
        } catch (e2) {}
    }
    return null;
}

function wt_itemKind(it) {
    if (it instanceof CompItem) return 'comp';
    if (it instanceof FolderItem) return 'folder';
    return 'footage';
}

function wt_container(it) {
    if (it instanceof CompItem) return { type: 'comp', name: String(it.name), id: String(it.id) };
    return { type: 'item', name: String(it.name), id: String(it.id), itemKind: wt_itemKind(it) };
}

function wt_findItem(container) {
    if (!container) return null;
    var it = null;
    try { it = app.project.itemByID(parseInt(container.id, 10)); } catch (e) {}
    if (it && String(it.name) === String(container.name)) return it;
    // Another project or a renamed item: look for the name.
    var wantComp = container.type === 'comp';
    for (var i = 1; i <= app.project.numItems; i++) {
        var cand = app.project.item(i);
        if (String(cand.name) === String(container.name) && (cand instanceof CompItem) === wantComp) return cand;
    }
    if (it && (it instanceof CompItem) === wantComp) return it;
    return null;
}

function wt_layerKind(l) {
    try {
        if (l instanceof TextLayer) return 'text';
        if (l instanceof ShapeLayer) return 'shape';
        if (l instanceof CameraLayer) return 'camera';
        if (l instanceof LightLayer) return 'light';
        if (l.nullObject) return 'null';
        if (l.adjustmentLayer) return 'adjustment';
        if (l.source instanceof CompItem) return 'precomp';
        if (l.source && l.source.mainSource instanceof SolidSource) return 'solid';
        if (!l.hasVideo && l.hasAudio) return 'audio';
        return 'footage';
    } catch (e) {
        return 'layer';
    }
}

function wt_layerId(l) {
    try { return l.id; } catch (e) { return 0; }      // After Effects 22 and later
}

function wt_layerRef(l) {
    var a = l.inPoint;
    var b = l.outPoint;
    return {
        kind: 'layer', layerKind: wt_layerKind(l), name: String(l.name), index: l.index, id: wt_layerId(l),
        start: wt_round(Math.min(a, b)), end: wt_round(Math.max(a, b))
    };
}

function wt_findLayer(comp, ref) {
    var l = null;
    if (ref.id) {
        try {
            l = app.project.layerByID(ref.id);
            if (l && l.containingComp === comp) return l;
        } catch (e) {}
    }
    try {
        if (ref.index >= 1 && ref.index <= comp.numLayers) {
            l = comp.layer(ref.index);
            if (String(l.name) === String(ref.name)) return l;
        }
    } catch (e2) {}
    for (var i = 1; i <= comp.numLayers; i++) {
        if (String(comp.layer(i).name) === String(ref.name)) return comp.layer(i);
    }
    return null;
}

function wt_propPath(p) {
    var names = [];
    var cur = p;
    var guard = 0;
    while (cur && guard++ < 20) {
        var parent = null;
        try { parent = cur.parentProperty; } catch (e) {}
        if (!parent) break;                      // cur is the layer
        names.unshift(String(cur.name));
        cur = parent;
    }
    return { layer: cur ? String(cur.name) : '', layerIndex: cur && cur.index ? cur.index : 0, path: names.join(' > ') };
}

// ---------------------------------------------------------------- context

// Cheap: called while the mouse is over the panel.
function wt_context() {
    try {
        var out = { host: 'AEFT', project: wt_project(), container: null, time: 0, timecode: '', fps: 0, duration: 0, selection: [] };
        if (!out.project) return wt_stringify(out);
        var it = wt_active();
        if (!it) return wt_stringify(out);
        out.container = wt_container(it);
        if (it instanceof CompItem) {
            out.time = wt_round(it.time, 6);
            out.fps = wt_round(it.frameRate, 3);
            out.duration = wt_round(it.duration);
            out.timecode = wt_tc(it, it.time);
            var sel = it.selectedLayers;
            for (var i = 0; i < sel.length && i < 40; i++) out.selection.push(wt_layerRef(sel[i]));
        }
        return wt_stringify(out);
    } catch (e) {
        return wt_err(e);
    }
}

// The exact target of a new note. json: { scope: 'time' | 'selection' | 'whole' }
function wt_capture(json) {
    try {
        var a = wt_parse(json) || {};
        var project = wt_project();
        if (!project) return wt_fail('no-project');
        var it = wt_active();
        if (!it) return wt_fail('no-container');
        var scope = a.scope === 'selection' || a.scope === 'whole' ? a.scope : 'time';
        var t = { container: wt_container(it), time: 0, fps: 0, start: 0, end: 0, items: [] };
        if (!(it instanceof CompItem)) {
            // A footage item or folder from the Project panel: the note is about the whole item.
            t.timecode = '';
            return wt_stringify({ host: 'AEFT', project: project, scope: 'whole', target: t });
        }
        t.time = it.time;
        t.fps = wt_round(it.frameRate, 3);
        t.start = it.time;
        t.end = it.time;
        if (scope === 'selection') {
            var sel = it.selectedLayers;
            if (!sel.length) return wt_fail('no-selection');
            var min = 0;
            var max = 0;
            for (var i = 0; i < sel.length && i < 40; i++) {
                var ref = wt_layerRef(sel[i]);
                t.items.push(ref);
                if (i === 0 || ref.start < min) min = ref.start;
                if (i === 0 || ref.end > max) max = ref.end;
            }
            if (min < 0) min = 0;
            if (max > it.duration) max = it.duration;
            t.start = min;
            t.end = max;
            if (t.time < min || t.time > max) t.time = min;   // playhead elsewhere: the note sits at the start of the layer
            // Properties the user selected in the timeline (e.g. "Transform > Position").
            var props = [];
            try {
                var sp = it.selectedProperties;
                for (var j = 0; j < sp.length && props.length < 12; j++) {
                    if (sp[j].propertyType === PropertyType.PROPERTY) props.push(wt_propPath(sp[j]));
                }
            } catch (e1) {}
            if (props.length) t.properties = props;
        } else if (scope === 'whole') {
            t.start = 0;
            t.end = it.duration;
        }
        t.time = wt_round(t.time, 6);
        t.start = wt_round(t.start, 6);
        t.end = wt_round(t.end, 6);
        t.timecode = wt_tc(it, t.time);
        t.startTimecode = wt_tc(it, t.start);
        t.endTimecode = wt_tc(it, t.end);
        return wt_stringify({ host: 'AEFT', project: project, scope: scope, target: t });
    } catch (e) {
        return wt_err(e);
    }
}

// ---------------------------------------------------------------- jump

function wt_clampTime(comp, t) {
    t = Number(t) || 0;
    var last = comp.duration - comp.frameDuration;
    if (t > last) t = last;
    if (t < 0) t = 0;
    return t;
}

// json: the target of a note. Opens the composition, moves the time, selects the layers.
function wt_jump(json) {
    try {
        var a = wt_parse(json) || {};
        if (!wt_project()) return wt_fail('no-project');
        var it = wt_findItem(a.container);
        if (!it) return wt_fail('container-missing', a.container ? String(a.container.name) : '');
        var i;
        if (!(it instanceof CompItem)) {
            var cur = app.project.selection;
            for (i = 0; i < cur.length; i++) cur[i].selected = false;
            it.selected = true;
            return wt_stringify({ ok: true, selected: 1, missing: 0 });
        }
        it.openInViewer();
        it.time = wt_clampTime(it, a.time);
        WT_LAST_COMP = it.id;
        var selected = 0;
        if (a.items && a.items.length) {
            var sel = it.selectedLayers;
            for (i = 0; i < sel.length; i++) sel[i].selected = false;
            for (i = 0; i < a.items.length; i++) {
                var l = wt_findLayer(it, a.items[i]);
                if (l) {
                    try { l.selected = true; selected++; } catch (e1) {}
                }
            }
        }
        return wt_stringify({ ok: true, selected: selected, missing: (a.items ? a.items.length : 0) - selected });
    } catch (e) {
        return wt_err(e);
    }
}

// ---------------------------------------------------------------- markers

function wt_isOurMarker(mv, id) {
    try {
        var p = mv.getParameters();
        if (p && String(p.watchTimeline) === String(id)) return true;
    } catch (e) {}
    return false;
}

function wt_markerValue(a, duration) {
    var mv = new MarkerValue(String(a.name));
    try { if (duration > 0) mv.duration = duration; } catch (e1) {}
    try { mv.label = Number(a.color); } catch (e2) {}
    var p = {};
    p.watchTimeline = String(a.id);
    try { mv.setParameters(p); } catch (e3) {}
    return mv;
}

// A marker at exactly the time of another one would replace it: move on by a frame.
function wt_freeTime(prop, t, step) {
    var guard = 0;
    while (prop.numKeys > 0 && guard++ < 300) {
        var k = prop.nearestKeyIndex(t);
        if (Math.abs(prop.keyTime(k) - t) > step / 2) break;
        t += step;
    }
    return t;
}

// Calls fn(markerProperty, keyIndex, where, layer) for every marker of the note.
function wt_eachMarker(comp, id, fn) {
    var n = 0;
    var props = [];
    try { props.push([comp.markerProperty, 'comp', null]); } catch (e) {}
    for (var i = 1; i <= comp.numLayers; i++) {
        try {
            var l = comp.layer(i);
            if (l.marker.numKeys > 0) props.push([l.marker, 'layer', l]);
        } catch (e1) {}
    }
    for (var p = 0; p < props.length; p++) {
        var prop = props[p][0];
        for (var k = prop.numKeys; k >= 1; k--) {
            var mv = null;
            try { mv = prop.keyValue(k); } catch (e2) {}
            if (mv && wt_isOurMarker(mv, id)) {
                fn(prop, k, props[p][1], props[p][2], mv);
                n++;
            }
        }
    }
    return n;
}

// json: { container, scope, time, start, end, id, name, comment, color, items }
function wt_markerAdd(json) {
    try {
        var a = wt_parse(json) || {};
        var comp = wt_findItem(a.container);
        if (!(comp instanceof CompItem)) return wt_stringify({ markers: [] });   // project items have no timeline
        var step = comp.frameDuration;
        var made = [];
        app.beginUndoGroup('WatchTimeline: note');
        try {
            var time = wt_clampTime(comp, a.time);
            if (a.scope === 'selection' && a.items && a.items.length) {
                for (var i = 0; i < a.items.length; i++) {
                    var l = wt_findLayer(comp, a.items[i]);
                    if (!l) continue;
                    var t = time;
                    var lo = Math.min(l.inPoint, l.outPoint);
                    var hi = Math.max(l.inPoint, l.outPoint);
                    if (t < lo || t > hi) t = lo;
                    t = wt_freeTime(l.marker, t, step);
                    l.marker.setValueAtTime(t, wt_markerValue(a, 0));
                    made.push({ where: 'layer', layerId: wt_layerId(l), layerIndex: l.index, time: wt_round(t) });
                }
            }
            if (!made.length) {
                var mp = comp.markerProperty;
                var ct = wt_freeTime(mp, time, step);
                mp.setValueAtTime(ct, wt_markerValue(a, 0));
                made.push({ where: 'comp', time: wt_round(ct) });
            }
        } catch (e1) {
            app.endUndoGroup();
            return wt_err(e1);
        }
        app.endUndoGroup();
        return wt_stringify({ markers: made });
    } catch (e) {
        return wt_err(e);
    }
}

function wt_markerUpdate(json) {
    try {
        var a = wt_parse(json) || {};
        var comp = wt_findItem(a.container);
        if (!(comp instanceof CompItem)) return wt_stringify({ updated: 0 });
        app.beginUndoGroup('WatchTimeline: note');
        var n = 0;
        try {
            n = wt_eachMarker(comp, a.id, function (prop, k, where, layer, mv) {
                var dur = 0;
                try { dur = mv.duration; } catch (e0) {}
                prop.setValueAtKey(k, wt_markerValue(a, dur));
            });
        } catch (e1) {}
        app.endUndoGroup();
        return wt_stringify({ updated: n });
    } catch (e) {
        return wt_err(e);
    }
}

function wt_markerRemove(json) {
    try {
        var a = wt_parse(json) || {};
        var comp = wt_findItem(a.container);
        if (!(comp instanceof CompItem)) return wt_stringify({ removed: 0 });
        app.beginUndoGroup('WatchTimeline: note');
        var n = 0;
        try {
            n = wt_eachMarker(comp, a.id, function (prop, k) { prop.removeKey(k); });
        } catch (e1) {}
        app.endUndoGroup();
        return wt_stringify({ removed: n });
    } catch (e) {
        return wt_err(e);
    }
}

// ---------------------------------------------------------------- frame

// json: { container, time, path } – path without ".png".
function wt_frame(json) {
    try {
        var a = wt_parse(json) || {};
        var comp = wt_findItem(a.container);
        if (!(comp instanceof CompItem)) return wt_fail('frame-failed', 'Not a composition.');
        var f = new File(String(a.path) + '.png');
        comp.saveFrameToPng(wt_clampTime(comp, a.time), f);
        var bpc = 8;
        try { bpc = app.project.bitsPerChannel; } catch (e1) {}
        return wt_stringify({ ok: true, path: f.fsName, bpc: bpc });
    } catch (e) {
        return wt_err(e, 'frame-failed');
    }
}

// ---------------------------------------------------------------- inspect

function wt_val(v) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === 'number') return wt_round(v);
    if (t === 'boolean' || t === 'string') return v;
    if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length && i < 16; i++) a.push(wt_val(v[i]));
        return a;
    }
    try {
        if (v instanceof TextDocument) {
            var d = { text: String(v.text) };
            try { d.font = String(v.font); d.fontSize = v.fontSize; } catch (e0) {}
            return d;
        }
    } catch (e1) {}
    try { if (v instanceof MarkerValue) return { comment: String(v.comment) }; } catch (e2) {}
    try { if (v instanceof Shape) return { shape: true, vertices: v.vertices.length, closed: v.closed }; } catch (e3) {}
    return String(v);
}

function wt_propInfo(p, time, path) {
    var o = { path: path, matchName: String(p.matchName) };
    // preExpression = true: the value is read without running the expression.
    try {
        if (p.propertyValueType === PropertyValueType.CUSTOM_VALUE) o.value = '[custom]';
        else o.value = wt_val(p.valueAtTime(time, true));
    } catch (e) {
        o.value = null;
    }
    try {
        if (p.numKeys > 0) {
            o.keys = p.numKeys;
            o.keyTimes = [];
            // The keys around the time of the note.
            var near = p.nearestKeyIndex(time);
            var from = Math.max(1, near - 12);
            var to = Math.min(p.numKeys, from + 24);
            for (var k = from; k <= to; k++) o.keyTimes.push(wt_round(p.keyTime(k)));
        }
    } catch (e1) {}
    try {
        if (p.expressionEnabled && p.expression) {
            var ex = String(p.expression);
            o.expression = ex.length > 240 ? ex.substring(0, 240) + '...' : ex;
        }
    } catch (e2) {}
    return o;
}

function wt_isBasicTransform(matchName) {
    return matchName === 'ADBE Anchor Point' || matchName === 'ADBE Position' || matchName === 'ADBE Scale' ||
        matchName === 'ADBE Rotate Z' || matchName === 'ADBE Opacity';
}

/*
 * Collects the properties of a group that say something: changed from the
 * default, animated or driven by an expression. "force" lists all (Transform).
 * budget.props limits the result, budget.visits the walk (shape layers with
 * thousands of paths).
 */
function wt_walk(group, time, out, budget, names, force) {
    var n = 0;
    try { n = group.numProperties; } catch (e) { return; }
    for (var i = 1; i <= n; i++) {
        if (budget.props <= 0 || budget.visits <= 0) { budget.cut = true; return; }
        budget.visits--;
        var p = null;
        try { p = group.property(i); } catch (e1) { continue; }
        if (!p) continue;
        try {
            if (p.propertyType === PropertyType.PROPERTY) {
                var type = p.propertyValueType;
                if (type === PropertyValueType.NO_VALUE || type === PropertyValueType.MARKER) continue;
                // X / Y / Z Position only count when the dimensions are separated.
                var pm = String(p.matchName);
                if (pm.indexOf('ADBE Position_') === 0) {
                    var sep = false;
                    try { sep = group.property('ADBE Position').dimensionsSeparated; } catch (e4) {}
                    if (!sep) continue;
                }
                // Transform: the five basic values always, the rest only when it is in use.
                var keep = force && wt_isBasicTransform(String(p.matchName));
                if (!keep) { try { keep = p.numKeys > 0 || p.expressionEnabled || p.isModified; } catch (e2) { keep = false; } }
                if (!keep) continue;
                out.push(wt_propInfo(p, time, names.concat([String(p.name)]).join(' > ')));
                budget.props--;
            } else if (names.length < 9) {
                var mn = String(p.matchName);
                if (mn === 'ADBE Marker') continue;
                wt_walk(p, time, out, budget, names.concat([String(p.name)]), mn === 'ADBE Transform Group');
            }
        } catch (e3) {}
    }
}

function wt_layerInfo(l, time, deep) {
    var info = wt_layerRef(l);
    try { info.enabled = l.enabled; } catch (e0) {}
    try { info.locked = l.locked; info.shy = l.shy; info.solo = l.solo; } catch (e1) {}
    try { info.startTime = wt_round(l.startTime); info.stretch = wt_round(l.stretch); } catch (e2) {}
    try { info.activeAtTime = l.activeAtTime(time); } catch (e3) {}
    try { if (l.parent) info.parent = { index: l.parent.index, name: String(l.parent.name) }; } catch (e4) {}
    try { info.threeD = !!l.threeDLayer; } catch (e5) {}
    try {
        if (l.source) {
            info.source = { name: String(l.source.name), id: l.source.id };
            if (l.source instanceof FootageItem && l.source.mainSource instanceof FileSource && l.source.mainSource.file) {
                info.source.file = String(l.source.mainSource.file.fsName);
            }
            if (l.source instanceof FootageItem && l.source.mainSource instanceof SolidSource) {
                info.source.color = wt_val(l.source.mainSource.color);       // 0 to 1
            }
        }
    } catch (e6) {}
    try { if (l.timeRemapEnabled) info.timeRemap = true; } catch (e7) {}
    try {
        var fx = l.property('ADBE Effect Parade');
        if (fx && fx.numProperties > 0) {
            info.effects = [];
            for (var i = 1; i <= fx.numProperties && i <= 40; i++) {
                var e = fx.property(i);
                info.effects.push({ index: i, name: String(e.name), matchName: String(e.matchName), enabled: e.enabled });
            }
        }
    } catch (e8) {}
    if (deep) {
        var budget = { props: 120, visits: 2500, cut: false };
        info.properties = [];
        wt_walk(l, time, info.properties, budget, [], false);
        if (budget.cut) info.propertiesTruncated = true;
    }
    return info;
}

/*
 * json: the target of a note (+ scope, all).
 * "selection": the layers of the note with their properties. Else: every layer
 * that is visible or audible at the time, with properties. "whole" lists all
 * layers briefly (with "all": with properties).
 */
function wt_inspect(json) {
    try {
        var a = wt_parse(json) || {};
        if (!wt_project()) return wt_fail('no-project');
        var it = wt_findItem(a.container);
        if (!it) return wt_fail('container-missing');
        var out = { host: 'AEFT', scope: a.scope || 'time' };
        if (!(it instanceof CompItem)) {
            var info = { name: String(it.name), id: it.id, kind: wt_itemKind(it) };
            try {
                if (it instanceof FootageItem) {
                    info.width = it.width; info.height = it.height; info.duration = wt_round(it.duration);
                    if (it.mainSource instanceof FileSource && it.mainSource.file) info.file = String(it.mainSource.file.fsName);
                    info.usedIn = [];
                    var used = it.usedIn;
                    for (var u = 0; u < used.length && u < 40; u++) info.usedIn.push({ name: String(used[u].name), id: used[u].id });
                } else if (it instanceof FolderItem) {
                    info.items = [];
                    for (var f = 1; f <= it.numItems && f <= 80; f++) info.items.push({ name: String(it.item(f).name), id: it.item(f).id, kind: wt_itemKind(it.item(f)) });
                }
            } catch (e0) {}
            out.item = info;
            return wt_stringify(out);
        }
        var time = wt_clampTime(it, a.time);
        out.comp = {
            name: String(it.name), id: it.id, width: it.width, height: it.height, fps: wt_round(it.frameRate, 3),
            duration: wt_round(it.duration), numLayers: it.numLayers,
            workAreaStart: wt_round(it.workAreaStart), workAreaDuration: wt_round(it.workAreaDuration)
        };
        try { out.comp.bgColor = wt_val(it.bgColor); } catch (e9) {}
        out.time = wt_round(time);
        out.timecode = wt_tc(it, time);
        out.start = a.start === undefined ? out.time : wt_round(a.start);
        out.end = a.end === undefined ? out.time : wt_round(a.end);
        out.layers = [];
        out.truncated = false;

        var targets = [];
        var i;
        for (i = 0; a.items && i < a.items.length; i++) {
            var tl = wt_findLayer(it, a.items[i]);
            if (tl) targets.push(tl.index);
            else {
                if (!out.missing) out.missing = [];
                out.missing.push(String(a.items[i].name));
            }
        }
        var isTarget = function (index) {
            for (var t = 0; t < targets.length; t++) if (targets[t] === index) return true;
            return false;
        };
        var whole = a.scope === 'whole';
        var bySelection = a.scope === 'selection' && targets.length > 0;
        for (i = 1; i <= it.numLayers; i++) {
            var l = it.layer(i);
            var target = isTarget(i);
            var active = false;
            try { active = l.activeAtTime(time); } catch (e1) {}
            // Layers that are not the note's own are listed too when they are active at the
            // time (they may cover the target), but without their properties.
            var take = whole ? true : (active || target);
            if (!take) continue;
            if (out.layers.length >= (whole && !a.all ? 200 : 40)) { out.truncated = true; break; }
            var li = wt_layerInfo(l, time, a.all === true || target || (!whole && !bySelection));
            li.isTarget = target;
            out.layers.push(li);
        }
        if (a.properties) out.selectedProperties = a.properties;
        return wt_stringify(out);
    } catch (e) {
        return wt_err(e);
    }
}
