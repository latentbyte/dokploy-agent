# Agent-safe API surface

This file tracks commands that are safe to expose to the agent.

Current policy: expose read-only endpoints by default. Side-effect endpoints are denied except for a minimal deploy set.

## Source

Generated from `src/generated/commands.ts` (auto-generated from `openapi.json`).

## Read-only safe set

All commands below are `apiGet` based and considered safe-by-default in agent-safe builds after redaction.

- `ai`: get, get-all, get-enabled-providers, get-models, one
- `application`: one, read-app-monitoring, read-logs, read-traefik-config, search
- `audit-log`: all
- `backup`: list-backup-files, one
- `bitbucket`: bitbucket-providers, get-bitbucket-branches, get-bitbucket-repositories, one
- `certificates`: all, one
- `cluster`: get-nodes
- `compose`: get-converted-compose, get-default-command, get-tags, load-mounts-by-service, load-services, one, read-logs, search, templates
- `custom-role`: all, get-statements, members-by-role
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
- `license-key`: get-enterprise-settings, have-valid-license-key
- `mariadb`: one, read-logs, search
- `mongo`: one, read-logs, search
- `mounts`: all-named-by-application-id, list-by-service-id, one
- `mysql`: one, read-logs, search
- `notification`: all, get-email-providers, one
- `organization`: active, all, all-invitations, one
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
- `settings`: check-gpustatus, check-infrastructure-health, get-docker-disk-usage, get-dokploy-cloud-ips, get-dokploy-version, get-ip, get-log-cleanup-status, get-open-api-document, get-release-tag, get-traefik-ports, get-web-server-settings, have-activate-requests, have-traefik-dashboard-port-enabled, health, is-cloud, is-user-subscribed, read-directories, read-middleware-traefik-config, read-traefik-config, read-traefik-env, read-traefik-file, read-web-server-traefik-config
- `ssh-key`: all, all-for-apps, one
- `sso`: get-trusted-origins, list-providers, one, show-sign-in-with-sso
- `stripe`: can-create-more-servers, get-current-plan, get-invoices, get-products
- `swarm`: get-container-stats, get-node-apps, get-node-info, get-nodes
- `tag`: all, one
- `user`: all, check-user-organizations, get, get-backups, get-bookmarked-templates, get-container-metrics, get-invitations, get-metrics-token, get-permissions, get-server-metrics, get-user-by-token, have-root-access, one, session
- `volume-backups`: list, one
- `whitelabeling`: get, get-public

Note: `cluster add-manager` and `cluster add-worker` are exposed as `apiGet` in the generator, but names imply mutation and they are treated as side-effect and blocked.

## Side-effect limited allowlist (phase 1)

These are not exposed by default; keep in separate, explicit allowlist.

- `application`: deploy, redeploy
- `compose`: deploy, isolated-deployment, deploy-template
- `preview-deployment`: redeploy

No other `apiPost` commands are safe for now.

## Build process

Full build:

1. `pnpm run generate`
2. `pnpm run build`

`prebuild` runs `generate`, so `pnpm run build` refreshes `src/generated/commands.ts` from `openapi.json` before TypeScript emits `dist`.

Agent-safe build tag:

1. `pnpm run build:agent-safe`
2. or `DOKPLOY_BUILD_TAG=agent-safe pnpm run generate && tsc -b`

Agent-safe build behavior:

- generates a CLI surface with safe GET endpoints and explicit deploy allowlist
- registers blocked command stubs for disallowed endpoints so the agent sees why it cannot use them
- adds `dokploy agent-safety summary|allowed|disallowed|unavailable|logs`
- redacts responses before printing them
- limits log output before sending it to the agent

## Disallowed and unavailable command sets

Disallowed means command exists in the generated CLI surface but policy blocks it.

Unavailable means command exists in `openapi.json` but is not generated into `src/generated/commands.ts`, so the current CLI cannot expose it without generator/client work.

- generated total: 524
- safe total: 190
- disallowed total: 334
- not available total (in `openapi.json` but not generated): 0

Full machine-readable list is in `docs/agent-safe-api-surface.json`.

### Disallowed (generated but blocked)

- use `generated.disallowed.by_group` in the JSON file for a full per-group list
- notable disallowed groups by count:
  - admin: 1
  - ai: 7
  - application: 24
  - backup: 10
  - bitbucket: 3
  - certificates: 3
  - cluster: 3
  - compose: 18
  - custom-role: 3
  - deployment: 2
  - destination: 4
  - docker: 6
  - domain: 5
  - environment: 4
  - git-provider: 2
  - gitea: 3
  - github: 2
  - gitlab: 3
  - libsql: 12
  - license-key: 4
  - mariadb: 13
  - mongo: 13
  - mounts: 3
  - mysql: 13
  - notification: 38
  - organization: 7
  - patch: 8
  - port: 3
  - postgres: 13
  - preview-deployment: 1
  - project: 4
  - redirects: 3
  - redis: 13
  - registry: 5
  - rollback: 2
  - schedule: 4
  - security: 3
  - server: 5
  - settings: 29
  - ssh-key: 4
  - sso: 6
  - stripe: 4
  - tag: 6
  - user: 9
  - volume-backups: 4
  - whitelabeling: 2

### Not available (API has it, generated CLI does not)

- total: 0
- the generator now emits all supported `get` and `post` OpenAPI endpoints
- future unsupported HTTP methods should go here

## Logs-specific commands

These log related endpoints are currently not on the safe list because most are not generated into the CLI yet. Logs are read-only but can contain secrets, tokens, connection strings, env dumps, headers, or user data.

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
- `settings.get-log-cleanup-status` (get)

Keep blocked:

- `ai.analyze-logs` (post), sends logs to configured AI provider and can leak data externally
- `settings.update-log-cleanup` (post), changes cleanup policy

Log exposure rules:

- redact with same secret sanitizer as normal responses
- limit lines and bytes before sending to agent
- default to recent tail only
- mark audit logs as higher risk because they can expose users, IPs, emails, and admin actions

## Response redaction policy for agent

When forwarding output to the agent, apply a scrubber that masks secret-like values.

- strip env values to first 4 characters
- never emit full `DOKPLOY_API_KEY`, service tokens, credentials, or private keys

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
