#!/bin/bash
# Create per-service databases on first postgres boot
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE floors_api;
    CREATE DATABASE floors_relayer;
    CREATE DATABASE floors_risk;
    CREATE DATABASE floors_registry;
    CREATE DATABASE floors_indexer;
EOSQL
