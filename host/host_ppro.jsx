/*
 * WatchTimeline – ExtendScript side for Premiere Pro (needs host_common.jsx).
 *
 * A note points at a sequence (container), a time in it and, for the scope
 * "selection", at clips (track items). Times are seconds from the start of
 * the sequence; "ticks" is the exact position (254016000000 ticks per second).
 */

var WT_TICKS = 254016000000;

function wt_isAE() {
    return false;
}

function wt_project() {
    var p = null;
    try { p = app.project; } catch (e) {}
    if (!p) return null;
    var path = '';
    var name = '';
    try { path = String(p.path || ''); } catch (e2) {}
    try { name = String(p.name || ''); } catch (e3) {}
    if (!path && !name) return null;
    return { path: path, name: name };
}

function wt_seqFps(seq) {
    try {
        var tb = Number(seq.timebase);
        if (tb > 0) return WT_TICKS / tb;
    } catch (e) {}
    return 25;
}

function wt_zero(seq) {
    try { return Number(seq.zeroPoint) / WT_TICKS; } catch (e) { return 0; }
}

// Timecode as the sequence shows it (start timecode and drop frame included).
function wt_tc(seq, seconds) {
    var abs = seconds + wt_zero(seq);
    try {
        var st = seq.getSettings();
        var t = new Time();
        t.seconds = abs;
        var s = t.getFormatted(st.videoFrameRate, st.videoDisplayFormat);
        if (s) return String(s);
    } catch (e) {}
    return wt_simpleTc(abs, wt_seqFps(seq));
}

function wt_ticksAt(seq, seconds) {
    var tb = Number(seq.timebase);
    if (!(tb > 0)) return String(Math.round(seconds * WT_TICKS));
    var frames = Math.round(seconds * WT_TICKS / tb);
    if (frames < 0) frames = 0;
    return String(frames * tb);
}

function wt_findSeq(container) {
    if (!container) return null;
    var seqs = app.project.sequences;
    var i;
    for (i = 0; i < seqs.numSequences; i++) {
        if (String(seqs[i].sequenceID) === String(container.id)) return seqs[i];
    }
    for (i = 0; i < seqs.numSequences; i++) {
        if (String(seqs[i].name) === String(container.name)) return seqs[i];
    }
    return null;
}

// Makes the sequence of the note the active one. Returns it, or null.
function wt_activate(container) {
    var seq = app.project.activeSequence;
    if (seq && container && String(seq.sequenceID) === String(container.id)) return seq;
    var target = wt_findSeq(container);
    if (!target) return null;
    try { app.project.openSequence(target.sequenceID); } catch (e) {}
    seq = app.project.activeSequence;
    if (seq && String(seq.sequenceID) === String(target.sequenceID)) return seq;
    try { app.project.activeSequence = target; } catch (e2) {}
    return app.project.activeSequence;
}

function wt_clipRef(c) {
    return {
        kind: 'clip',
        name: String(c.name),
        mediaType: String(c.mediaType),
        nodeId: String(c.nodeId),
        start: wt_round(c.start.seconds),
        end: wt_round(c.end.seconds)
    };
}

function wt_selection(seq) {
    var out = [];
    var sel = null;
    try { sel = seq.getSelection(); } catch (e) {}
    if (!sel) return out;
    for (var i = 0; i < sel.length && out.length < 40; i++) {
        try { out.push(wt_clipRef(sel[i])); } catch (e2) {}
    }
    return out;
}

// Calls fn(clip, trackType, trackIndex) for every clip; stops when fn returns true.
function wt_eachClip(seq, fn) {
    var kinds = [['video', seq.videoTracks], ['audio', seq.audioTracks]];
    for (var k = 0; k < kinds.length; k++) {
        var tracks = kinds[k][1];
        for (var t = 0; t < tracks.numTracks; t++) {
            var clips = tracks[t].clips;
            for (var c = 0; c < clips.numItems; c++) {
                if (fn(clips[c], kinds[k][0], t) === true) return;
            }
        }
    }
}

function wt_trackLabel(type, index) {
    return (type === 'audio' ? 'A' : 'V') + (index + 1);
}

// Adds the track of every clip reference (found by its node id).
function wt_addTracks(seq, refs) {
    var left = refs.length;
    if (!left) return;
    wt_eachClip(seq, function (clip, type, index) {
        var id = String(clip.nodeId);
        for (var i = 0; i < refs.length; i++) {
            if (refs[i].track === undefined && refs[i].nodeId === id) {
                refs[i].trackType = type;
                refs[i].trackIndex = index;
                refs[i].track = wt_trackLabel(type, index);
                left--;
            }
        }
        return left <= 0;
    });
}

