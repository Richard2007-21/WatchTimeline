#!/bin/bash
# Double-click to install WatchTimeline for Premiere Pro and After Effects,
# and the Claude skill (macOS).
cd "$(dirname "$0")"
bash ./scripts/install-mac.sh
echo
read -n 1 -s -r -p "Press any key to close this window."
