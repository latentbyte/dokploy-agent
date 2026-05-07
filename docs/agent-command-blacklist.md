# Agent command blacklist

This list is separate from safety policy.

Purpose: hide low-value commands from the agent-safe CLI to reduce tokens and simplify command discovery.

Source of truth: `docs/agent-command-blacklist.json`.

## Rules

- blacklisted commands are not considered unsafe by default
- they are hidden from agent-safe command groups
- they are omitted from `allowed` and `disallowed` lists
- they remain visible through `dokploy agent-safety hidden`
- full CLI builds ignore this blacklist

## Starting blacklist

Current entries focus on noisy account, billing, branding, and huge-schema endpoints:

- `settings.getOpenApiDocument`
- `stripe.canCreateMoreServers`
- `stripe.getCurrentPlan`
- `stripe.getInvoices`
- `stripe.getProducts`
- `licenseKey.getEnterpriseSettings`
- `licenseKey.haveValidLicenseKey`
- `whitelabeling.get`
- `whitelabeling.getPublic`

## When to add commands

Add commands when they are:

- redundant with local metadata
- huge output with low agent value
- billing/account/branding surfaces unrelated to deploy/debug tasks
- UI-only helpers unlikely to matter to agent workflows

Do not add commands just because they are dangerous. Use agent-safe disallowed policy for safety.