function wt_findClip(seq, ref) {
    var hit = null;
    wt_eachClip(seq, function (clip) {
        if (String(clip.nodeId) === String(ref.nodeId)) { hit = clip; return true; }
    });
    if (hit) return hit;
    // The clip was replaced or cut: take the one on the same track at the same place.
    wt_eachClip(seq, function (clip, type, index) {
        if (ref.trackType !== undefined && (type !== ref.trackType || index !== ref.trackIndex)) return false;
        var s = Number(clip.start.seconds);
        var e = Number(clip.end.seconds);
        var mid = (Number(ref.start) + Number(ref.end)) / 2;
        if (s <= mid && e >= mid) { hit = clip; return true; }
    });
    return hit;
}

// ---------------------------------------------------------------- context

// Cheap: called while the mouse is over the panel.
function wt_context() {
    try {
        var out = { host: 'PPRO', project: wt_project(), container: null, time: 0, timecode: '', fps: 0, duration: 0, selection: [] };
        if (!out.project) return wt_stringify(out);
        var seq = app.project.activeSequence;
        if (!seq) return wt_stringify(out);
        var pos = seq.getPlayerPosition();
        out.container = { type: 'sequence', name: String(seq.name), id: String(seq.sequenceID) };
        out.time = wt_round(pos.seconds, 6);
        out.ticks = String(pos.ticks);
        out.fps = wt_round(wt_seqFps(seq), 3);
        out.timecode = wt_tc(seq, Number(pos.seconds));
        out.duration = wt_round(Number(seq.end) / WT_TICKS);
        out.selection = wt_selection(seq);
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
        var seq = app.project.activeSequence;
        if (!seq) return wt_fail('no-container');
        var pos = seq.getPlayerPosition();
        var time = Number(pos.seconds);
        var duration = Number(seq.end) / WT_TICKS;
        var scope = a.scope === 'selection' || a.scope === 'whole' ? a.scope : 'time';
        var t = {
            container: { type: 'sequence', name: String(seq.name), id: String(seq.sequenceID) },
            time: time, ticks: String(pos.ticks), fps: wt_round(wt_seqFps(seq), 3),
            start: time, end: time, items: []
        };
        if (scope === 'selection') {
            var sel = wt_selection(seq);
            if (!sel.length) return wt_fail('no-selection');
            wt_addTracks(seq, sel);
            var min = sel[0].start;
            var max = sel[0].end;
            for (var i = 1; i < sel.length; i++) {
                if (sel[i].start < min) min = sel[i].start;
                if (sel[i].end > max) max = sel[i].end;
            }
            t.items = sel;
            t.start = min;
            t.end = max;
            if (time < min || time > max) {           // playhead elsewhere: the note sits at the start of the clip
                t.time = min;
                t.ticks = wt_ticksAt(seq, min);
            }
        } else if (scope === 'whole') {
            t.start = 0;
            t.end = duration;
        }
        t.time = wt_round(t.time, 6);
        t.start = wt_round(t.start, 6);
        t.end = wt_round(t.end, 6);
        t.timecode = wt_tc(seq, t.time);
        t.startTimecode = wt_tc(seq, t.start);
        t.endTimecode = wt_tc(seq, t.end);
        return wt_stringify({ host: 'PPRO', project: project, scope: scope, target: t });
    } catch (e) {
        return wt_err(e);
    }
}

// ---------------------------------------------------------------- jump

// json: the target of a note. Opens the sequence, moves the playhead, selects the clips.
function wt_jump(json) {
    try {
        var a = wt_parse(json) || {};
        if (!wt_project()) return wt_fail('no-project');
        var seq = wt_activate(a.container);
        if (!seq) return wt_fail('container-missing', a.container ? String(a.container.name) : '');
        seq.setPlayerPosition(a.ticks ? String(a.ticks) : wt_ticksAt(seq, Number(a.time) || 0));
        var selected = 0;
        if (a.items && a.items.length) {
            try {
                var cur = seq.getSelection();
                for (var i = 0; cur && i < cur.length; i++) cur[i].setSelected(false, false);
            } catch (e1) {}
            for (var j = 0; j < a.items.length; j++) {
                var clip = wt_findClip(seq, a.items[j]);
                if (clip) {
                    try { clip.setSelected(true, true); selected++; } catch (e2) {}
                }
            }
        }
        return wt_stringify({ ok: true, selected: selected, missing: (a.items ? a.items.length : 0) - selected });
    } catch (e) {
        return wt_err(e);
    }
}

// ---------------------------------------------------------------- markers

function wt_markerTag(id) {
    return '[WatchTimeline ' + id + ']';
}

