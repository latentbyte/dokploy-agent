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
	pnpm exec biome check scripts src/agent src/client.ts src/commands src/index.ts src/record-fill.ts src/redact.ts tests
	pnpm exec tsc -b --pretty false

# alias for check
lint: check

# format touched source files
fmt:
	pnpm exec biome check --write scripts src/agent src/client.ts src/commands src/index.ts src/record-fill.ts src/redact.ts tests

# alias for fmt
format: fmt

# alias for fmt
fix: fmt

# run tests
test:
	pnpm test

# validate deployment log websocket behavior against live Dokploy
live-deployment-logs:
	bun --conditions=development scripts/live-deployment-logs.ts

# build full cli
build:
	pnpm run build

# build agent-safe cli
build-agent-safe:
	pnpm run build:agent-safe

# install agent-safe cli in ~/.local/bin
install: build-agent-safe
	install_dir="$HOME/.local/share/dokploy-agent"; \
	bin_path="$HOME/.local/bin/dokploy-agent"; \
	rm -rf "$install_dir"; \
	rm -f "$bin_path"; \
	mkdir -p "$install_dir" "$HOME/.local/bin"; \
	cp -R dist "$install_dir/dist"; \
	cp package.json "$install_dir/package.json"; \
	ln -s "$(pwd)/node_modules" "$install_dir/node_modules"; \
	printf '%s\n' '#!/usr/bin/env bash' 'export DOKPLOY_AGENT_BIN=dokploy-agent' 'exec node "$HOME/.local/share/dokploy-agent/dist/index.js" "$@"' > "$bin_path"; \
	chmod +x "$bin_path"
	@echo "installed $HOME/.local/bin/dokploy-agent"
