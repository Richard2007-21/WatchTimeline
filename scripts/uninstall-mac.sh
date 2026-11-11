#!/bin/bash
# Removes WatchTimeline from the CEP extensions folder and the Claude skill.
# Your notes (~/Library/Application Support/WatchTimeline) are kept.
set -euo pipefail
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/WatchTimeline"
SKILL_DEST="$HOME/.claude/skills/watch-timeline"
if [ -L "$DEST" ]; then
  rm "$DEST"
  echo "Removed $DEST"
elif [ -d "$DEST" ]; then
  rm -r "$DEST"
  echo "Removed $DEST"
else
  echo "The extension is not installed."
fi
if [ -L "$SKILL_DEST" ]; then
  rm "$SKILL_DEST"
  echo "Removed $SKILL_DEST"
elif [ -d "$SKILL_DEST" ] && grep -q '^name: watch-timeline' "$SKILL_DEST/SKILL.md" 2>/dev/null; then
  rm -r "$SKILL_DEST"
  echo "Removed $SKILL_DEST"
fi
echo "Restart Premiere Pro / After Effects."
