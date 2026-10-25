# Plan: interactive user approval for blocked agent writes

Status: steps 1 and 2 implemented (approval layer, env overlay with database targets), with their docs, plus `--reason` and the requester hint in the dialog. The async queue below is designed but not built; settle it before step 4. Typed confirmation is deferred to phase 2 with the Tier B endpoints. Steps 3 onward are open.

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
  - `just install` ships only `dokploy-agent`, but the API token sits in the same agent-readable config, so an agent could call the API directly. Client-side policy is a cooperative guard, not a security boundary.

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
| macOS | `process.platform === "darwin"` and `osascript` present | JXA `NSAlert` with a colored diff in a scrollable monospaced view, Deny as the default button | `display dialog ... default answer ""` |
| Windows | `win32`, `powershell.exe` | `System.Windows.Forms.MessageBox` | `Microsoft.VisualBasic.Interaction.InputBox` |
| Linux, zenity | `DISPLAY` or `WAYLAND_DISPLAY` set, and `zenity` on PATH | `zenity --question` | `zenity --entry` |
| Linux, kdialog | same, with `kdialog` | `kdialog --yesno` | `kdialog --inputbox` |
| none | fallback | returns `unavailable` | same |

Rules every backend follows:

- Text goes in through argv (AppleScript `on run argv`) or env vars (PowerShell `$env:`). It is never interpolated into script source, so service names or env values cannot inject code.
- Deny is the default button. When the timeout expires, the child process is killed and the result is `timeout`.
- Each backend parses only exit codes or stdout tokens it controls. Anything unexpected counts as `denied`.
- `unavailable` (SSH session, CI, no GUI) falls back to today's `AGENT_POLICY_BLOCKED`, so headless installs behave exactly as before.
- Windows detection also requires an interactive desktop session (`[Environment]::UserInteractive` and a non-zero session ID). Service-context processes, such as CI runners, report `unavailable` instead of blocking on an invisible MessageBox.

Error codes, all exit 2: `AGENT_APPROVAL_DENIED`, `AGENT_APPROVAL_TIMEOUT`. A `unavailable` result keeps `AGENT_POLICY_BLOCKED`, with the message noting that no approval UI was found.

Audit: every request and its decision is appended as JSONL to `$XDG_STATE_HOME/dokploy-agent/approvals.jsonl` (default `~/.local/state`): time, endpoint, target IDs and names, key names, result. Values are never written.

Config: `agentDeployPolicy.approval: { enabled?: boolean, timeoutSeconds?: number }`. Approval is on whenever a backend is available (a GUI session is detected). Set `enabled: false` to opt out and keep the hard blocks. Headless hosts get `unavailable`, so they behave as today without any config. Each approval covers exactly one request: there are no sessions, no "approve this target for N minutes", and no cached grants. The default timeout is 90s, which keeps the dialog inside a typical 120s agent tool timeout. Document it in `env.example` and in `AgentDeployPolicyConfig`.

Testing: backends are chosen through an injectable module seam that vitest mocks (`vi.mock("../src/agent/approval.js")`). There is no runtime env override. Each backend's argv construction is unit tested, including an injection test that passes quotes, newlines, and `"; do shell script` inside names and values. No test spawns a real dialog, so the ubuntu and windows CI jobs never block. The `agent-safe.yml` assertion (`project remove` exits 2 with `AGENT_POLICY_BLOCKED`) must keep passing: CI runners have no GUI session, so the backend is `unavailable`. Extend that job to assert the `unavailable` fallback message. Because approval is on by default wherever a GUI exists, any test that spawns an agent-safe build on a developer machine must point `DOKPLOY_CONFIG_PATH` at a temp config with `approval.enabled: false`. Today `tests/cli.test.ts` spawns only the full build with the real env, which has no policy layer, so it is unaffected.

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

## Agent context in the prompt (implemented)

With several agents running, the user cannot rely on chat history to know why a dialog appeared, so the explanation travels with the request:

- every env mutation takes `--reason <text>`. The dialog shows it under "agent's reason (unverified)" (up to 500 chars, 8 lines), after the CLI-derived target and diff, which are the trusted part
- the dialog shows the working directory as "requested from (unverified)", which usually identifies the project or worktree. Parent process names were left out: the wrapper `exec`s node, so the parent is just the agent's shell
- the audit log records both. The CLI does not require `--reason`; the dokploy skill tells agents to always pass it
- phase 2 endpoints get the same option from the generator

