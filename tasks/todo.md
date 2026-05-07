# TODO

## Version build metadata

- [x] Generate build metadata with package version, commit hash, build time, and mode
- [x] Show build metadata in `--version`
- [x] Verify full and agent-safe version output plus tests
- [x] Reinstall `dokploy-agent` and commit

### Review

- `--version` prints package version, short commit, build timestamp, and build mode.
- `dokploy-agent --version` uses `mode agent-safe`; full build uses `mode full`.

## User agent blacklist config

- [x] Add optional user blacklist config loading for agent-safe builds
- [x] Seed user config with unused DB commands and hide log-cleanup status by default
- [x] Add `dokploy-agent state` discovery for Docker, Traefik, and domain state commands
- [x] Update docs/tests for merged blacklist behavior
- [x] Verify build/check/test and reinstall `dokploy-agent`

### Review

- User blacklist lives at `~/.config/dokploy-agent/command-blacklist.json` and supports exact endpoints plus `group.*` wildcards.
- Installed agent hides unused DB groups and omits log cleanup status from `logs`.
- `dokploy-agent state` lists Docker container/config, Traefik config/ports/env/file, and domain lookup commands.

## Agent-safe help cleanup

- [x] Confirm why agent-safe help still shows noisy groups
- [x] Hide blocked and low-value groups from default help without removing safety metadata
- [x] Add `dokploy-agent logs` discovery command and clean unknown command errors
- [x] Regenerate/build and add tests for CLI error handling
- [x] Run checks and install updated `dokploy-agent`

### Review

- Agent-safe root help now shows focused deploy/debug groups, plus `logs` and `agent-safety`.
- Blocked commands remain callable for policy errors but are hidden from command help.
- Installed `dokploy-agent` uses its own binary name in help and log examples.

## Agent-safe CLI build

- [x] Document plan and current build process
- [x] Add agent-safe build tag/scripts
- [x] Generate safe command surface with disallowed/unavailable metadata visible to agent
- [x] Add response/log redaction helpers and apply to safe build output
- [x] Include read-log GET endpoints in safe build with redaction and output limits
- [x] Add tests for build mode, safety metadata, and redaction
- [x] Run checks and commit in meaningful units

## Token-saving command blacklist

- [x] Add separate blacklist config for useless/noisy commands
- [x] Teach agent-safe generator to hide blacklisted commands from command groups and safety lists
- [x] Expose hidden command metadata separately for debugging
- [x] Update docs and verify builds

## Agent log filtering

- [x] Keep default log bounds as context protection
- [x] Add agent-local log search and pagination/filter flags
- [x] Document server-side log query options and local fallback
- [x] Verify full and agent-safe builds

## Review

- Added agent-safe build tag and safety metadata commands
- Added redaction and log output limiting for agent-safe output
- Included read-log GET endpoints in agent-safe build
- Verified full build, agent-safe build smoke, targeted Biome check, and Vitest
