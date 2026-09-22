#!/bin/sh
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown nodejs:nodejs /data 2>/dev/null || true
  exec runuser -u nodejs -- node dist/server.js
fi
exec node dist/server.js