## Async approvals (design, not built)

Blocking dialogs do not scale to several agents: prompts stack up and take focus, and each agent idles until the timeout. Move to a queue, keep the blocking dialog as a mode.

Flow:

1. A write that needs approval stores a pending request and exits right away with `AGENT_APPROVAL_PENDING` (exit 2) and a request ID. Stored: the exact API payload, the pre-write record snapshot (for the stale check), the target, the dialog lines, `--reason`, cwd, and the time.
2. The agent goes on with other work, then runs `dokploy-agent approval wait <id> [--timeout <s>]` or `approval status <id>`. Results: `approved` (the write ran), `denied`, `expired`, `stale`, or `failed` with the API error.
3. The user reviews whenever they choose: a human-side review command (`dokploy-approvals` or similar, not exposed in the agent build) lists pending requests with target, diff, reason, and requester. It supports approve, deny, and approving several at once. A notifier can show "N approvals pending" without taking focus.
4. The approving side runs the stored payload itself, after re-checking the record snapshot. The agent never re-sends the request, so nothing can change between approval and execution.
5. Requests expire (default 1 hour) and every state change goes to the audit log.

Storage: `$XDG_STATE_HOME/dokploy-agent/approvals/<id>.json`, mode 0600, one file per request. Written atomically (temp file and rename) so concurrent agents do not collide.

Trust: the queue lives in files the agent's user can write, so a local queue alone stops honest mistakes but not an agent that sets out to forge an approval. The same is true of today's dialog (UI scripting). Ways to raise the bar, in order of cost:

- review command runs only from an interactive TTY and is left out of the agent build. This stops accidents, not attacks
- the approver signs each decision with a key the agent cannot use: a macOS Keychain or Secure Enclave key with user-presence access control (Touch ID), or Windows Hello. The executor verifies the signature, and only the approver executes
- the remote approver (phone push, deferred below) holds its key off the machine

Review surfaces, all on the same queue:

- native dialog (today's backends) for single-request blocking mode
- terminal review command (first async surface)
- local web page with full diffs and reasoning. Viewing is fine; Approve must be gated by a passkey (WebAuthn user verification), because a plain localhost endpoint or button can be reached by `curl` or by an agent driving the browser. WebAuthn's OS prompt (Touch ID, Windows Hello) needs the user present on every OS
- phone push (deferred)

Config: `approval.mode: "dialog" | "queue"`. Default stays `dialog` until the queue and its review command exist; then reconsider.

Interaction with step 4: generated approvable endpoints call a single `requireUserApproval`-style entry that either blocks (dialog) or enqueues (queue), so the generator does not bake in blocking semantics.

## Steps

1. `src/agent/approval.ts`: interface, four backends plus none, timeout, audit log, config parsing. Unit tests for argv construction, injection, and timeout.
2. Env overlay: prompt on perimeter miss, stale check, database targets. Tests through the existing harness with the approval module mocked: approved, denied, timeout, unavailable, stale.
3. `env apply --stdin` batch.
4. Generator (after the async design is settled): `APPROVABLE_ENDPOINTS`, real commands for approvable stubs, catch in `guardAgentSafePost`. Safety report gets a new `approval` classification, so `agent-safety allowed|disallowed` shows which commands need a prompt.
5. Docs: `readme.md` ("What it adds" section; it also still says env commands only add or comment, but `set` and `unset` exist), `agent-safe-api-surface.md`, `agentic-commands.md`, `just api-surface`, `env.example`, and the dokploy skill (agents should expect a blocking prompt and the new exit codes).
6. Public repo: tests and docs use `example.com` placeholders and fake IDs only.
7. Manual check on macOS: one real dialog per result type against a disposable app. Linux zenity check in a VM if available.

## Decisions

- Approval is per request only. No time-boxed or per-target grants.
- Approval is on by default when a GUI backend is available; `approval.enabled: false` opts out.

## Deferred (keep in scope for later phases)

- Biometric backend (Swift `LocalAuthentication` helper on macOS, Windows Hello) for Tier B. This closes the UI-scripting gap noted under the threat model.
- Headless remote approval for SSH-only agents: a push notification with approve and deny actions (for example ntfy or a phone app), answered out of band. The `ApprovalRequest` and `ApprovalResult` interface already fits it. It needs an approver-side secret the agent cannot read, so it must not live in the agent-readable config.
