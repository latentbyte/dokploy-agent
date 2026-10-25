# Agent-safe API surface

This file tracks commands that are safe to expose to the agent.

Current policy: expose read-only endpoints by default. Side-effect endpoints are denied except for a deploy set constrained to one project.

## Source

Generated from `src/generated/commands.ts` (auto-generated from `openapi.json`).

## Read-only safe set

All commands below are `apiGet` based and considered safe-by-default in agent-safe builds after redaction and after the token-saving blacklist is applied.

- `ai`: get-custom-providers
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
- `forward-auth`: get-auth-domain, list-providers, server-status, status
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
- `scim`: list-providers
- `security`: one
- `server`: all, all-for-permissions, build-servers, count, get-default-command, get-server-metrics, get-server-time, one, public-ip, security, validate, with-sshkey
- `settings`: check-gpustatus, check-infrastructure-health, get-docker-disk-usage, get-dokploy-cloud-ips, get-dokploy-version, get-ip, get-log-cleanup-status, get-release-tag, get-traefik-ports, get-web-server-settings, have-activate-requests, have-traefik-dashboard-port-enabled, health, is-cloud, is-user-subscribed, read-directories, read-middleware-traefik-config, read-traefik-config, read-traefik-env, read-traefik-file, read-web-server-traefik-config
- `ssh-key`: all, all-for-apps, one
- `sso`: enforce-sso
- `swarm`: get-container-stats, get-node-apps, get-node-info, get-nodes
- `volume-backups`: list, one

Note: `cluster add-manager` and `cluster add-worker` are exposed as `apiGet` in the generator, but names imply mutation and they are treated as side-effect and blocked.

`docker read-container-file` and `docker-volume read-volume-file` are also blocked: they return raw file contents, such as mounted secrets or `/proc/*/environ`, that key-based redaction cannot vet. Directory listings stay available.

Classification tables (`MUTATING_GET_ENDPOINTS`, `SECRET_READ_GET_ENDPOINTS`, `SAFE_POST_ENDPOINTS`, protected update fields) live in `src/agent/policy.ts` alongside the runtime guards.

## Side-effect limited allowlist

These commands are exposed only in agent-safe builds and are guarded at runtime:

- `application`: create, deploy, redeploy, update, start, stop, reload
- `compose`: create, deploy, isolated-deployment, update, start, stop
- `domain`: create, delete
- `libsql`, `mariadb`, `mongo`, `mysql`, `postgres`, `redis`: create, deploy, start, stop, reload
- `application` configure operations (source providers, build type, cancel, kill build, clean queues) for deploy-project and expanded applications
- `application` expanded operations for explicitly allowlisted application IDs
- `mounts create` and `port create` for explicitly allowlisted applications
- `volume-backups`: create, run-manually

Runtime policy:

