# Agentic command schemas

These commands are designed for machine consumption. Use `--json` for stable JSON output. Secret-looking values are redacted by default.

## `service list --json`

Flattened inventory across all projects and environments. Backed by `project all`.

Fields:

```json
[
  {
    "type": "application | compose | postgres | mysql | mariadb | mongo | redis | libsql",
    "project": "string | null",
    "env": "string | null",
    "name": "string | null",
    "id": "string | null",
    "status": "string | null",
    "domains": ["string"],
    "repo": "string | null",
    "branch": "string | null",
    "path": "string | null",
    "serverId": "string | null"
  }
]
```

Aliases, clearly marked in help:

- `inventory --json`, alias for `service list --json`
- `application list --json`, alias filtered to applications
- `compose list --json`, alias filtered to compose apps

`--fields name,domains,repo` selects fields.

## `application logs --appName APP_NAME --tail 200 --json`

Reads runtime logs without requiring a separate ID lookup. Selectors: `--applicationId`, `--appName`, `--name`, or `--q`. Refine ambiguous matches with `--project` and `--env`.

Local filtering after redaction: `--local-search`, `--local-context`, `--local-tail`, and `--local-max-chars`. In `dokploy-agent`, `--search` also filters locally after redaction; it is never sent to the server.

## `compose effective --composeId ID --json`

Returns effective compose from Dokploy conversion. Use `--no-dokploy-labels` and `--no-dokploy-networks` to strip generated noise.

## `compose summary --composeId ID --json`

Returns compose metadata and service summary:

```json
{
  "composeId": "string",
  "name": "string | null",
  "repository": "string | null",
  "branch": "string | null",
  "composePath": "string | null",
  "domains": [],
  "services": [
    {
      "name": "string",
      "image": "string | null",
      "build": "string | object | null",
      "ports": [],
      "envKeys": ["string"],
      "volumes": []
    }
  ]
}
```

## `application env`, `compose env`, and database `env` commands

Blind environment mutation for existing applications, compose services, and databases. Raw existing values stay inside the CLI. `compose env` takes the same subcommands with `--composeId` in place of `--applicationId`; database groups (`libsql`, `mariadb`, `mongo`, `mysql`, `postgres`, `redis`) take `--<kind>Id`, for example `postgres env set --postgresId ID`.

```bash
# names and masked previews only
dokploy-agent application env list --applicationId APP_ID --json

# scheme, host, port, database of a URL value; credentials stay hidden
dokploy-agent application env url \
  --applicationId APP_ID \
  --name DATABASE_URL \
  --reason "check which database host the app uses" \
  --json

# create or replace without exposing other values
dokploy-agent application env set \
  --applicationId APP_ID \
  --name APP_BASE_URL \
  --value https://app.example.app \
  --json

# fails when NEW_KEY already exists
dokploy-agent application env add \
  --applicationId APP_ID \
  --name NEW_KEY \
  --value "new value" \
  --comment "Added for worker startup" \
  --json

# removes every assignment of the key; fails when it does not exist
dokploy-agent application env unset \
  --applicationId APP_ID \
  --name OLD_KEY \
  --json

# keeps the value; fails when OLD_KEY is missing or duplicated, or NEW_KEY exists
dokploy-agent application env rename \
  --applicationId APP_ID \
  --name OLD_KEY \
  --new-name NEW_KEY \
  --reason "match the name the new release reads" \
  --json

# copies keys from a compose service without printing values; always asks the user
dokploy-agent application env copy \
  --from-compose COMPOSE_ID \
  --applicationId APP_ID \
  --names DATABASE_URL,API_KEY \
  --reason "move backend from compose to an application" \
  --json

# exists / duplicated / empty; no dialog
dokploy-agent application env has --applicationId APP_ID --name KEY --json

# true or false against a value or digest; always asks the user
dokploy-agent application env match \
  --applicationId APP_ID \
  --name API_KEY \
  --sha256 HEX_DIGEST \
  --reason "confirm the rotated key landed" \
  --json

# true or false for a substring; always asks the user
dokploy-agent application env contains \
  --applicationId APP_ID \
  --name API_BASE_URL \
  --substring old.example.com \
  --reason "find services still pointing at the old host" \
  --json

# swaps only the host of a URL value; credentials, port, path, query, and quoting stay
dokploy-agent application env replace-host \
  --applicationId APP_ID \
  --name API_BASE_URL \
  --from old.example.com \
  --to new.example.com \
  --reason "point at the renamed API host" \
  --json

# inserts comment lines before one unambiguous existing key
dokploy-agent application env comment \
  --applicationId APP_ID \
  --name EXISTING_KEY \
  --text "Managed by deployment automation" \
  --json
```

