/*
 * WatchTimeline – helpers shared by the Premiere Pro and After Effects scripts.
 * ExtendScript is ES3: no JSON object, no Array.indexOf, no trailing commas.
 * Every wt_* API function takes one JSON string and returns a JSON string.
 */

// Raised when the host functions change, so a running host reloads them.
var WT_HOST_API = '1.0.1';

function wt_ping() {
    return WT_HOST_API;
}

function wt_str(s) {
    return '"' + String(s)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/[\u0000-\u001f\u007f-\uffff]/g, function (c) {
            return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
}

// Plain values, arrays and plain objects become JSON. Host objects (layers,
// clips, …) become their name as a string, so a script result never fails.
function wt_stringify(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return 'null';
    var t = typeof v;
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'string') return wt_str(v);
    if (t === 'function') return 'null';
    if (depth > 14) return wt_str('[too deep]');
    var i;
    if (v instanceof Array) {
        var a = [];
        for (i = 0; i < v.length; i++) a.push(wt_stringify(v[i], depth + 1));
        return '[' + a.join(',') + ']';
    }
    var plain = false;
    try { plain = v.constructor === Object; } catch (e) {}
    if (!plain) {
        var s = '[object]';
        try { s = String(v); } catch (e2) {}
        try { if (v.name !== undefined && typeof v.name === 'string') s = s + ' ' + v.name; } catch (e3) {}
        return wt_str(s);
    }
    var parts = [];
    for (var k in v) {
        if (v.hasOwnProperty(k)) parts.push(wt_str(k) + ':' + wt_stringify(v[k], depth + 1));
    }
    return '{' + parts.join(',') + '}';
}

function wt_parse(s) {
    if (s === undefined || s === null || s === '') return null;
    return eval('(' + s + ')');
}

function wt_err(e, key) {
    return wt_stringify({
        error: key || 'host-failed',
        detail: String(e && e.message ? e.message : e),
        line: e && e.line ? e.line : 0
    });
}

function wt_fail(key, detail) {
    return wt_stringify({ error: key, detail: detail || '' });
}

function wt_pad(n) {
    return n < 10 ? '0' + n : String(n);
}

// HH:MM:SS:FF without drop frame. Only used when the host cannot format a time.
function wt_simpleTc(seconds, fps) {
    var f = Math.round(fps);
    if (!(f >= 1)) f = 25;
    var total = Math.round(seconds * fps);
    if (!(total >= 0)) total = 0;
    var s = Math.floor(total / f);
    return wt_pad(Math.floor(s / 3600)) + ':' + wt_pad(Math.floor(s / 60) % 60) + ':' + wt_pad(s % 60) + ':' + wt_pad(total % f);
}

function wt_round(n, digits) {
    var m = Math.pow(10, digits === undefined ? 4 : digits);
    return Math.round(Number(n) * m) / m;
}

/*
 * Runs a script file that the Claude skill wrote. The value of the last
 * expression is the result; wrap the script in a function and return a value:
 *     (function () { …; return { moved: 3 }; })();
 * Variables stay local to this call. Errors are caught and reported, so no
 * dialog blocks the host.
 */
function wt_run(json) {
    var wt_args = wt_parse(json) || {};
    var wt_file = new File(wt_args.file);
    if (!wt_file.exists) return wt_fail('script-missing', String(wt_args.file));
    wt_file.encoding = 'UTF-8';
    if (!wt_file.open('r')) return wt_fail('script-missing', String(wt_args.file));
    var wt_code = wt_file.read();
    wt_file.close();
    var wt_undo = wt_args.undo && typeof wt_isAE === 'function' && wt_isAE();
    var wt_out;
    try {
        if (wt_undo) app.beginUndoGroup(String(wt_args.undo));
        var wt_value = eval(wt_code);
        wt_out = wt_stringify({ ok: true, value: wt_value === undefined ? null : wt_value });
    } catch (e) {
        wt_out = wt_stringify({
            error: 'script-error',
            detail: String(e && e.message ? e.message : e),
            line: e && e.line ? e.line : 0
        });
    }
    if (wt_undo) { try { app.endUndoGroup(); } catch (e2) {} }
    return wt_out;
}
