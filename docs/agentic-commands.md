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