function wt_findMarkers(seq, a) {
    var hits = [];
    var ms = seq.markers;
    var m = ms.getFirstMarker();
    var guard = 0;
    var tag = wt_markerTag(a.id);
    while (m && guard++ < 5000) {
        var ours = false;
        try {
            var guid = String(m.guid);
            for (var i = 0; a.markers && i < a.markers.length; i++) {
                if (a.markers[i].guid && a.markers[i].guid === guid) ours = true;
            }
            if (!ours && String(m.comments).indexOf(tag) >= 0) ours = true;
        } catch (e) {}
        if (ours) hits.push(m);
        m = ms.getNextMarker(m);
    }
    return hits;
}

function wt_dressMarker(m, a) {
    try { m.name = String(a.name); } catch (e) {}
    try { m.comments = String(a.comment) + '\n' + wt_markerTag(a.id); } catch (e2) {}
    try { m.setColorByIndex(Number(a.color)); } catch (e3) {}
}

// json: { container, scope, time, start, end, id, name, comment, color }
function wt_markerAdd(json) {
    try {
        var a = wt_parse(json) || {};
        var seq = wt_findSeq(a.container);
        if (!seq) return wt_fail('container-missing');
        var at = a.scope === 'selection' ? Number(a.start) : Number(a.time);
        var m = seq.markers.createMarker(at);
        wt_dressMarker(m, a);
        if (a.scope === 'selection' && Number(a.end) > at) {
            try {
                var end = new Time();
                end.seconds = Number(a.end);
                m.end = end;
            } catch (e1) {
                try { m.end = Number(a.end); } catch (e2) {}
            }
        }
        var guid = '';
        try { guid = String(m.guid); } catch (e3) {}
        return wt_stringify({ markers: [{ where: 'sequence', guid: guid, time: at }] });
    } catch (e) {
        return wt_err(e);
    }
}

function wt_markerUpdate(json) {
    try {
        var a = wt_parse(json) || {};
        var seq = wt_findSeq(a.container);
        if (!seq) return wt_fail('container-missing');
        var hits = wt_findMarkers(seq, a);
        for (var i = 0; i < hits.length; i++) wt_dressMarker(hits[i], a);
        return wt_stringify({ updated: hits.length });
    } catch (e) {
        return wt_err(e);
    }
}

function wt_markerRemove(json) {
    try {
        var a = wt_parse(json) || {};
        var seq = wt_findSeq(a.container);
        if (!seq) return wt_fail('container-missing');
        var hits = wt_findMarkers(seq, a);
        for (var i = 0; i < hits.length; i++) {
            try { seq.markers.deleteMarker(hits[i]); } catch (e1) {}
        }
        return wt_stringify({ removed: hits.length });
    } catch (e) {
        return wt_err(e);
    }
}

// ---------------------------------------------------------------- frame

// json: { container, time, ticks, path } – path without ".png".
// The playhead is put back where it was.
function wt_frame(json) {
    try {
        var a = wt_parse(json) || {};
        if (!wt_project()) return wt_fail('no-project');
        var seq = wt_activate(a.container);
        if (!seq) return wt_fail('container-missing');
        var back = '';
        try { back = String(seq.getPlayerPosition().ticks); } catch (e0) {}
        seq.setPlayerPosition(a.ticks ? String(a.ticks) : wt_ticksAt(seq, Number(a.time) || 0));
        app.enableQE();
        var qseq = qe.project.getActiveSequence();
        if (!qseq) return wt_fail('frame-failed', 'No active sequence in QE.');
        qseq.exportFramePNG(qseq.CTI.timecode, String(a.path));
        if (back) { try { seq.setPlayerPosition(back); } catch (e1) {} }
        return wt_stringify({ ok: true, path: String(a.path) + '.png' });
    } catch (e) {
        return wt_err(e, 'frame-failed');
    }
}

// ---------------------------------------------------------------- inspect

function wt_propValue(p) {
    var v = null;
    try { v = p.getValue(); } catch (e) { return null; }
    if (typeof v === 'number') return wt_round(v);
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length && i < 8; i++) a.push(typeof v[i] === 'number' ? wt_round(v[i]) : String(v[i]));
        return a;
    }
    return v === null || v === undefined ? null : String(v);
}

function wt_plain(v) {
    if (typeof v === 'number') return wt_round(v);
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length && i < 8; i++) a.push(typeof v[i] === 'number' ? wt_round(v[i]) : String(v[i]));
        return a;
    }
    return v === null || v === undefined ? null : String(v);
}

