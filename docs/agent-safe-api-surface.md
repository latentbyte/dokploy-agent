# Agent-safe API surface

This file tracks commands that are safe to expose to the agent.

Current policy: expose read-only endpoints by default. Side-effect endpoints are denied except for a deploy set constrained to one project.

## Source

Generated from `src/generated/commands.ts` (auto-generated from `openapi.json`).

## Read-only safe set

All commands below are `apiGet` based and considered safe-by-default in agent-safe builds after redaction and after the token-saving blacklist is applied.

- `application`: one, read-app-monitoring, read-logs, read-traefik-config, search
- `audit-log`: all
- `backup`: list-backup-files, one
- `bitbucket`: bitbucket-providers, get-bitbucket-branches, get-bitbucket-repositories, one
- `certificates`: all, one
- `cluster`: get-nodes
- `compose`: get-converted-compose, get-default-command, get-tags, load-mounts-by-service, load-services, one, read-logs, search, templates
- `deployment`: all, all-by-compose, all-by-server, all-by-type, all-centralized, queue-list
- `destination`: all, one
- `docker`: get-config, get-containers, get-containers-by-app-label, get-containers-by-app-name-match, get-service-containers-by-app-name, get-stack-containers-by-app-name
- `domain`: by-application-id, by-compose-id, can-generate-traefik-me-domains, one
- `environment`: by-project-id, one, search
- `git-provider`: all-for-permissions, get-all
- `gitea`: get-gitea-branches, get-gitea-repositories, get-gitea-url, gitea-providers, one
- `github`: get-github-branches, get-github-repositories, github-providers, one
- `gitlab`: get-gitlab-branches, get-gitlab-repositories, gitlab-providers, one
- `libsql`: one, read-logs
- `mariadb`: one, read-logs, search
- `mongo`: one, read-logs, search
- `mounts`: all-named-by-application-id, list-by-service-id, one
- `mysql`: one, read-logs, search
- `patch`: by-entity-id, one, read-repo-directories, read-repo-file
- `port`: one
- `postgres`: one, read-logs, search
- `preview-deployment`: all, one
- `project`: all, all-for-permissions, home-stats, one, search
- `redirects`: one
- `redis`: one, read-logs, search
- `registry`: all, one
- `schedule`: list, one
- `security`: one
- `server`: all, all-for-permissions, build-servers, count, get-default-command, get-server-metrics, get-server-time, one, public-ip, security, validate, with-sshkey
- `settings`: check-gpustatus, check-infrastructure-health, get-docker-disk-usage, get-dokploy-cloud-ips, get-dokploy-version, get-ip, get-log-cleanup-status, get-release-tag, get-traefik-ports, get-web-server-settings, have-activate-requests, have-traefik-dashboard-port-enabled, health, is-cloud, is-user-subscribed, read-directories, read-middleware-traefik-config, read-traefik-config, read-traefik-env, read-traefik-file, read-web-server-traefik-config
- `ssh-key`: all, all-for-apps, one
- `swarm`: get-container-stats, get-node-apps, get-node-info, get-nodes
- `volume-backups`: list, one

Note: `cluster add-manager` and `cluster add-worker` are exposed as `apiGet` in the generator, but names imply mutation and they are treated as side-effect and blocked.

## Side-effect limited allowlist

These commands are exposed only in agent-safe builds and are guarded at runtime:

- `application`: create, deploy, redeploy, update
- `compose`: create, deploy, isolated-deployment, update
- `domain`: create, update

Runtime policy:

- creation is forced into an allowed `agentDeployPolicy.projects[].environmentId` from the Dokploy config file
- if create omits `environmentId`, the first configured project is used
- allowed deploy servers come from `agentDeployPolicy.servers`
- omitted `serverId` on create defaults to the first configured server
- updates, deploys, and domain writes first resolve the target service and require it to belong to one configured project/environment
- domain hosts must match one wildcard label before a suffix in `agentDeployPolicy.domainSuffixes`, for example `demo.agent.srv1.example.net` for `*.agent.srv1.example.net`
- server entries can set `domainSuffixes` to bind a deploy server to a narrower domain set
- when `agentDeployPolicy.domainNameSuffix` is set, the configurable domain name before the matched suffix must end with that value