Safety behavior:

- all existing values get fixed masked previews, regardless of key name
- existing comment bodies remain hidden
- add fails on existing keys; set creates or replaces a single key
- no overwrite mode for add
- comment fails on missing or duplicated keys
- unset fails on missing keys and leaves comments in place
- rename changes only the key name; prefix, quoting, raw value, position, and comments stay. References to the old name (compose `${OLD_KEY}`, app code) are not rewritten
- rename asks the user even inside the deploy policy when the new name starts with a client-bundle prefix (`NEXT_PUBLIC_`, `NUXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `EXPO_PUBLIC_`, `GATSBY_`, `VUE_APP_`, `PUBLIC_`) the old name lacks, or when it turns a secret-looking name into one log redaction no longer matches. Hosts without a dialog keep `AGENT_POLICY_BLOCKED`
- `env copy` takes `--names A,B` or `--all`, copies raw assignments so quoting and `${{project.X}}` references survive, and shows one dialog for the batch with key names and masked previews. It always asks, even inside the deploy policy, because anything the target runs can read the values. Approval is bound to the source and target env: `AGENT_APPROVAL_STALE` if either changed. Source and target must share an environment. Fails on missing or duplicated source keys and on keys the target already has, and is denied when the batch does not fit the dialog (18 keys), so split it with `--names`. Keys with a client-bundle prefix are flagged in the dialog
- `has` works on any service without a dialog (names are already public through `list`). `match` (`--value`, `--sha256`, or `--sha512`) and `contains --substring` print only a boolean and always open a dialog, even inside the deploy policy, since repeated answers could reconstruct a value. They compare the stored text as written: `${{project.X}}` references are not resolved, surrounding quotes are stripped. Prefer `--sha256`/`--sha512` so the expected secret never sits in argv or the dialog
- every `has`, `match`, and `contains` call appends to `$XDG_STATE_HOME/dokploy-agent/env-checks.jsonl` (default `~/.local/state`): Dokploy URL, target, key, check type, input length, reason, cwd, and the boolean or error code. Inputs, digests, and values are never logged
- `replace-host` needs the current host in `--from` and fails with `ENV_URL_HOST_MISMATCH` (without echoing the value) when the URL host differs. Outside the policy the dialog opens before the host is compared, so a denied or disabled approval reveals nothing about the value
- multiline comment input is prefixed line-by-line to prevent assignment injection; control, line-separator (U+2028, U+2029, U+0085), and bidi characters are rejected
- `add` and `set` ask the user even inside the deploy policy when a client-bundle-prefixed key gets a `${{...}}` shared-variable reference; `replace-host` asks inside the policy when the URL carries credentials
- `list` works on any service; `url` prints only scheme, host, port, and database (database schemes only), never userinfo, query, or fragment, and fails with `INVALID_ENV_URL` without echoing a non-URL value or a URL with `@` after the host
- agent-safe builds enforce configured project and server policy before writes and `url` reads; compose and databases must be in a deploy project (expanded allowlists cover applications only)
- a write or `url` read on a service outside the policy opens a native approval dialog for the user and blocks until they answer (default 90s). The dialog plays a sound when it opens so a user away from the screen hears it (macOS `afplay`, Linux `canberra-gtk-play` when installed, Windows system sound). If the dialog is still open halfway through, a desktop notification reminds the user (macOS, zenity, kdialog). Approve writes; otherwise exit 2 with `AGENT_APPROVAL_DENIED` or `AGENT_APPROVAL_TIMEOUT`, or `AGENT_APPROVAL_SYNTHETIC` when the Approve click was posted by a process rather than the user's mouse or keyboard. Hosts without a dialog (SSH, CI, headless) and configs with `agentDeployPolicy.approval.enabled: false` keep `AGENT_POLICY_BLOCKED`. `AGENT_APPROVAL_STALE` (exit 1) means the env changed while the dialog was open and nothing was written; rerun to review again
- every mutation accepts `--reason <text>`. When a write needs approval, the dialog shows it (up to 500 chars, 8 lines) as the agent's unverified explanation next to the CLI-derived target and diff. The target section starts with the Dokploy URL the command runs against, and the audit log records it as `dokployUrl`. Always pass it on writes that may fall outside the policy
- every mutation that takes `--reason` also takes `--thread-url <url>`: a link to the agent's conversation, shown as a clickable link under "AGENT THREAD (unverified)" so the user can see who asks and why (plain text on Linux and Windows dialogs). Only `http(s)` links pass; a T3 Code `t3-thread://v2/<environmentId>/<threadId>` link becomes `https://app.t3.codes/threads/<environmentId>/<threadId>`. Anything else, credentials in the URL, or more than 200 chars fails with `INVALID_THREAD_URL` before any write. The audit log records it as `threadUrl`. Omit it when the agent has no link
- agents should batch related changes into as few calls as practical and tell the user a dialog is coming, since each write outside the policy is a separate prompt
- generic `application update` hides env, build-secret, password, and refresh-token fields
- generic `compose update` hides env and refresh-token fields
- `project update` and database `update` (`postgres update`, ...; not `libsql`) take only the ID, `--name`, and `--description`

Dokploy exposes replacement-style environment writes. These commands perform read-modify-write internally. Application writes preserve `buildArgs`, `buildSecrets`, and `createEnvFile`; compose writes send only `env`. Concurrent panel edits can still race because Dokploy does not expose compare-and-swap for this operation.

## Partial `save-*` updates

Some Dokploy update endpoints require the full field set even though most fields accept `null`, for example `application save-build-type` (`--dockerfile`, `--herokuVersion`, `--railpackVersion`, ...) and the `application save-*-provider` commands. For these, the CLI makes the required fields optional: omitted ones are read from the current record (`<group>.one`) and sent unchanged, so pass only what changes:

```bash
dokploy-agent application save-build-type --applicationId ID --buildType dockerfile --dockerfile Dockerfile.prod --json
```

In agent-safe builds these work on any application in an `agentDeployPolicy` project/environment, so an agent can create an app and then set its source and build without allowlist edits:

```bash
dokploy-agent application create --name demo --json   # note applicationId
dokploy-agent github github-providers --json          # pick a configured githubId
dokploy-agent application save-github-provider --applicationId ID --githubId GH_ID --owner OWNER --repository REPO --branch main --json
```

Delete, move, and disconnect still need the expanded allowlist.

### Watch paths on any git-backed service

A write of only the service ID and `--watchPaths` works on any git-backed application or compose service the token can read, inside or outside `agentDeployPolicy` projects and the expanded allowlist. Use the `save-*-provider` command matching the app's current `sourceType` (Dokploy's save handlers overwrite `sourceType`, so a mismatch is rejected) or `compose update`; record fill sends the other provider fields unchanged:

