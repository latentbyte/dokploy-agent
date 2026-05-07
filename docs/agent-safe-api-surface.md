# Agent-safe API surface

This file tracks commands that are safe to expose to the agent.

Current policy: expose read-only endpoints by default. Side-effect endpoints are denied except for a minimal deploy set.

## Source

Generated from `src/generated/commands.ts` (auto-generated from `openapi.json`).

## Read-only safe set

All commands below are `apiGet` based and considered safe-by-default.

- `ai`: get, get-all, get-models, one
- `application`: one, read-app-monitoring, read-traefik-config, search
- `backup`: list-backup-files, one
- `bitbucket`: bitbucket-providers, get-bitbucket-branches, get-bitbucket-repositories, one
- `certificates`: all, one
- `cluster`: get-nodes
- `compose`: get-converted-compose, get-default-command, get-tags, load-mounts-by-service, load-services, one, search, templates
- `deployment`: all, all-by-compose, all-by-server, all-by-type, all-centralized, queue-list
- `destination`: all, one
- `docker`: get-config, get-containers, get-containers-by-app-label, get-containers-by-app-name-match, get-service-containers-by-app-name, get-stack-containers-by-app-name
- `domain`: by-application-id, by-compose-id, can-generate-traefik-me-domains, one
- `environment`: by-project-id, one, search
- `git-provider`: get-all
- `gitea`: get-gitea-branches, get-gitea-repositories, get-gitea-url, gitea-providers, one
- `github`: get-github-branches, get-github-repositories, github-providers, one
- `gitlab`: get-gitlab-branches, get-gitlab-repositories, gitlab-providers, one
- `license-key`: get-enterprise-settings, have-valid-license-key
- `mariadb`: one, search
- `mongo`: one, search
- `mounts`: all-named-by-application-id, list-by-service-id, one
- `mysql`: one, search
- `notification`: all, get-email-providers, one
- `organization`: active, all, all-invitations, one
- `patch`: by-entity-id, one, read-repo-directories, read-repo-file
- `port`: one
- `postgres`: one, search
- `preview-deployment`: all, one
- `project`: all, all-for-permissions, one, search
- `redirects`: one
- `redis`: one, search
- `registry`: all, one
- `schedule`: list, one
- `security`: one
- `server`: all, build-servers, count, get-default-command, get-server-metrics, get-server-time, one, public-ip, security, validate, with-sshkey
- `settings`: check-gpustatus, get-dokploy-cloud-ips, get-dokploy-version, get-ip, get-log-cleanup-status, get-open-api-document, get-release-tag, get-traefik-ports, get-web-server-settings, have-activate-requests, have-traefik-dashboard-port-enabled, health, is-cloud, is-user-subscribed, read-directories, read-middleware-traefik-config, read-traefik-config, read-traefik-env, read-traefik-file, read-web-server-traefik-config
- `ssh-key`: all, one
- `sso`: get-trusted-origins, list-providers, one, show-sign-in-with-sso
- `stripe`: can-create-more-servers, get-current-plan, get-invoices, get-products
- `swarm`: get-node-apps, get-node-info, get-nodes
- `user`: all, check-user-organizations, get, get-backups, get-container-metrics, get-invitations, get-metrics-token, get-server-metrics, get-user-by-token, have-root-access, one
- `volume-backups`: list, one

Note: `cluster add-manager` and `cluster add-worker` are exposed as `apiGet` in the generator, but names imply mutation and they are treated as side-effect and blocked.

## Side-effect limited allowlist (phase 1)

These are not exposed by default; keep in separate, explicit allowlist.

- `application`: deploy, redeploy
- `compose`: deploy, isolated-deployment, deploy-template
- `preview-deployment`: redeploy

No other `apiPost` commands are safe for now.

## Disallowed and unavailable command sets

Disallowed means command exists in the generated CLI surface but policy blocks it.

Unavailable means command exists in `openapi.json` but is not generated into `src/generated/commands.ts`, so the current CLI cannot expose it without generator/client work.

- generated total: 449
- safe total: 162
- disallowed total: 287
- not available total (in `openapi.json` but not generated): 79

Full machine-readable list is in `docs/agent-safe-api-surface.json`.

### Disallowed (generated but blocked)

- use `generated.disallowed.by_group` in the JSON file for a full per-group list
- notable disallowed groups by count:
  - admin: 1
  - ai: 5
  - application: 23
  - backup: 9
  - bitbucket: 3
  - certificates: 2
  - cluster: 3
  - compose: 17
  - deployment: 2
  - destination: 4
  - docker: 1
  - domain: 5
  - environment: 4
  - git-provider: 1
  - gitea: 3
  - github: 2
  - gitlab: 3
  - license-key: 4
  - mariadb: 12
  - mongo: 12
  - mounts: 3
  - mysql: 12
  - notification: 35
  - organization: 6
  - patch: 8
  - port: 3
  - postgres: 12
  - preview-deployment: 1
  - project: 4
  - redirects: 3
  - redis: 12
  - registry: 5
  - rollback: 2
  - schedule: 4
  - security: 3
  - server: 5
  - settings: 29
  - ssh-key: 4
  - sso: 6
  - stripe: 3
  - user: 7
  - volume-backups: 4

### Not available (API has it, generated CLI does not)

- total: 79
- notable missing by group:
  - application: 2
  - backup: 1
  - certificates: 1
  - compose: 2
  - docker: 5
  - git-provider: 2
  - libsql: 14
  - mariadb: 2
  - mongo: 2
  - mysql: 2
  - notification: 3
  - postgres: 2
  - project: 1
  - redis: 2
  - server: 2
  - settings: 5
  - ssh-key: 1
  - stripe: 1
  - swarm: 1
  - user: 5
  - ai: 3
  - organization: 1
  - whitelabeling: 4
  - custom-role: 6
  - audit-log: 1
  - tag: 8

## Logs-specific commands

These log related endpoints are currently not on the safe list because most are not generated into the CLI yet. Logs are read-only but can contain secrets, tokens, connection strings, env dumps, headers, or user data.

Candidate safe after redaction and output limits:

- `application.read-logs` (get, unavailable)
- `audit-log.all` (get, unavailable, higher privacy risk)
- `compose.read-logs` (get, unavailable)
- `libsql.read-logs` (get, unavailable)
- `mariadb.read-logs` (get, unavailable)
- `mongo.read-logs` (get, unavailable)
- `mysql.read-logs` (get, unavailable)
- `postgres.read-logs` (get, unavailable)
- `redis.read-logs` (get, unavailable)

Keep blocked:

- `ai.analyze-logs` (post, unavailable), sends logs to configured AI provider and can leak data externally

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
