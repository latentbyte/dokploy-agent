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

Local filtering after redaction: `--local-search`, `--local-context`, `--local-tail`, and `--local-max-chars`.

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

## `application env` commands

Blind environment mutation for existing applications. Raw existing values stay inside the CLI.

```bash
# names and masked previews only
dokploy-agent application env list --applicationId APP_ID --json

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
- multiline comment input is prefixed line-by-line to prevent assignment injection
- agent-safe builds enforce configured project and server policy before writes
- generic `application update` hides env, build-secret, password, and refresh-token fields
- generic `compose update` hides env and refresh-token fields

Dokploy exposes replacement-style environment writes. These commands perform read-modify-write internally and preserve `buildArgs`, `buildSecrets`, and `createEnvFile`. Concurrent panel edits can still race because Dokploy does not expose compare-and-swap for this operation.

## Partial `save-*` updates

Some Dokploy update endpoints require the full field set even though most fields accept `null`, for example `application save-build-type` (`--dockerfile`, `--herokuVersion`, `--railpackVersion`, ...) and the `application save-*-provider` commands. For these, the CLI makes the required fields optional: omitted ones are read from the current record (`<group>.one`) and sent unchanged, so pass only what changes:

```bash
dokploy-agent application save-build-type --applicationId ID --buildType dockerfile --dockerfile Dockerfile.prod --json
```

The generator detects these endpoints from the spec (a `<group>Id` update with a required nullable field and at least two required fields). Agent-safe policy checks run before the record is read. If the record has no value for an omitted field, the command fails with `MISSING_OPTION` before writing. Like env writes, this is read-modify-write without compare-and-swap.

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