- application, compose, and database creation is forced into an allowed `agentDeployPolicy.projects[].environmentId` from the Dokploy config file
- if create omits `environmentId`, the first configured project is used
- allowed deploy servers come from `agentDeployPolicy.servers`; set `servers` to `"*"` to allow every remote server plus the local Dokploy server
- omitted `serverId` on create defaults to the first configured server; with `servers: "*"`, it remains omitted so Dokploy selects its local server
- updates, deploys, and domain creation first resolve the target service and require it to belong to one configured project/environment
- database deploys resolve the database and enforce the same project and server policy
- start, stop, and reload resolve the target service the same way; applications may also be expanded-allowlisted. Reload requires `appName` to equal the target's `appName`, so a permitted ID cannot restart a different container
- applications inside a configured project/environment, including ones the agent just created, may also use `save-github-provider`, `save-gitlab-provider`, `save-gitea-provider`, `save-bitbucket-provider`, `save-git-provider`, `save-docker-provider`, `save-build-type`, `cancel-deployment`, `kill-build`, and `clean-queues` without allowlist entries. These are narrower forms of `application update`, which deploy-project applications already have, so the deploy project is the agent's sandbox. Deploy-project callers cannot pass `application update`'s protected fields (for example `save-docker-provider --password`)
- watchPaths-only writes (service ID plus `watchPaths`, nothing else) are allowed on any readable git-backed service regardless of projects, servers, or the expanded allowlist: `save-github-provider`, `save-gitlab-provider`, `save-gitea-provider`, `save-bitbucket-provider`, and `save-git-provider` when the stored `sourceType` matches the endpoint (those handlers rewrite `sourceType` and reset `applicationStatus` to `idle`; record fill sends stored values for the other fields), and `compose update` on non-`raw` compose. Watch paths only choose which pushes auto-deploy. Any other field falls back to the normal guards, and entries that can never match in Dokploy's micromatch (leading `/`, trailing `/`, empty) are rejected with `INVALID_WATCH_PATHS`
- provenance is location-based on purpose: a local "created by agent" file is writable by the agent and a name or description marker can be set through `update`, so neither can be trusted
- `githubId`, `gitlabId`, `giteaId`, and `bitbucketId` on provider saves and on `application update`/`compose update` must name a provider listed by Dokploy (`<kind>.<kind>Providers`); owner and repository are not restricted, since custom git URLs and docker images already are not
- `agentDeployPolicy.expandedProjects` enables additional application lifecycle, source-provider, build, environment, queue, move, and Traefik operations for applications inside named projects
- omit `applicationNames` on an expanded project to allow every application in that project; set `applicationNames` to restrict to matching Dokploy `name` or `appName` (case-insensitive) inside that project only
- optional `projectId` matches first when present; optional `environmentNames` further restricts by environment name
- empty `applicationNames: []` matches no applications for that entry
- `expandedApplicationIds` remains available when an immutable ID is preferred
- legacy `expandedApplicationNames` still works as a global name fallback; prefer `expandedProjects` so generic names cannot cross projects
- expanded allowlist entries are explicit exceptions to configured project and server restrictions, so existing applications outside agent deployment projects can be managed
- expanded rights apply to applications only; compose and database writes stay governed by `projects[]`
- application reads and inventory are not limited to configured deployment projects; the project list controls baseline writes and new resource placement
- `agent-safety deploy-policy --json` resolves expanded projects/ids/legacy names and returns matching applications in `expandedApplications`, plus every application in a configured project/environment in `managedApplications`
- mount and port creation requires an expanded-allowlisted application; mounts for other service types stay blocked
- volume backup create and run-manually resolve the parent service first; applications may be in a configured project or the expanded allowlist, while compose and database parents stay governed by `projects[]`
- volume backup update and delete stay blocked
- expanded-only operations (deploy-project applications do not get them): delete, move, disconnect git provider, save environment, refresh token, mark running, clear deployments, Traefik config, mounts, and ports
- expanded operations include delete, source-provider/build/environment changes, disconnect, token refresh, queue/deployment cleanup, move, cancel, and application Traefik config updates
- domain hosts must match one wildcard label before a suffix in `agentDeployPolicy.domainSuffixes`, for example `demo.apps.example.net` for `*.apps.example.net`
- before creation, the CLI reads all Dokploy projects and rejects a host already attached to any service, including services outside agent deployment projects
- domain delete mirrors create: the domain's parent application or compose must be in a configured project (expanded rights do not apply) and the host must match the agent domain suffix policy
- domain update stays blocked, so agents cannot move existing domains
- Dokploy's create operation remains the final uniqueness check if two clients race after the inventory check
- server entries can set `domainSuffixes` to bind a deploy server to a narrower domain set
- when `agentDeployPolicy.domainNameSuffix` is set, the configurable domain name before the matched suffix must end with that value; omit it to allow any unused single-label name

