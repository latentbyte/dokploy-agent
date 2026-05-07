set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# list targets
_default:
	@just --list

# install dependencies
deps:
	pnpm install

# alias for deps
get-deps: deps

# run static checks without changing files
check:
	pnpm exec biome check scripts/generate.ts src/redact.ts tests
	pnpm exec tsc -b --pretty false

# alias for check
lint: check

# format touched source files
fmt:
	pnpm exec biome check --write scripts/generate.ts src/redact.ts tests

# alias for fmt
format: fmt

# alias for fmt
fix: fmt

# run tests
test:
	pnpm test

# build full cli
build:
	pnpm run build

# build agent-safe cli
build-agent-safe:
	pnpm run build:agent-safe

# install cli in ~/.local/bin
install: build
	mkdir -p "$HOME/.local/bin"
	chmod +x dist/index.js
	ln -sf "$(pwd)/dist/index.js" "$HOME/.local/bin/dokploy"
	@echo "installed $HOME/.local/bin/dokploy"
