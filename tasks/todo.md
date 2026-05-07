# TODO

## Agent-safe CLI build

- [x] Document plan and current build process
- [x] Add agent-safe build tag/scripts
- [x] Generate safe command surface with disallowed/unavailable metadata visible to agent
- [x] Add response/log redaction helpers and apply to safe build output
- [x] Include read-log GET endpoints in safe build with redaction and output limits
- [x] Add tests for build mode, safety metadata, and redaction
- [x] Run checks and commit in meaningful units

## Review

- Added agent-safe build tag and safety metadata commands
- Added redaction and log output limiting for agent-safe output
- Included read-log GET endpoints in agent-safe build
- Verified full build, agent-safe build smoke, targeted Biome check, and Vitest
