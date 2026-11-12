#!/bin/sh
# Floors NEAR sandbox entrypoint.
# - If neard has NOT been initialized yet, run init to create key files.
# - Then start neard using our genesis (copied from /root/.near-config).
set -e

NEAR_HOME=/root/.near

if [ ! -f "${NEAR_HOME}/node_key.json" ]; then
  echo "[sandbox] Initializing neard at ${NEAR_HOME}..."
  neard --home "${NEAR_HOME}" init --chain-id localnet
  echo "[sandbox] Init done."
fi

# Override genesis with our custom one (adds test.near with funds)
if [ -f /root/.near-config/genesis.json ]; then
  cp /root/.near-config/genesis.json "${NEAR_HOME}/genesis.json"
  echo "[sandbox] Installed custom genesis.json"
fi

echo "[sandbox] Starting neard..."
exec neard --home "${NEAR_HOME}" run
