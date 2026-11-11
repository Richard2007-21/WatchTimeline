# Premiere Pro – changing things with ExtendScript

Patterns for `wt.js eval`. Everything here was run against Premiere Pro 2026 (26.x) through WatchTimeline.
Premiere's scripting has gaps and quirks: **run `inspect` before and after**, and return before/after
values from your script.

## Contents

- [Find the sequence and the clip](#find-the-sequence-and-the-clip)
- [Time](#time)
- [Effect values: Motion, Opacity, Volume](#effect-values-motion-opacity-volume)
- [Keyframes](#keyframes)
- [Trim, move, cut, remove, disable](#trim-move-cut-remove-disable)
- [Add clips](#add-clips)
- [Effects and transitions (QE)](#effects-and-transitions-qe)
- [Markers](#markers)
- [What scripting cannot do](#what-scripting-cannot-do)
- [Quirks](#quirks)

## Find the sequence and the clip

A note gives you the sequence id and, for clips, the `nodeId` (see `show <id>` or `inspect <id>`).
Clip indexes change when clips are cut or removed; node ids do not.

```javascript
(function () {
    function findSeq(id) {
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            if (String(app.project.sequences[i].sequenceID) === id) return app.project.sequences[i];
        }
        return null;
    }
    // Calls fn(clip, 'video' | 'audio', trackIndex); stops when fn returns true.
    function eachClip(seq, fn) {
        var kinds = [['video', seq.videoTracks], ['audio', seq.audioTracks]];
        for (var k = 0; k < kinds.length; k++) {
            for (var t = 0; t < kinds[k][1].numTracks; t++) {
                var clips = kinds[k][1][t].clips;
                for (var c = 0; c < clips.numItems; c++) if (fn(clips[c], kinds[k][0], t) === true) return;
            }
        }
    }
    function findClip(seq, nodeId) {
        var hit = null;
        eachClip(seq, function (clip) { if (String(clip.nodeId) === nodeId) { hit = clip; return true; } });
        return hit;
    }
    function component(clip, matchName) {
        for (var i = 0; i < clip.components.numItems; i++) {
            if (String(clip.components[i].matchName) === matchName) return clip.components[i];
        }
        return null;
    }

    var seq = findSeq('7018a7f8-7de2-4e21-8138-1c6ef26adc48');
    var clip = findClip(seq, '000f4248');
    if (!clip) return { error: 'clip not found' };
    // … change it …
    return { name: String(clip.name), start: clip.start.seconds, end: clip.end.seconds };
})();
```

For a note about a point in time, take the clips whose `start.seconds <= time < end.seconds`.
A clip with linked audio is two track items (one on V, one on A) with the same name and times.

## Time

- Times in notes and in `inspect` are seconds from the start of the sequence.
- `clip.start`, `clip.end`, `clip.inPoint`, `clip.outPoint`, `seq.getPlayerPosition()` are `Time` objects:
  read `.seconds`. To set one: `var t = new Time(); t.seconds = 7; clip.end = t;`
- `seq.setPlayerPosition(ticksAsString)`: one second is 254016000000 ticks. Frame exact:
  `String(Math.round(seconds * fps) * Number(seq.timebase))`.
- `seq.timebase` is ticks per frame, so `fps = 254016000000 / Number(seq.timebase)`.

## Effect values: Motion, Opacity, Volume

The interface language changes `displayName` ("Skalieren", "Deckkraft"). **Find components by `matchName`
and properties by index**; `inspect` prints both.

| Component | `matchName` | Properties (index: meaning) |
|---|---|---|
| Motion | `AE.ADBE Motion` | 0 Position `[x, y]` as fractions of the frame, `[0.5, 0.5]` = centre · 1 Scale (%) · 2 Scale width · 3 Uniform scale (bool) · 4 Rotation (°) · 5 Anchor point `[x, y]` fractions · 7–10 Crop left, top, right, bottom (%) |
| Opacity | `AE.ADBE Opacity` | 0 Opacity (0–100) · 1 Blend mode |
| Volume (audio clips) | `Internal Volume Mono` or `Internal Volume Stereo` | 1 Level |

```javascript
var motion = component(clip, 'AE.ADBE Motion');
var scale = motion.properties[1];
var before = scale.getValue();
scale.setValue(120, true);            // second argument: update the interface
```

**Audio level is not in dB.** `value = Math.pow(10, (dB - 15) / 20)`, so 0 dB is 0.1778 and −6 dB is 0.0891.
Back: `dB = 20 * Math.log(value) / Math.LN10 + 15`.

```javascript
var vol = component(audioClip, 'Internal Volume Mono') || component(audioClip, 'Internal Volume Stereo');
vol.properties[1].setValue(Math.pow(10, (-6 - 15) / 20), true);
```

Other effects: read their component and property list with `inspect <id>` first. Colour values come back
in forms that differ per effect; change them only when you could read them.

## Keyframes

Keyframe times are **clip time**, not sequence time:
`clipTime = clip.inPoint.seconds + (sequenceSeconds - clip.start.seconds)`.

```javascript
// Fade a clip out over its last second.
var op = component(clip, 'AE.ADBE Opacity').properties[0];
var t1 = clip.inPoint.seconds + (clip.end.seconds - 1 - clip.start.seconds);
var t2 = clip.inPoint.seconds + (clip.end.seconds - clip.start.seconds);
op.setTimeVarying(true);
op.addKey(t1); op.setValueAtKey(t1, 100, true);
op.addKey(t2); op.setValueAtKey(t2, 0, true);
```

Read them back: `if (op.isTimeVarying()) { var keys = op.getKeys(); … }` (array of `Time`), then
`op.getValueAtKey(keys[i])`. On a property without keyframes `getKeys()` returns `undefined`, so check
`isTimeVarying()` first. `op.getValue()` is the static value; the animated value at a moment is
`op.getValueAtTime(timeObject)` in clip time. `inspect` prints all of this as `keyframes` and `valueAtTime`.
Remove one: `var t = new Time(); t.seconds = t1; op.removeKey(t);` (a `Time` object, not a number). Remove all: `op.setTimeVarying(false)`.
A frame of a faded clip is transparent in the PNG, not black.

## Trim, move, cut, remove, disable

```javascript
var t = new Time(); t.seconds = 7;
clip.end = t;                         // right edge to 7 s (leaves a gap, nothing else moves)

var s = new Time(); s.seconds = 9;
clip.start = s;                       // left edge to 9 s

var d = new Time(); d.seconds = 1;
clip.move(d);                         // shift the clip by +1 s (negative: earlier)

clip.disabled = true;                 // switch the clip off
clip.remove(false, false);            // remove without closing the gap
clip.remove(true, true);              // ripple delete: everything after it moves – only if the note asks for it
```

After setting `start` or `end`, `inPoint` / `outPoint` can read stale. Trust `start` and `end`, and check
the picture with `frame` when the source position matters.

Cut (razor) at a time, with the QE object model. Timecode is `HH:MM:SS:FF` of the sequence:

```javascript
app.enableQE();
var qseq = qe.project.getActiveSequence();        // the sequence must be active: app.project.openSequence(id)
qseq.getVideoTrackAt(0).razor('00:00:03:00');     // V1; audio: getAudioTrackAt(0)
```

A razor cut gives the two halves new node ids. A linked audio clip is cut only if you razor its track too.

## Add clips

```javascript
// item: a ProjectItem. Find it by walking app.project.rootItem.children (name or getMediaPath()).
seq.videoTracks[1].overwriteClip(item, 9);        // on V2 at 9 s, replaces what is there
seq.videoTracks[0].insertClip(item, 9);           // insert: pushes later clips – only if the note asks
app.project.importFiles(['/path/file.mp4'], true, app.project.rootItem, false);
```

## Effects and transitions (QE)

Effect and transition names are **in the interface language** ("Gaußscher Weichzeichner", "Weiche Blende").
List the real names first:

```javascript
app.enableQE();
return { effects: qe.project.getVideoEffectList(), transitions: qe.project.getVideoTransitionList() };
// audio: getAudioEffectList(), getAudioTransitionList()
```

```javascript
app.enableQE();
var qtrack = qe.project.getActiveSequence().getVideoTrackAt(0);
var qclip = null;
for (var i = 0; i < qtrack.numItems; i++) {
    var it = qtrack.getItemAt(i);                 // type is 'Clip' or 'Empty' (gaps count as items)
    if (String(it.type) === 'Clip' && String(it.start.timecode) === '00:00:08:00') qclip = it;
}
qclip.addVideoEffect(qe.project.getVideoEffectByName('Gaußscher Weichzeichner'));
qclip.addTransition(qe.project.getVideoTransitionByName('Weiche Blende'), true, '00:00:01:00');
```

`getVideoEffectByName` returns an object with an empty `name` when nothing matches. A plug-in can carry the
same name as a built-in effect: after adding, read `clip.components` and check the new `matchName` and
its properties before you set values.

## Markers

WatchTimeline puts one marker per note into the sequence (name starts with `WT:`). Leave them alone;
`done` and the user's tick take care of them.

## What scripting cannot do

Say so with `ask` instead of faking it:

- Change the speed or reverse a clip reliably
- Create titles, captions or graphics from nothing (a `.mogrt` file can be placed with `seq.importMGT`)
- Paint masks, track, stabilise, or use the Essential Sound and Lumetri panels as such (Lumetri is a
  component with many properties; set single values only after reading them with `inspect`)
- Nest, multicam, or change sequence settings safely

## Quirks

- `app.project.activeSequence` is the sequence in front. A note can be about another one: use its id.
- QE works on the active sequence only. `app.project.openSequence(id)` brings one to the front.
- `seq.getSelection()` gives the selected track items, `clip.setSelected(true, true)` selects one.
- Collections use `numItems` / `numTracks` / `numSequences`, not `length`.
- Strings from the app are objects: wrap them in `String(…)` before comparing or returning.
- Every scripted step is one entry in Premiere's history; undo steps back through them one by one.