Example config shape:

```json
{
  "url": "https://dokploy.example.com",
  "token": "...",
  "agentDeployPolicy": {
    "projects": [
      {
        "projectName": "agent_sandbox",
        "projectId": "prjA0000000000000000a",
        "environmentName": "production",
        "environmentId": "envA0000000000000000a"
      }
    ],
    "servers": [
      {
        "name": "server-a",
        "serverId": "srvA0000000000000000a",
        "hint": "srv1.example.net",
        "domainSuffixes": ["*.agent.srv1.example.net"]
      }
    ],
    "domainSuffixes": ["*.agent.srv1.example.net"]
  }
}
```

Custom blind environment mutations are also exposed for applications inside configured projects:

- `application env list` returns names and masked previews
- `application env add` appends only when the key does not exist
- `application env comment` inserts sanitized comment lines before one existing key

These are CLI overlays around `application.one` and `application.saveEnvironment`. Existing values never appear in output. Generic agent-safe `application.update` omits replacement-style env, build-secret, password, and refresh-token fields.

No other generated `apiPost` commands are safe for now.

## Build process

Full build:

1. `pnpm run generate`
2. `pnpm run build`

`prebuild` runs `generate`, so `pnpm run build` refreshes `src/generated/commands.ts` from `openapi.json` before TypeScript emits `dist`.

Agent-safe build tag:

1. `pnpm run build:agent-safe`
2. or `DOKPLOY_BUILD_TAG=agent-safe pnpm run generate && tsc -b`

Agent-safe build behavior:

- generates a CLI surface with safe GET endpoints and an explicit guarded deploy allowlist
- registers blocked command stubs for disallowed endpoints so the agent sees why it cannot use them
- adds `dokploy-agent logs`, `dokploy-agent state`, and `dokploy-agent agent-safety summary|allowed|disallowed|unavailable|logs|deploy-policy`
- redacts responses before printing them
- limits log output before sending it to the agent

## Disallowed and unavailable command sets

Disallowed means command exists in the generated CLI surface but policy blocks it.

Unavailable means command exists in `openapi.json` but is not generated into `src/generated/commands.ts`, so the current CLI cannot expose it without generator/client work.

- generated total: 524
- safe total: 138
- disallowed total: 141
- hidden total: 245
- not available total (in `openapi.json` but not generated): 0

Full machine-readable list is in `docs/agent-safe-api-surface.json`.

### Disallowed (generated but blocked)

- use `generated.disallowed` in the JSON file for a full per-group list
- notable disallowed groups by count:
  - application: 14
  - backup: 3
  - compose: 8
  - deployment: 2
  - domain: 2
  - environment: 4
  - libsql: 12
  - mariadb: 13
  - mongo: 13
  - mysql: 13
  - postgres: 13
  - preview-deployment: 2
  - redis: 13
  - rollback: 2
  - schedule: 4
  - settings: 4

### Hidden (generated but omitted for token savings)

- use `generated.hidden` in the JSON file for a full per-group list
- hidden groups by count:
  - admin: 1
  - ai: 12
  - bitbucket: 3
  - cluster: 3
  - custom-role: 6
  - git-provider: 2
  - gitea: 3
  - github: 2
  - gitlab: 3
  - libsql: 14
  - license-key: 6
  - mariadb: 16
  - mongo: 16
  - mysql: 16
  - notification: 41
  - organization: 11
  - redis: 16
  - settings: 17
  - ssh-key: 4
  - sso: 10
  - stripe: 8
  - tag: 8
  - user: 23
  - whitelabeling: 4

