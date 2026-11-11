# After Effects – changing things with ExtendScript

Patterns for `wt.js eval`. Everything here was run against After Effects (27.x) through WatchTimeline.
Run `inspect` before and after, and return before/after values from your script.

## Contents

- [Find the composition and the layer](#find-the-composition-and-the-layer)
- [Properties: read and set](#properties-read-and-set)
- [Keyframes and easing](#keyframes-and-easing)
- [Text](#text)
- [Effects](#effects)
- [Layer timing, order, switches](#layer-timing-order-switches)
- [Solids, footage, project items](#solids-footage-project-items)
- [Expressions](#expressions)
- [Frames](#frames)
- [Quirks](#quirks)

## Find the composition and the layer

A note gives you the composition's id and name and, for layers, `id`, `index` and `name`
(see `show <id>` or `inspect <id>`). Layers are 1-based. Indexes change when layers are added or moved;
ids do not.

```javascript
(function () {
    function findComp(id, name) {
        var it = null;
        try { it = app.project.itemByID(id); } catch (e) {}      // throws for an unknown id
        if (it instanceof CompItem && it.name === name) return it;
        for (var i = 1; i <= app.project.numItems; i++) {
            var c = app.project.item(i);
            if (c instanceof CompItem && c.name === name) return c;
        }
        return null;
    }
    function findLayer(comp, id, name) {
        try {
            var l = app.project.layerByID(id);                    // After Effects 22 and later
            if (l && l.containingComp === comp) return l;
        } catch (e) {}
        for (var i = 1; i <= comp.numLayers; i++) if (comp.layer(i).name === name) return comp.layer(i);
        return null;
    }

    var comp = findComp(31, 'Main Comp');
    var layer = findLayer(comp, 48, 'Titel');
    if (!layer) return { error: 'layer not found' };
    // … change it …
    return { layer: layer.name, index: layer.index };
})();
```

For a note about a point in time, the layers that count are the ones with `layer.activeAtTime(time)`.
`app.project.activeItem` is what the user has in front; a note can be about another composition.

## Properties: read and set

Use **match names**: display names follow the interface language ("Transformieren", "Deckkraft").
`inspect` prints the match name of every property it lists.

| What | Path |
|---|---|
| Position, Scale, Rotation, Opacity, Anchor point | `layer.property('ADBE Transform Group').property('ADBE Position' / 'ADBE Scale' / 'ADBE Rotate Z' / 'ADBE Opacity' / 'ADBE Anchor Point')` |
| Effects | `layer.property('ADBE Effect Parade')` |
| Masks | `layer.property('ADBE Mask Parade')` |
| Text | `layer.property('ADBE Text Properties').property('ADBE Text Document')` |
| Shape contents | `layer.property('ADBE Root Vectors Group')` |
| Audio levels | `layer.property('ADBE Audio Group').property('ADBE Audio Levels')` (dB, `[left, right]`) |
| Time remap | `layer.property('ADBE Time Remapping')` (after `layer.timeRemapEnabled = true`) |

```javascript
var tr = layer.property('ADBE Transform Group');
var scale = tr.property('ADBE Scale');
var before = scale.value;                       // [100, 100, 100]
scale.setValue([120, 120, 100]);                // no keyframes on it
// With keyframes, setValue throws: use setValueAtTime, or change every key.
```

Position is in pixels of the composition, scale in percent, opacity 0–100, rotation in degrees.
A property with keyframes (`numKeys > 0`) cannot take `setValue`. To make an animated value 20 % bigger,
loop over the keys: `p.setValueAtKey(k, newValue)`.

## Keyframes and easing

The user edits the result by hand afterwards: prefer few keyframes with soft easing over expressions.

```javascript
var pos = layer.property('ADBE Transform Group').property('ADBE Position');
pos.setValueAtTime(1.0, [640, 800]);
pos.setValueAtTime(1.5, [640, 380]);

// Read
for (var k = 1; k <= pos.numKeys; k++) { pos.keyTime(k); pos.keyValue(k); }
var k2 = pos.nearestKeyIndex(1.5);

// Move a key: keys cannot be moved, so remove and set again
var v = pos.keyValue(2);
pos.removeKey(2);
pos.setValueAtTime(1.5, v);

// Easy ease on a key (one KeyframeEase per dimension; Position counts as one)
var ease = new KeyframeEase(0, 75);
pos.setTemporalEaseAtKey(2, [ease], [ease]);
pos.setInterpolationTypeAtKey(1, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);

// Several at once
layer.property('ADBE Transform Group').property('ADBE Opacity').setValuesAtTimes([2, 3], [0, 100]);
```

Scale, with three dimensions, needs three eases: `[ease, ease, ease]`. Times are seconds in the
composition; one frame is `comp.frameDuration`.

## Text

```javascript
var st = layer.property('ADBE Text Properties').property('ADBE Text Document');
var doc = st.value;            // a TextDocument
doc.text = 'New title';
doc.fontSize = 72;             // also: font (PostScript name), fillColor [r, g, b] 0–1, justification, tracking
st.setValue(doc);
```

Change only the fields the note asks for and keep the rest of the document as it was.

## Effects

```javascript
var fx = layer.property('ADBE Effect Parade').addProperty('ADBE Gaussian Blur 2');
fx.property('ADBE Gaussian Blur 2-0001').setValue(25);        // Blurriness
// Existing effect: by index or name, then list its properties to find match names
var first = layer.property('ADBE Effect Parade').property(1);
for (var i = 1; i <= first.numProperties; i++) { first.property(i).matchName; first.property(i).name; }
first.enabled = false;         // switch off
first.remove();                // delete
```

Common match names: `ADBE Gaussian Blur 2`, `ADBE Fast Box Blur`, `ADBE Brightness & Contrast 2`,
`ADBE HUE SATURATION`, `ADBE Exposure2`, `ADBE Tint`, `ADBE Fill`, `ADBE Drop Shadow`, `ADBE Glo2`,
`ADBE Lumetri`, `ADBE Geometry2` (Transform), `ADBE Easy Levels2`, `ADBE CurvesCustom`.
`canAddProperty(matchName)` tells you whether one exists. After `addProperty`, references to other
effects of that layer are stale: fetch them again.

## Layer timing, order, switches

```javascript
layer.startTime = 2;            // slides the whole layer
layer.inPoint = 2;              // trims the start (does not move the content)
layer.outPoint = 10;            // trims the end
layer.enabled = false;          // eye off
layer.moveBefore(otherLayer);   // order; also moveAfter, moveToBeginning, moveToEnd
layer.parent = otherLayer;      // After Effects keeps the layer in place and rewrites its transform
layer.blendingMode = BlendingMode.SCREEN;
layer.remove();
var copy = layer.duplicate();
```

New layers: `comp.layers.addSolid([r, g, b], name, width, height, 1, duration)`, `addText('…')`,
`addShape()`, `addNull()`, `comp.layers.add(projectItem)`. Composition settings (size, duration, frame
rate) change everything in it: only when the note asks.

## Solids, footage, project items

```javascript
layer.source.mainSource.color = [0.2, 0.25, 0.3];      // solid colour (0–1); changes every layer using that solid
layer.replaceSource(otherItem, false);                 // swap the footage of a layer
var io = new ImportOptions(new File('/path/picture.psd'));
var item = app.project.importFile(io);                 // new footage item
footageItem.replace(new File('/path/new.png'));        // relink a footage item
```

A note on a **project item** (`the whole project item`) has no time. `inspect` lists where the item is
used (`usedIn`); changing the item changes it in all of those compositions.

## Expressions

- Do not add an expression where two or three keyframes do the job. If one is really needed, say so in
  the summary.
- Reading `.value` of a property with an expression runs the expression, and some plug-in expressions
  stop a script without an error. Read the keyframed value instead: `p.valueAtTime(t, true)`.
- `p.expression = '…'` sets one, `p.expression = ''` removes it, `p.expressionEnabled` shows whether it runs.
- A property driven by an expression ignores the values you set. `inspect` shows `expression` on such
  properties: if the note is about one, change the expression or ask.

## Frames

`frame <id>` renders the composition at the note's time and does not move the user's time marker.
Frames of 32-bit projects are corrected to a normal picture automatically. Transparent areas stay
transparent in the PNG.

## Quirks

- One `eval` is one undo step. Do not call `app.beginUndoGroup` / `endUndoGroup` yourself.
- `app.project.itemByID(id)` throws when the id does not exist: wrap it in `try`.
- Collections are 1-based: `comp.layer(1)`, `app.project.item(1)`, `property(1)`, keys from 1.
- WatchTimeline puts a marker per note on the composition or on the note's layers (comment starts with
  `WT:`). Leave them alone; `done` and the user's tick take care of them.
- Shape layers can hold thousands of properties. Address what you need by match name
  (`ADBE Vector Group`, `ADBE Vector Graphic - Fill`, `ADBE Vector Fill Color`, `ADBE Vector Shape - Rect`, …)
  instead of walking everything.
- 3D layers have three position values and extra rotations; keep the array length you read.
- Never save or close the project, never render through the render queue.
