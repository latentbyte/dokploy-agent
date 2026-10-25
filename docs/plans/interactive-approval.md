# Plan: interactive user approval for blocked agent writes

Status: proposed. Nothing implemented yet.

## Goal

Some agent-safe denials exist only because the CLI cannot tell whether the user wants the change, not because the change is unsafe. For those, the CLI should stop, show the exact change to the human, and continue only when the human approves. Everything else keeps today's behavior: exit 2 with `AGENT_POLICY_BLOCKED`.

First target: environment variable writes (`env add|set|unset|comment`) on services outside the deploy perimeter, plus database env, which has no agent path at all today.

## Today

- Perimeter guards (`guardAgentSafePost`, `assertServiceRecordWritable` in `src/agent/policy.ts`) throw `agentPolicyBlocked` when the target is outside `agentDeployPolicy`.
- 185 disallowed endpoints are generated as blocked stubs (`generateBlockedCommandCode` in `scripts/generate.ts`). These stubs do not parse options or call the API, and their message tells the agent to ask the user or use the full CLI.
- Env overlays (`src/commands/service-env.ts`) already do blind read-modify-write for `application` and `compose`. Writes are limited to deploy-project services and expanded apps.
- `<db>.saveEnvironment` takes only `{ <db>Id, env }` for every database kind and is blocked.

## Threat model

- The agent must not be able to answer the prompt. Stdin and TTY prompts are out: `yes |` defeats stdin, and some harnesses give the agent a pty.
- No env var, flag, or file can skip the prompt at runtime.
- The approval covers the exact payload. The CLI builds the request before showing the prompt and sends that same request after approval. If the target record changed while the prompt was open (re-fetch and compare), it aborts.
- Residual risks, documented rather than solved:
  - The agent can edit the JSONC config, which also holds `agentDeployPolicy`. It can already widen the perimeter that way, so approval adds no new hole.
  - On macOS, an agent whose terminal has Accessibility permission can click dialogs through System Events UI scripting. A later biometric backend closes this gap.
  - The full `dokploy` CLI uses the same token. Client-side policy is a cooperative guard, not a security boundary.

## Approval layer (OS-independent)

New module `src/agent/approval.ts`. Callers see one interface. Platform backends sit behind it, are detected at runtime, and need no new npm dependencies (`child_process.spawn` with argv arrays, never a shell string).

```ts
interface ApprovalRequest {
  endpoint: string;
  title: string; // "Set env var on application"
  target: { kind: string; name: string; project?: string; environment?: string; server?: string };
  lines: string[]; // human summary, already truncated
  confirmText?: string; // typed-confirmation tier: user must type this (service name)
  timeoutSeconds: number;
}
type ApprovalResult = "approved" | "denied" | "timeout" | "unavailable";
function requestApproval(req: ApprovalRequest): Promise<ApprovalResult>;
```

Backends, tried in order; the first one available wins:

| Backend | Detect | Confirm | Typed confirm |
| --- | --- | --- | --- |
| macOS | `process.platform === "darwin"` and `osascript` present | `display dialog` with Deny as the default button | `display dialog ... default answer ""` |
| Windows | `win32`, `powershell.exe` | `System.Windows.Forms.MessageBox` | `Microsoft.VisualBasic.Interaction.InputBox` |
| Linux, zenity | `DISPLAY` or `WAYLAND_DISPLAY` set, and `zenity` on PATH | `zenity --question` | `zenity --entry` |
| Linux, kdialog | same, with `kdialog` | `kdialog --yesno` | `kdialog --inputbox` |
| none | fallback | returns `unavailable` | same |

Rules every backend follows:

- Text goes in through argv (AppleScript `on run argv`) or env vars (PowerShell `$env:`). It is never interpolated into script source, so service names or env values cannot inject code.
- Deny is the default button. When the timeout expires, the child process is killed and the result is `timeout`.
- Each backend parses only exit codes or stdout tokens it controls. Anything unexpected counts as `denied`.
- `unavailable` (SSH session, CI, no GUI) falls back to today's `AGENT_POLICY_BLOCKED`, so headless installs behave exactly as before.

Error codes, all exit 2: `AGENT_APPROVAL_DENIED`, `AGENT_APPROVAL_TIMEOUT`. A `unavailable` result keeps `AGENT_POLICY_BLOCKED`, with the message noting that no approval UI was found.

Audit: every request and its decision is appended as JSONL to `$XDG_STATE_HOME/dokploy-agent/approvals.jsonl` (default `~/.local/state`): time, endpoint, target IDs and names, key names, result. Values are never written.

Config: `agentDeployPolicy.approval: { enabled: boolean, timeoutSeconds?: number }`. It defaults to off. The default timeout is 90s, which keeps the dialog inside a typical 120s agent tool timeout. Document it in `env.example` and in `AgentDeployPolicyConfig`.

Testing: backends are chosen through an injectable module seam that vitest mocks (`vi.mock("../src/agent/approval.js")`). There is no runtime env override. Each backend's argv construction is unit tested, including an injection test that passes quotes, newlines, and `"; do shell script` inside names and values.

## Env setting and updating (phase 1)

Change `readService` in `service-env.ts`: when `assertServiceRecordWritable` throws `AGENT_POLICY_BLOCKED` and approval is enabled, prompt instead of failing. In-perimeter services keep working without a prompt.

Dialog content:

