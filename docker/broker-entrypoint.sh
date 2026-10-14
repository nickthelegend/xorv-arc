#!/bin/sh
set -eu
chown node:node /data
exec gosu node "$@"