// seqTime: the time of the note in the sequence. Keyframes live in clip time.
function wt_components(clip, full, seqTime) {
    var out = [];
    var comps = null;
    try { comps = clip.components; } catch (e) {}
    if (!comps) return out;
    var offset = Number(clip.start.seconds) - Number(clip.inPoint.seconds);   // sequence time = clip time + offset
    for (var i = 0; i < comps.numItems; i++) {
        var c = comps[i];
        var info = { name: String(c.displayName), matchName: String(c.matchName), index: i };
        if (full) {
            info.properties = [];
            var props = c.properties;
            for (var j = 0; props && j < props.numItems && info.properties.length < 60; j++) {
                var p = props[j];
                var name = '';
                try { name = String(p.displayName); } catch (e2) {}
                if (!name) continue;
                var pi = { name: name, index: j, value: wt_propValue(p) };
                try {
                    if (p.isTimeVarying()) {
                        var keys = p.getKeys();
                        pi.keys = keys ? keys.length : 0;
                        // Each keyframe: time in the sequence, time in the clip (what addKey takes), value.
                        pi.keyframes = [];
                        for (var k = 0; keys && k < keys.length && k < 24; k++) {
                            var kf = { time: wt_round(Number(keys[k].seconds) + offset), clipTime: wt_round(keys[k].seconds) };
                            try { kf.value = wt_plain(p.getValueAtKey(keys[k])); } catch (e4) {}
                            pi.keyframes.push(kf);
                        }
                        // "value" above is the static value; this is the animated one at the note's time.
                        try {
                            var at = new Time();
                            at.seconds = seqTime - offset;
                            pi.valueAtTime = wt_plain(p.getValueAtTime(at));
                        } catch (e5) {}
                    }
                } catch (e3) {}
                info.properties.push(pi);
            }
        }
        out.push(info);
    }
    return out;
}

/*
 * json: the target of a note (+ scope, all).
 * Lists the clips at that spot: for "selection" the clips of the note, else
 * every clip under the time (or inside start…end). Effects with their values
 * are listed for the clips of the note and, for a point in time, for all hits.
 */
function wt_inspect(json) {
    try {
        var a = wt_parse(json) || {};
        if (!wt_project()) return wt_fail('no-project');
        var seq = wt_findSeq(a.container);
        if (!seq) return wt_fail('container-missing');
        var time = Number(a.time) || 0;
        var start = a.start === undefined ? time : Number(a.start);
        var end = a.end === undefined ? time : Number(a.end);
        var whole = a.scope === 'whole';
        if (a.scope !== 'selection' && !whole) { start = time; end = time; }
        var targets = {};
        var nTargets = 0;
        for (var i = 0; a.items && i < a.items.length; i++) { targets[String(a.items[i].nodeId)] = true; nTargets++; }

        var out = {
            host: 'PPRO',
            sequence: {
                name: String(seq.name), id: String(seq.sequenceID), fps: wt_round(wt_seqFps(seq), 3),
                duration: wt_round(Number(seq.end) / WT_TICKS),
                videoTracks: seq.videoTracks.numTracks, audioTracks: seq.audioTracks.numTracks
            },
            scope: a.scope || 'time', time: wt_round(time), timecode: wt_tc(seq, time),
            start: wt_round(start), end: wt_round(end), clips: [], truncated: false
        };
        try {
            out.sequence.width = seq.frameSizeHorizontal;
            out.sequence.height = seq.frameSizeVertical;
        } catch (e0) {}

        var eps = 0.5 / wt_seqFps(seq);
        wt_eachClip(seq, function (clip, type, index) {
            var s = Number(clip.start.seconds);
            var e = Number(clip.end.seconds);
            var isTarget = targets[String(clip.nodeId)] === true;
            var overlap = start === end ? (s <= time + eps && e > time + eps) : (s < end - eps && e > start + eps);
            if (!isTarget && !overlap) return false;
            if (out.clips.length >= 80) { out.truncated = true; return true; }
            // Effect values: for the clips of the note, and for everything under one point in time.
            var full = isTarget || a.all === true || (a.scope !== 'selection' && !whole);
            var info = {
                track: wt_trackLabel(type, index), trackType: type, trackIndex: index,
                name: String(clip.name), nodeId: String(clip.nodeId), isTarget: isTarget,
                start: wt_round(s), end: wt_round(e), startTimecode: wt_tc(seq, s), endTimecode: wt_tc(seq, e),
                inPoint: wt_round(clip.inPoint.seconds), outPoint: wt_round(clip.outPoint.seconds)
            };
            try { info.speed = wt_round(clip.getSpeed()); } catch (e1) {}
            try { info.disabled = !!clip.disabled; } catch (e2) {}
            try { if (clip.projectItem) info.media = String(clip.projectItem.getMediaPath() || clip.projectItem.name); } catch (e3) {}
            info.components = wt_components(clip, full, time);
            out.clips.push(info);
            return false;
        });
        return wt_stringify(out);
    } catch (e) {
        return wt_err(e);
    }
}
