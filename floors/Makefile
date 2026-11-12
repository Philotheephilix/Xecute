.PHONY: test test-contracts lint typecheck build stack stack-services e2e

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

## Start the full local stack (docker compose)
stack:
	docker compose -f infra/docker-compose.yml up -d

## Start only the backend services
stack-services:
	docker compose -f infra/docker-compose.yml up -d api relayer risk registry indexer

## Run end-to-end tests
e2e:
	pnpm --dir . exec playwright test
