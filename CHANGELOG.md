# Changelog

## 1.0.0 – 2026-11-11

First release.

- Panel for Premiere Pro and After Effects: pin a note to a point in time, to selected clips or layers, or to a whole sequence or composition
- Every note is a marker in the timeline: orange = open, green = to check, yellow = question
- Claude skill `watch-timeline`: reads the open notes, looks only at each spot, changes only what the note asks for and reports what it changed
- Check list in the panel: click a note to jump to its spot, tick it off with “Looks good”, or send it back with “Again” and new words
- Claude can ask a question on a note instead of guessing; you answer in the panel
- Setting: tick notes off yourself (manual) or let them disappear as soon as Claude is done (automatic)
- Works while the panel is closed: a background service of the extension answers the skill
- Update banner: checks GitHub for a new release, installs it in place and renews the Claude skill
- English and German, light and dark interface
