#!/bin/bash
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
(sleep 2; open http://127.0.0.1:4330) &
node src/threads/server.js