Example config shape. Use `"servers": "*"` instead of the array when agents may deploy to any server:

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
        "hint": "apps.example.net",
        "domainSuffixes": ["*.apps.example.net"]
      }
    ],
    "domainSuffixes": ["*.apps.example.net"],
    "expandedProjects": [
      { "projectName": "my-app" },
      { "projectName": "storefront", "applicationNames": ["catalog"] }
    ]
  }
}
```

Custom blind environment mutations are also exposed for applications, compose services, and databases (`libsql`, `mariadb`, `mongo`, `mysql`, `postgres`, `redis`) inside configured projects. Applications may also be expanded-allowlisted:

- `<kind> env list` returns names and masked previews
- `<kind> env add` appends only when the key does not exist
- `<kind> env set` creates or replaces one key; `<kind> env unset` removes every assignment of one key
- `<kind> env comment` inserts sanitized comment lines before one existing key

These are CLI overlays around `<kind>.one` and `<kind>.saveEnvironment`; the generated `save-environment` commands stay blocked.

Writes on a service outside the policy are not refused outright. The CLI opens a native approval dialog (see [Interactive approval](#interactive-approval)) and writes only after the user approves. `env list` outside the policy stays blocked.

## Interactive approval

`src/agent/approval.ts` and `src/agent/approval-backends.ts` turn selected policy denials into a user prompt that the agent cannot answer:

- backends: macOS `/usr/bin/osascript`, Windows PowerShell MessageBox (only in an interactive desktop session), Linux `zenity` or `kdialog` from `/usr/bin` or `/bin` when `DISPLAY` or `WAYLAND_DISPLAY` is set. No dialog over SSH (`SSH_CONNECTION`, `SSH_TTY`)
- binaries come from fixed paths and run with a minimal env, so `PATH` or loader overrides cannot swap in a fake approver. Dialog text travels through argv or env vars, never script source
- Deny is the default button; the dialog gives up after `agentDeployPolicy.approval.timeoutSeconds` (default 90)
- one approval covers one request. The CLI computes the write before prompting, re-reads the service after approval, and aborts with `AGENT_APPROVAL_STALE` (exit 1) if the env or companion fields changed meanwhile
- results: approval runs the write; `AGENT_APPROVAL_DENIED` and `AGENT_APPROVAL_TIMEOUT` exit 2; with no backend, or with `agentDeployPolicy.approval.enabled: false`, the original `AGENT_POLICY_BLOCKED` stays
- every prompt is logged to `$XDG_STATE_HOME/dokploy-agent/approvals.jsonl` (default `~/.local/state`): time, endpoint, target, key names, result. Values are never logged
- the dialog shows the target, key names, masked current values, and the new value the agent supplied. Below those CLI-derived facts it shows the agent's `--reason` text and the working directory, both labeled unverified; the audit log records both
- limits: the policy is a cooperative guard. An agent that can edit the config file, script the desktop UI, or call the API with the token directly can get around it

Currently gated: env `add`, `set`, `unset`, and `comment`. Plan for further endpoints: [docs/plans/interactive-approval.md](plans/interactive-approval.md).

Env overlay output never includes existing values. Generic agent-safe `application.update` omits replacement-style env, build-secret, password, and refresh-token fields. Generic agent-safe `compose.update` omits env and refresh-token fields.

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

- generated total: 545
- safe total: 193
- disallowed total: 185
- hidden total: 167
- not available total (in `openapi.json` but not generated): 0

Full machine-readable list is in `docs/agent-safe-api-surface.json`.

### Disallowed (generated but blocked)

- use `generated.disallowed` in the JSON file for a full per-group list
- notable disallowed groups by count:
  - application: 22
  - backup: 10
  - compose: 18
  - deployment: 2
  - domain: 3
  - environment: 4
  - forward-auth: 6
  - libsql: 12
  - mariadb: 13
  - mongo: 13
  - mysql: 13
  - patch: 8
  - postgres: 13
  - preview-deployment: 2
  - redis: 13
  - rollback: 2
  - schedule: 4
  - server: 6
  - settings: 17

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
  - license-key: 6
  - notification: 41
  - organization: 11
  - settings: 17
  - ssh-key: 4
  - sso: 10
  - stripe: 8
  - tag: 8
  - user: 23
  - whitelabeling: 4

### Not available (API has it, generated CLI does not)

- total: 0
- the generator emits all supported `get` and `post` OpenAPI endpoints except endpoints replaced by richer CLI overlays
- future unsupported HTTP methods should go here

## State discovery commands

`dokploy-agent state` lists read-only endpoints useful for deploy/debug context:

- Docker state: container lists, app label/name container lookup, Docker config, disk usage
- Traefik state: app and server Traefik config, env, file reads, ports, dashboard port flag
- Domain state: domains by application ID or compose ID, one domain lookup, Traefik.me capability

The OpenAPI spec exposes application, compose, database, and deployment log reads. It does not currently expose raw Docker daemon logs or Traefik runtime logs.

## Logs-specific commands

Logs are read-only but can contain secrets, tokens, connection strings, env dumps, headers, or user data.

Custom deployment log support:

- `deployment.read-logs` is a CLI overlay replacing the narrower generated OpenAPI command
- it reads Dokploy deployment logs through the server WebSocket endpoint using a `logPath` from deployment metadata or a deployment source selector
- prefer `--applicationId`, `--composeId`, `--serverId`, or `--deploymentId` over raw `--logPath`
- application and compose selectors resolve the parent service first when deployment rows do not include the remote `serverId`
- selector mode skips missing/pruned log files and tries older deployment records
- if all candidate log files are missing, the command exits with a clear error instead of returning `tail` noise
- always use `--tail`, `--search`, and output limits for agent use

`deployment.wait` is a read-only CLI overlay that polls `deployment.all` / `deployment.allByCompose` until the matching deployments finish. It prints redacted titles and error messages, never logs.

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
- reveal at most a third of a value: first 4 characters from 12 characters, plus the last 4 from 24 characters
- always append the length, for example `abcd***wxyz (40 chars)`; values under 12 characters show only `*** (N chars)`
- hide existing env comment bodies
- never emit full `DOKPLOY_API_KEY`, service tokens, credentials, or private keys
- keep public resource IDs visible, for example `applicationId`, `serverId`, and inventory `id`, derived from the `<group>Id` params of `<group>.one` endpoints (`src/generated/resource-ids.ts`) plus a short manual list
- mask well-known credential formats even without a sensitive key name (`sk-`, `sk_live_`, `ghp_`, `github_pat_`, `glpat-`, `xox*-`, `AKIA`, `AIza`, `npm_`, `whsec_`)
- replace private key blocks with `[private key hidden]`
- treat JSON text (`"password": "..."`) and NUL-separated environments as assignments

Suggested sanitizer behavior:

- mask any object key matching `api.?key|token|secret|password|pass|credential|private|privateKey|authorization|webhook`
- string form output: see `maskSecret` in `src/redact.ts`
- keep non-sensitive fields untouched

Example:

- `abcd1234efgh5678ijkl9012` becomes `abcd***9012 (24 chars)`
- `abcd1234efgh` becomes `abcd*** (12 chars)`
- `hunter2` becomes `*** (7 chars)`

## Update process

When command set changes:
1. regenerate from `src/generated/commands.ts`
2. re-run this list
3. keep side-effect allowlist explicit and minimal