### Not available (API has it, generated CLI does not)

- total: 0
- the generator now emits all supported `get` and `post` OpenAPI endpoints
- future unsupported HTTP methods should go here

## State discovery commands

`dokploy-agent state` lists read-only endpoints useful for deploy/debug context:

- Docker state: container lists, app label/name container lookup, Docker config, disk usage
- Traefik state: app and server Traefik config, env, file reads, ports, dashboard port flag
- Domain state: domains by application ID or compose ID, one domain lookup, Traefik.me capability

The OpenAPI spec exposes application/compose/database logs only. It does not currently expose raw Docker daemon logs or Traefik runtime logs.

## Logs-specific commands

These log related endpoints are currently not on the safe list because most are not generated into the CLI yet. Logs are read-only but can contain secrets, tokens, connection strings, env dumps, headers, or user data.

Custom non-OpenAPI deployment log support:

- `deployment.read-logs` is a CLI overlay, not generated from `openapi.json`
- it reads Dokploy deployment logs through the server WebSocket endpoint using a `logPath` from deployment metadata or a deployment source selector
- prefer `--applicationId`, `--composeId`, `--serverId`, or `--deploymentId` over raw `--logPath`
- application and compose selectors resolve the parent service first when deployment rows do not include the remote `serverId`
- selector mode skips missing/pruned log files and tries older deployment records
- if all candidate log files are missing, the command exits with a clear error instead of returning `tail` noise
- always use `--tail`, `--search`, and output limits for agent use

Safe after redaction and output limits in the agent-safe build:

- `application.read-logs` (get)
- `audit-log.all` (get, higher privacy risk)
- `compose.read-logs` (get)
- `libsql.read-logs` (get)
- `mariadb.read-logs` (get)
- `mongo.read-logs` (get)
- `mysql.read-logs` (get)
- `postgres.read-logs` (get)
- `redis.read-logs` (get)

Keep hidden or blocked:

- `settings.get-log-cleanup-status` (get), hidden because cleanup status is noisy for deploy/debug work
- `ai.analyze-logs` (post), sends logs to configured AI provider and can leak data externally
- `settings.update-log-cleanup` (post), changes cleanup policy

Log exposure rules:

- redact with same secret sanitizer as normal responses
- keep default line/byte caps to protect agent context
- read-log API endpoints already support server-side `tail`, `since`, and `search`
- prefer agent-safe local search flags over server-side `search` when a no-match result should be non-error output
- audit logs support server-side `limit` and `offset`
- agent-safe builds also add local output flags for log commands:
  - `--local-search <value>` filters returned logs locally after redaction
  - `--local-context <value>` includes nearby lines around local search matches
  - `--local-case-sensitive` makes local search case-sensitive
  - `--local-tail <value>` limits printed logs to last N lines, `0` disables line limit
  - `--local-max-chars <value>` limits printed logs to last N chars, `0` disables char limit
- mark audit logs as higher risk because they can expose users, IPs, emails, and admin actions

## Response redaction policy for agent

When forwarding output to the agent, apply a scrubber that masks secret-like values.

- mask every env assignment regardless of key name
- expose at most the first 4 characters for values longer than 4 characters
- fully mask values of 4 characters or fewer
- hide existing env comment bodies
- never emit full `DOKPLOY_API_KEY`, service tokens, credentials, or private keys
- keep public resource IDs visible, for example `applicationId`, `serverId`, and inventory `id`

Suggested sanitizer behavior:

- mask any object key matching `api.?key|token|secret|password|pass|credential|private|privateKey|authorization|webhook`
- string form output: `value => value.slice(0, 4) + '***'`
- keep non-sensitive fields untouched

Example:

- `abcd1234...` becomes `abcd***`
- `a1b2...` (len <= 4) stays as-is

## Update process

When command set changes:
1. regenerate from `src/generated/commands.ts`
2. re-run this list
3. keep side-effect allowlist explicit and minimal
