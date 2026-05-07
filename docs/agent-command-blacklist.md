# Agent command blacklist

This list is separate from safety policy.

Purpose: hide low-value commands from the agent-safe CLI to reduce tokens and simplify command discovery.

Built-in source: `docs/agent-command-blacklist.json`.

Optional user sources, merged after the built-in list:

- `~/.config/dokploy-agent/command-blacklist.json`
- path from `DOKPLOY_AGENT_BLACKLIST_PATH`

## Rules

- blacklisted commands are not considered unsafe by default
- they are hidden from agent-safe command groups
- they are omitted from `allowed` and `disallowed` lists
- they remain visible through `dokploy-agent agent-safety hidden`
- full CLI builds ignore this blacklist

## Current blacklist

Total built-in hidden commands: 167

Hidden groups by count:
- `admin`: 1
- `ai`: 12
- `bitbucket`: 3
- `cluster`: 3
- `customRole`: 6
- `gitProvider`: 2
- `gitea`: 3
- `github`: 2
- `gitlab`: 3
- `licenseKey`: 6
- `notification`: 41
- `organization`: 11
- `settings`: 17
- `sshKey`: 4
- `sso`: 10
- `stripe`: 8
- `tag`: 8
- `user`: 23
- `whitelabeling`: 4

Major categories:

- billing/account: `stripe.*`, `licenseKey.*`
- branding: `whitelabeling.*`
- UI taxonomy: `tag.*`
- admin/identity: `customRole.*`, `sso.*`, `organization.*`, `user.*`
- provider config noise: notification providers and git provider config mutators/tests
- infra/admin noise: cluster/admin setup, selected settings cleanup/toggle helpers, ssh key mutators
- huge redundant output: `settings.getOpenApiDocument`

## User config

Use the same JSON shape as the built-in file. `endpoint` can be an exact endpoint or a group wildcard ending in `.*`.

Example:

```json
{
  "version": 1,
  "commands": [
    {
      "endpoint": "libsql.*",
      "reason": "service type unused in this Dokploy account"
    },
    {
      "endpoint": "settings.getLogCleanupStatus",
      "reason": "not useful for this agent workflow"
    }
  ]
}
```

## When to add commands

Add commands when they are:

- redundant with local metadata
- huge output with low agent value
- billing/account/branding surfaces unrelated to deploy/debug tasks
- UI-only helpers unlikely to matter to agent workflows

Do not add commands just because they are dangerous. Use agent-safe disallowed policy for safety.