```bash
dokploy-agent application save-github-provider --applicationId ID --watchPaths '["backend/**","shared/**"]' --json
dokploy-agent compose update --composeId ID --watchPaths '["deploy/**"]' --json
```

Any other field in the same call (`--branch`, `--buildPath`, `--enableSubmodules`, ...) goes through the normal policy, and `application update` does not get the exception. Dokploy matches with `micromatch(changedFiles, watchPaths)` and no options, so agent-safe builds reject entries that can never match (`INVALID_WATCH_PATHS`): a leading `/`, a trailing `/` such as `src/`, or an empty string. Dotfiles need explicit patterns (`.github/**`); `[]` means every push deploys.

The generator detects these endpoints from the spec (a `<group>Id` update with a required nullable field and at least two required fields). Agent-safe policy checks run before the record is read. Optional fields with a spec default (such as `server update --enableDockerCleanup`) are carried over too, so the default cannot reset them. A current `null` is kept only where the spec accepts `null`; if a field is missing or `null` where a value is required, the command fails with `MISSING_OPTION` before writing. When switching source providers, pass every provider field (`--githubId` and so on), since the old provider's fields are `null` and would be kept. Like env writes, this is read-modify-write without compare-and-swap.

## Approval for service writes outside the policy

Writes that the agent may already make inside `agentDeployPolicy` prompt the user instead of failing when only the scope is wrong (project/environment, server, or expanded allowlist): `application|compose update`, `deploy`, `redeploy`, `compose isolated-deployment`, `start`, `stop`, `reload`, database `deploy`, the deploy-project `application save-*` and `cancel-deployment|kill-build|clean-queues` commands, `domain create`, and the label-only `project update` and database `update` (a project rename prompts inside the policy too). These commands take `--reason <text>` and `--thread-url <url>`:

```bash
dokploy-agent compose update --composeId ID --composeType stack --reason "kutt needs swarm overlay networks" --json
```

The dialog shows the target and a diff of each passed field against the current record (a line diff for multi-line fields such as `--composeFile`; stored values are redacted, agent-supplied values are shown as given). Every other check still runs first and still denies outright: protected fields, unknown git providers, domain hosts outside the suffix policy or already in use, `reload` appName mismatches. `application create` is approvable too, with a dialog keyed on the environment that shows project, environment, server, name, and appName. Other creates, deletes, moves, and expanded-only writes are never approvable. Results match the env commands: `AGENT_APPROVAL_DENIED`/`AGENT_APPROVAL_TIMEOUT` (exit 2), `AGENT_APPROVAL_STALE` (exit 1) when a passed field, `environmentId`, or `serverId` changed while the dialog was open, and `AGENT_POLICY_BLOCKED` on hosts without a dialog or with `approval.enabled: false`.

