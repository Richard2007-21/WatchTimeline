#!/bin/bash
# Installs WatchTimeline for Premiere Pro and After Effects on macOS,
# and the Claude skill "watch-timeline" for Claude Code.
#   ./scripts/install-mac.sh             copy the extension and the skill (for users)
#   ./scripts/install-mac.sh --link      symlink this folder (for development)
#   ./scripts/install-mac.sh --no-skill  leave ~/.claude/skills alone
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/WatchTimeline"
SKILL_SRC="$SRC/skill/watch-timeline"
SKILL_DEST="$HOME/.claude/skills/watch-timeline"
LINK=0
SKILL=1
for arg in "$@"; do
  case "$arg" in
    --link) LINK=1 ;;
    --no-skill) SKILL=0 ;;
  esac
done

# Unsigned extensions need PlayerDebugMode (CSXS 9 = 2020, 12 = 2025+).
for v in 9 10 11 12 13; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done

mkdir -p "$(dirname "$DEST")"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  echo "WatchTimeline is already installed at: $DEST"
  echo "Run ./scripts/uninstall-mac.sh first to replace it."
  exit 1
fi

if [ "$LINK" = 1 ]; then
  ln -s "$SRC" "$DEST"
  echo "Linked $SRC -> $DEST"
else
  mkdir -p "$DEST"
  for item in CSXS client host lib skill LICENSE; do
    cp -R "$SRC/$item" "$DEST/"
  done
  echo "Copied the extension to $DEST"
fi

if [ "$SKILL" = 1 ]; then
  if [ -L "$SKILL_DEST" ]; then
    echo "Claude skill: $SKILL_DEST is a link, left as it is."
  elif [ -e "$SKILL_DEST" ] && ! grep -q '^name: watch-timeline' "$SKILL_DEST/SKILL.md" 2>/dev/null; then
    echo "Claude skill: another folder is at $SKILL_DEST, left as it is."
  else
    mkdir -p "$(dirname "$SKILL_DEST")"
    if [ "$LINK" = 1 ]; then
      rm -rf "$SKILL_DEST"
      ln -s "$SKILL_SRC" "$SKILL_DEST"
    else
      rm -rf "$SKILL_DEST"
      cp -R "$SKILL_SRC" "$SKILL_DEST"
    fi
    echo "Installed the Claude skill to $SKILL_DEST"
  fi
fi

echo
echo "1. Restart Premiere Pro / After Effects, then open Window > Extensions > WatchTimeline."
echo "2. Restart Claude Code. Tell Claude: /watch-timeline"
