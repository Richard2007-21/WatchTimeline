---
name: watch-timeline
description: Work through the change notes a user pinned in the WatchTimeline panel of Adobe Premiere Pro or After Effects. Each note is a spot in the timeline (a point in time, selected clips or layers, or a whole sequence or composition) plus a sentence saying what should change there. Use this skill when the user says "watch timeline", "/watch-timeline", "WatchTimeline", "work through my timeline notes", "apply my notes in Premiere / After Effects", "arbeite meine Notizen ab", "mach die Änderungen aus der Timeline", "geh meine Timeline-Notizen durch", or asks to fix the things they marked in Premiere or After Effects. The skill reads the open notes, looks only at each note's spot, changes only what the note asks for, and reports back so the note moves to "to check" in the panel.
---

# WatchTimeline

The user marks spots in Premiere Pro or After Effects with the **WatchTimeline** panel and writes what
should change there. You work through those notes. The extension runs inside the app and answers a small
command line, `scripts/wt.js` in this skill's folder. Everything goes through it.

Set this once per session (use the real path of this skill's folder):

```bash
WT="node <this skill's folder>/scripts/wt.js"
```

## The one rule

**Change only what a note asks for, only at the spot the note points to.** The user checks every note
afterwards by jumping to its spot. A change somewhere else is a change nobody checks.

- Do not improve, tidy up or fix things no note mentions, even when they look wrong. Mention them in your
  final message instead.
- Do not save, close, export or render the project. The user saves.
- Do not touch notes that are not `open` (the list only shows open ones).
- When a note is unclear, or doing it would change other places (for example a ripple edit that moves
  everything after it), do not guess: hand it back with `ask`.

## Workflow

### 1. Check the connection

```bash
$WT status
```

It prints the app, the project, what is in front, and how many notes wait. If it says WatchTimeline does
not answer: the app is not running, no project is open, or the extension is not installed. Tell the user
to open Premiere Pro or After Effects and the panel (**Window › Extensions › WatchTimeline**), then stop.
Do not start or quit the app yourself.

When both apps run, add `--host ppro` or `--host ae` to commands that have no note id.

### 2. Read the notes

```bash
$WT notes
```

Each note looks like this:

```
[8a7645] OPEN – ONLY clip "Interview.mp4" on A1 (0 s to 8 s) in sequence "Main Cut"; the user looked at 00:00:03:00 (3 s)
  Note: Hier ist der Ton zu laut, bitte 6 dB leiser
  Thread so far (earlier changes are still in the project):
    Claude changed: Pegel von 0 dB auf −6 dB gesenkt.
    User, not happy yet: Noch etwas leiser, insgesamt −9 dB
```

What the target means:

| The note says | You may change |
|---|---|
| `ONLY the spot at <time>` | What is visible or audible at that time: the clips under the playhead, or the layers active then. Of those, only what the note's text is about. |
| `ONLY clip …` / `ONLY layer …` | Exactly those clips or layers (`isTarget: true` in `inspect`). Nothing else, even if it sits at the same time. |
| `the whole sequence / composition` | Anything in that sequence or composition that the text asks for. Not other sequences, not other compositions (also not precomps, unless the text says so). |
| `the whole project item` | That footage item or folder (After Effects only). |

A **thread** means the note came back: you changed something, the user was not happy or answered your
question. The earlier change is still in the project. Build on it; do not start from zero. The last
line of the thread is what to do now.

No open notes? Say so (and how many wait for the user's check), then stop.

### 3. For every open note

Work in the order printed. If a note changes durations in Premiere, do the later notes of that sequence
first, so times of the other notes stay valid.

**a) Look at the spot.**

```bash
$WT inspect <id>          # clips or layers there, effects, current values, keyframes
$WT frame <id>            # renders that frame, prints the PNG path – then read the image
```

`inspect` is your ground truth for names, indexes and values. Use `frame` when the note is about how
something looks. `--time <seconds>` looks at another moment of the same sequence or composition.
In Premiere, `frame` moves the playhead to that time.

**b) Decide the smallest change that does what the note says.** Read the app's reference first:

- Premiere Pro: [references/premiere.md](references/premiere.md)
- After Effects: [references/after-effects.md](references/after-effects.md)