- target: name, appName, project/environment, server
- operation and key: `set API_URL (replace existing)`, `add NEW_KEY`, `unset OLD_KEY (2 assignments)`, `comment EXISTING_KEY`
- old value: masked preview only (the human can open the panel for the real value)
- new value: shown in full, truncated at about 200 chars. The agent supplied it, so it is not secret from the agent, and the human needs to see it to review it.

Binding: compute `nextEnv` from the fetched record before prompting. After approval, re-fetch `env` (and the companion fields for applications). If anything differs, abort with `AGENT_APPROVAL_STALE` and write nothing. This also gives env writes a cheap compare-and-swap.

Database env: add `libsql`, `mariadb`, `mongo`, `mysql`, `postgres`, `redis` to `ENV_TARGETS`, saving through `<db>.saveEnvironment` with `{ <db>Id, env }`. Policy:

- in a deploy project: no prompt (same as compose)
- elsewhere: approval required
- remove `<db>.saveEnvironment` from the generated disallowed list only through the overlay. The raw replace-the-whole-document endpoint stays blocked.

Batch: add `env apply --stdin`, which reads a JSON list of `{op, name, value?}` and shows one dialog for the whole diff. Without it, an agent setting five keys triggers five dialogs. This also keeps values out of argv and `ps` output; the single-key commands could take a `--value-stdin` alternative.

Out of phase 1: `buildArgs` and `buildSecrets` editing. They are protected fields today even inside the perimeter. They could get the same overlay later with approval always required.

## Other endpoints (phase 2+)

Rule: an endpoint qualifies only if the dialog can show the change faithfully in a few lines and the change is reversible or limited to one service.

Mechanics: add a table `APPROVABLE_ENDPOINTS: Map<endpoint, "confirm" | "typed">` in `policy.ts`.

- Perimeter-guarded endpoints: `guardAgentSafePost` catches `AGENT_POLICY_BLOCKED` and prompts when the endpoint is in the table.
- Currently stubbed endpoints in the table: the generator emits real commands that call `requireApproval(endpoint, opts)` before the API call. Template strings stay thin.
- The summary builder resolves the target with `<group>.one` and lists the passed fields, applying the redactor to secret-like keys.

Tier A, confirm:

- perimeter misses: deploy, redeploy, start, stop, reload, update, save-*-provider on services outside policy; `mounts create` and `port create` on non-allowlisted apps
- `compose redeploy | cancel-deployment | kill-build | clean-queues`, `previewDeployment.redeploy`, `rollback.rollback`, `deployment.killProcess`
- `docker start | stop | restart-container`, `<db>.changeStatus | rebuild`
- `schedule.runManually`, `backup.manualBackup*`
- `domain update | toggleEnable` (with host suffix still checked), `mounts update`, `port update | delete`, `redirects.*`, `security.*`, `volumeBackups update | delete`, `<db>.update | saveExternalPort`
- `environment.create`, `project.create`, `schedule create | update`

Tier B, typed confirm (the user types the service name):

- `application.delete` outside expanded apps, `compose.delete`, `<db>.remove`, `project.remove`, `environment.remove`, `previewDeployment.delete`
- `dockerVolume.removeVolume`, `docker.removeContainer`, `dockerImage.removeImage`, `rollback.delete`, `deployment.removeDeployment`
- `<kind>.move`, `<db>.changePassword`, `compose.disconnectGitProvider`

Tier C, stays hard-blocked:

- output reaches the agent, so approval cannot help: `docker.readContainerFile`, `dockerVolume.readVolumeFile`, `*.refreshToken`
- content too large to review in a dialog: `docker write | upload | deleteContainerFile`, `dockerVolume write | deleteVolumeFile`, `patch.*`, `compose.import`, `settings.updateTraefikConfig | updateTraefikFile | updateMiddlewareTraefikConfig`
- server-wide blast radius: `server.*` writes, `settings.*`, `network.*`, `forwardAuth.*`, `cluster.*`
- identity, credentials, exfiltration: `sso`, `scim`, `user`, `custom-role`, `organization`, `ai.saveCustomProviders`, `stripe`, `dnsProvider.*`, `registry.*`, `destination.*`, `vaultProvider.*`, `certificates.*`

## Steps

1. `src/agent/approval.ts`: interface, four backends plus none, timeout, audit log, config parsing. Unit tests for argv construction, injection, and timeout.
2. Env overlay: prompt on perimeter miss, stale check, database targets. Tests through the existing harness with the approval module mocked: approved, denied, timeout, unavailable, stale.
3. `env apply --stdin` batch.
4. Generator: `APPROVABLE_ENDPOINTS`, real commands for approvable stubs, catch in `guardAgentSafePost`. Safety report gets a new `approval` classification, so `agent-safety allowed|disallowed` shows which commands need a prompt.
5. Docs: `agent-safe-api-surface.md`, `agentic-commands.md`, `just api-surface`, `env.example`, and the dokploy skill (agents should expect a blocking prompt and the new exit codes).
6. Manual check on macOS: one real dialog per result type against a disposable app. Linux zenity check in a VM if available.

## Open questions

1. Approve once per request only, or also "approve for this target for N minutes"? Proposed: once only for phase 1.
2. Should approval mode default to on when a GUI is detected? Proposed: off, opt-in through config.
3. Biometric backend (Swift `LocalAuthentication` helper on macOS, Windows Hello) for Tier B? Proposed: defer.
4. Headless remote approval (push notification with approve and deny actions) for SSH-only agents? Proposed: defer, but keep the backend interface ready for it.
