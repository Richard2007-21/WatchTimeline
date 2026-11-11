#!/bin/bash
# Builds dist/WatchTimeline.zip for a GitHub release: the extension, the
# Claude skill, the install scripts and the READMEs, in one folder "WatchTimeline".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
STAGE="$DIST/stage/WatchTimeline"
VERSION="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$ROOT/CSXS/manifest.xml")"
SKILL_VERSION="$(tr -d '[:space:]' < "$ROOT/skill/watch-timeline/VERSION")"
if [ "$VERSION" != "$SKILL_VERSION" ]; then
  echo "Version mismatch: manifest $VERSION, skill/watch-timeline/VERSION $SKILL_VERSION" >&2
  exit 1
fi
rm -rf "$DIST/stage" "$DIST/WatchTimeline.zip"
mkdir -p "$STAGE/scripts"
for item in CSXS client host lib skill LICENSE README.md README.de.md CHANGELOG.md "Install WatchTimeline.command"; do
  cp -R "$ROOT/$item" "$STAGE/"
done
cp "$ROOT"/scripts/install-mac.sh "$ROOT"/scripts/uninstall-mac.sh "$ROOT"/scripts/install-windows.ps1 "$ROOT"/scripts/install-windows.cmd "$STAGE/scripts/"
chmod +x "$STAGE/Install WatchTimeline.command" "$STAGE"/scripts/*.sh "$STAGE/skill/watch-timeline/scripts/wt.js"
(cd "$DIST/stage" && zip -qry "$DIST/WatchTimeline.zip" WatchTimeline -x '*.DS_Store')
rm -rf "$DIST/stage"
echo "Built $DIST/WatchTimeline.zip ($VERSION)"