If you cannot do it reliably through scripting, or the note can mean two different things, use `ask`
(step d) instead of an approximation.

**c) Change it.** Write an ExtendScript file and run it:

```bash
$WT eval /path/to/change.jsx --note <id>
```

Rules for the script (the references show patterns):

- ExtendScript is old JavaScript (ES3): `var` only, no arrow functions, no `let`/`const`, no template
  strings, no `JSON`, no `Array.prototype.map/forEach/indexOf`.
- Wrap it in a function and return what you did: `(function () { …; return { scaleBefore: 100, scaleAfter: 120 }; })();`
  The return value is printed as JSON. Return before/after values; they are your proof.
- Never call `alert()`, `confirm()`, `prompt()` or anything that opens a dialog. The app would block.
- Errors are caught and printed with the line number. Nothing after the failing line ran, but everything
  before it did: check with `inspect` before you try again.
- In After Effects, one `eval` is one undo step named after the note. Do not call `app.beginUndoGroup`.
- Prefer plain values and keyframes over expressions, so the user can adjust the result by hand.
- Put your script files in a temporary or scratch folder, not into the user's project folder.

**d) Check, then report.**

Run `inspect` again (and `frame` if it is about the look) and compare with what the note asked.

```bash
$WT done <id> --summary "Skalierung von Drone.mp4 von 100 % auf 120 % gesetzt."
```

Write the summary in the language of the note, one or two sentences, with the concrete values you set.
It is shown on the note in the panel, so the user knows what to look at.

If you changed nothing because you need to know something:

```bash
$WT ask <id> --question "Meinst du Interview.mp4 oder Drone.mp4? Ausgewählt waren beide."
```

The question appears on the note. The user answers in the panel; the note is open again on your next run.

Report every note with exactly one of `done` or `ask`. A note you tried and broke is not `done`: undo your
partial change with a second script (you know the before-values), then `ask`.

### 4. Tell the user

End with a short list: per note, what you changed or what you asked. Then say what happens next:

- `status` said **manual**: the notes are now under **To check / Zu prüfen** in the panel. Clicking a note
  jumps to the spot; **Looks good / Passt** ticks it off, **Again / Nochmal** sends it back to you with
  new words.
- `status` said **automatic**: the notes are done and their markers are gone.

Mention the undo shortcut for anything risky, and anything you noticed but did not touch.

## Commands

| Command | What it does |
|---|---|
| `status` | App, project, what is in front, note counts, manual or automatic mode |
| `notes [--all] [--json]` | Open notes. `--all` shows every status |
| `show <id>` | One note with its full target as JSON |
| `inspect <id> [--time s] [--all]` | Clips or layers at the note's spot with effects and values. `--all`: values for everything listed |
| `inspect --here` | The same for the current playhead position |
| `frame <id> [--time s] [--out file.png]` | Renders one frame, prints the PNG path |
| `eval <file.jsx> [--note id]` | Runs ExtendScript in the app, prints `{ ok, value }` |
| `eval --code "<script>"` | The same for a one-liner |
| `done <id> --summary "…"` | The note is changed |
| `ask <id> --question "…"` | Nothing changed, the user has to answer first |
| `jump <id>` | Moves the playhead to the note and selects its clips or layers |

Errors are JSON on stderr with `error`, `detail` and sometimes `hint`; the exit code is not 0.
`not-answering` or `timeout` usually means a dialog is open in the app: ask the user to close it.

Other tools that control the app (for example a Premiere MCP server) may do the change itself when they
fit better. Notes are still read with `notes` and reported with `done` or `ask`.

## Without Node.js

`wt.js` only writes and reads small files. If `node` is missing, do the same by hand: write
`{"id":"r1","cmd":"notes","args":{}}` to `<app data>/WatchTimeline/bridge/<HOST>-<version>/in/r1.json`
and read the answer from `…/out/r1.json` a moment later. `<app data>` is
`~/Library/Application Support` on macOS and `%APPDATA%` on Windows. Commands and arguments are the ones
in the table (`inspect`: `{id, time, all}`, `frame`: `{id, time, out}`, `eval`: `{file | code, undo}`,
`done`: `{id, summary}`, `ask`: `{id, question}`).