## `domain move`

Moves an existing domain to an application in the same environment and on the same server. `domain update` cannot change a domain's parent, so this is the only way to keep a host across a service change.

```bash
dokploy-agent domain move --domainId DOMAIN_ID --applicationId APP_ID \
  --reason "backend now runs as an application" --json
```

- it always asks the user, because it skips the host suffix and in-use checks for this one record. Any other domain write keeps them
- `--port` sets the target container port when it differs from the current one; other settings (path, https, certificate, middlewares, forward auth) carry over. A disabled domain is refused, since Dokploy creates domains enabled
- the new record is created before the old one is deleted, so the domain ID changes. A failed create leaves the old record alone. If the delete fails, `DOMAIN_MOVE_INCOMPLETE` names both IDs and the old record has to go in Dokploy; a rerun is refused because the target already has the route
- a compose keeps serving the host from its container labels until it is stopped or redeployed, because Dokploy removes Traefik routes on domain delete only for applications. Both routes are live until then, and the winner is undefined, so `compose stop` is the real cutover. Deploy the target first: the dialog warns when it is not in the `done` state
- results match the other approvals, and `AGENT_APPROVAL_STALE` means the domain or the target changed while the dialog was open

## Moving a Compose service to an Application

Each write below opens one dialog when the project is outside the policy. `env copy` and `domain move` always do.

```bash
dokploy-agent application create --name backend --environmentId ENV_ID --serverId SERVER_ID --reason "..." --json
dokploy-agent application save-github-provider --applicationId APP_ID --githubId GITHUB_ID --owner OWNER --repository REPO --branch main --buildPath / --reason "..." --json
dokploy-agent application save-build-type --applicationId APP_ID --buildType dockerfile --dockerfile Dockerfile --reason "..." --json
dokploy-agent application env copy --from-compose COMPOSE_ID --applicationId APP_ID --names A,B --reason "..." --json
dokploy-agent application deploy --applicationId APP_ID --reason "..." --json
dokploy-agent deployment wait --applicationId APP_ID --json
dokploy-agent domain by-compose-id --composeId COMPOSE_ID --json
dokploy-agent domain move --domainId DOMAIN_ID --applicationId APP_ID --reason "..." --json
dokploy-agent compose stop --composeId COMPOSE_ID --reason "..." --json
```

`compose delete` stays blocked. Once the application has held the traffic for a while, the user deletes the compose in Dokploy. Delete removes the compose directory, including `../files` bind mounts, even with volumes kept.

## `deployment wait`

Blocks until the matching deployment of every listed service finishes. Use it instead of hand-rolled polling loops after a deploy or a git push.

```bash
# after a push that autodeploys two services
dokploy-agent deployment wait --applicationId APP_ID --composeId COMPOSE_ID \
  --commit "$(git rev-parse HEAD)" --json

# right after `application deploy` / `redeploy`
dokploy-agent deployment wait --applicationId APP_ID --json
```

- matching: with `--commit`, the newest deployment whose description is `Commit: <sha>` (prefix ok). Without it, the newest deployment started within `--since` (default `60s` ago) or still running
- `--applicationId` and `--composeId` repeat or take comma-separated ids; preview deployments are ignored
- `--timeout` defaults to `20m`. Dokploy runs builds one at a time, so a service can stay `not_started` while another builds. A service that never starts usually means `watchPaths` or autoDeploy skipped it
- progress goes to stderr, one line per state change; poll interval adapts to each service's typical build time from its recent deployments
- exit `0` when all are `done`, `1` when any is `error` or `cancelled`, `124` on timeout

Result:

```json
{
  "ok": true,
  "timedOut": false,
  "elapsedSeconds": 95,
  "services": [
    {
      "type": "application | compose",
      "id": "string",
      "state": "not_started | running | done | error | cancelled",
      "deploymentId": "string",
      "title": "string",
      "commit": "string",
      "startedAt": "string",
      "finishedAt": "string",
      "durationSeconds": 80,
      "typicalSeconds": 75,
      "errorMessage": "string, on failure",
      "logsCommand": "deployment read-logs command, on failure"
    }
  ]
}
```

## JSON errors

When `--json` is present, CLI errors use:

```json
{
  "ok": false,
  "error": {
    "code": "string",
    "message": "string"
  }
}
```

Every agent-safe policy denial, whether a command blocked outright or a write rejected by the deploy policy, uses code `AGENT_POLICY_BLOCKED` and exit status `2`. Other failures exit `1`. Treat exit `2` as "ask the user", not as a transient error to retry.
