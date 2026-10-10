# AGENTS.md

Fork of `Dokploy/cli` (origin `hamidzr/dokploy-cli`). TypeScript ESM CLI on commander + axios, Node >=18, pnpm. Adds an agent-safe build (`dokploy-agent`) with a client-side policy layer on top of the upstream generated command surface.

## Commands

- `just deps` / `just check` (biome + `tsc -b`) / `just fmt` / `just test` / `just build` / `just build-agent-safe` / `just install`
- `pnpm run dev -- <group> <action>` runs from source via tsx
- `pnpm run generate` rewrites `src/generated/commands.ts` from `openapi.json` (also runs as `prebuild`)
- `just test` runs `pretest`, which rebuilds `dist/` in full mode before vitest; `tests/cli.test.ts` spawns `dist/index.js`
- `just install` builds agent-safe, copies `dist/` to `~/.local/share/dokploy-agent`, writes `~/.local/bin/dokploy-agent` (node_modules is symlinked back to this checkout). Rerun after any change to ship it; verify with `cat ~/.local/share/dokploy-agent/dist/build-info.json` (`mode: agent-safe`, commit)
- `just live-deployment-logs` hits a real Dokploy server; do not run unless asked

## Layout

- `src/index.ts`: entry; registers hand-written commands then generated ones. Program name comes from `DOKPLOY_AGENT_BIN`
- `src/client.ts`: auth/config loading (env > `.env` > JSONC config at `DOKPLOY_CONFIG_PATH` or `$XDG_CONFIG_HOME/dokploy/config.json`), `apiGet`/`apiPost`, `agentDeployPolicy` parsing
- `src/commands/*`: hand-written overlays (`service list`/`inventory`, `application logs`, `application env`, `compose effective|summary`, `deployment read-logs`, `auth`). Each takes `agentSafe` and must enforce policy itself
- `src/redact.ts`: secret redaction applied to agent output
- `src/agent/errors.ts`: `CliError`, JSON error shape, exit codes (policy block = exit 2, `AGENT_POLICY_BLOCKED`)
- `scripts/generate.ts`: OpenAPI -> commands generator. Also owns all agent-safe classification (`SAFE_POST_ENDPOINTS`, `MUTATING_GET_ENDPOINTS`, `AGENT_PROTECTED_UPDATE_FIELDS`, `AGENT_EXPANDED_APPLICATION_ENDPOINTS`, `AGENT_STATE_ENDPOINTS`) and emits the runtime guard code (`guardAgentSafePost` etc.) as template strings
- `scripts/build-agent-safe.ts`: copies `src` to `tmp/`, generates with `--agent-safe`, compiles into `dist/`. The committed `src/generated/commands.ts` is always the full build
- `docs/agent-command-blacklist.json`: built-in hidden-command list, read by the generator (token reduction, not safety)
- `docs/agent-safe-api-surface.{md,json}`, `docs/agentic-commands.md`: hand-maintained; update when policy or overlay commands change

## Gotchas

- Never hand-edit `src/generated/commands.ts`; change `scripts/generate.ts` or `openapi.json` and regenerate. Biome ignores `src/generated/**`
- Agent-safe policy bugs live in generator template strings, so `tsc` does not typecheck them until regenerated; cover with `tests/generator.test.ts` / `tests/client.test.ts`
- GET is not automatically safe: some GETs mutate (`MUTATING_GET_ENDPOINTS`). New side-effect endpoints are denied in agent-safe unless explicitly allowlisted and guarded (project/environment, server, domain-suffix, app-name scoping via `agentDeployPolicy`)
- Agent-safe builds must not leak secrets: route new output through `sanitizeForAgent`; env commands are blind (write without echoing values)
- `agentDeployPolicy` lives in the same config file as the API token; keep docs/examples token-free. Field reference: `env.example` and `AgentDeployPolicyConfig` in `src/client.ts`
- `chore: sync OpenAPI specification` commits come from upstream; upstream merges land as `chore: merge upstream <ver>`. Keep fork changes out of upstream-owned files where possible to ease merges
- Push to `main` triggers `.github/workflows/onPushToMain.yml` (npm publish of `@dokploy/cli` if version is new). Do not bump `package.json` version or push without explicit request
- CI: `tests.yml` (check/build/test on ubuntu+windows) and `agent-safe.yml` (asserts `application delete` is blocked with exit 2) run on non-main pushes and PRs
- Canonical consumer skill: `~/dotfiles/templates/agents/skills/dokploy/SKILL.md`. Update it when the `dokploy-agent` command surface or policy semantics change
