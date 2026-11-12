.PHONY: test test-contracts lint typecheck build stack stack-down stack-services e2e

## Run all tests (contracts + TS packages)
test: test-contracts
	pnpm --dir . test

## Run Rust contract tests
test-contracts:
	cargo test --manifest-path contracts/Cargo.toml

## Run ESLint across all packages
lint:
	pnpm --dir . lint

## Run TypeScript type checking across all packages
typecheck:
	pnpm --dir . typecheck

## Build all packages and services
build:
	pnpm --dir . build

## Start the full local stack (docker compose): postgres + near-sandbox + mock-solver
stack:
	docker compose -f docker-compose.yml up -d

## Stop the full local stack
stack-down:
	docker compose -f docker-compose.yml down

## Start only postgres, then launch all 5 Node services in background
stack-services:
	docker compose -f docker-compose.yml up -d postgres
	pnpm --filter "@floors/api" dev &
	pnpm --filter "@floors/relayer" dev &
	pnpm --filter "@floors/risk" dev &
	pnpm --filter "@floors/registry" dev &
	pnpm --filter "@floors/indexer" dev &

## Run end-to-end tests (build extension first, then run playwright headless if CI=true)
e2e:
	pnpm --filter "@floors/extension" build
	PW_DISABLE_TS_ESM=1 CI=true pnpm --filter "@floors/extension" exec playwright test
