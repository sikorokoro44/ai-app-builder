#!/bin/bash
while true; do
  node --experimental-strip-types /data/data/com.termux/files/home/opencode-chat/builder/opencode/live-view-visual.ts 2>/dev/null || node /data/data/com.termux/files/home/opencode-chat/builder/opencode/view.mjs 2>/dev/null
  sleep 1
done
