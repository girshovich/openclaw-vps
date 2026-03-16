#!/bin/bash
set -e
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
sleep 1
exec node dist/index.js
