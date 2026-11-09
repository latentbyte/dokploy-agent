import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentApprovalConfig,
	DEFAULT_APPROVAL_TIMEOUT_SECONDS,
	readAuthConfig,
} from "../client.js";
import {
	type ApprovalDialog,
	type ApprovalResult,
	type DialogLine,
	detectApprovalBackend,
	runApprovalInvocation,
	runDetached,
} from "./approval-backends.js";
import { agentPolicyBlocked, CliError } from "./errors.js";
import { escapeForDisplay } from "./text.js";
import { type Span, wordDiff } from "./word-diff.js";

export interface ApprovalTarget {
	kind: string;
	id: string;
	name?: string;
	appName?: string;
	project?: string;
	environment?: string;
	server?: string;
}

// target fields as read from a `<kind>.one` record
export function approvalTarget(
	kind: string,
	id: string,
	record: Record<string, any>,
): ApprovalTarget {
	return {
		kind,
		id,
		name: record.name || undefined,
		appName: record.appName || undefined,
		project: record.environment?.project?.name,
		environment: record.environment?.name,
		server: record.server?.name ?? record.serverId ?? undefined,
	};
}

export interface ApprovalLine {
	kind: "text" | "add" | "remove";
	text: string;
}

// agent-supplied context for the dialog; shown and logged as unverified
export interface ApprovalInput {
	reason?: string;
	// link to the agent's conversation, e.g. a T3 Code thread
	threadUrl?: string;
}

export const THREAD_URL_OPTION_HELP =
	"http(s) link to the agent's conversation, shown as a clickable link in the approval dialog; a T3 Code t3-thread:// link becomes its app.t3.codes URL";

const MAX_THREAD_URL_CHARS = 200;
const T3_HOSTED_APP_URL = "https://app.t3.codes";
const T3_THREAD_LINK = /^t3-thread:\/\/v2\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/;

function invalidThreadUrl(message: string): CliError {
	return new CliError("INVALID_THREAD_URL", `--thread-url ${message}`);
}

// http(s) only, so a click opens a page and never hands a custom scheme to
// another app; the dialog shows the exact URL a click opens
export function parseThreadUrl(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		throw invalidThreadUrl("needs a URL");
	}
	const raw = value.trim();
	const t3 = T3_THREAD_LINK.exec(raw);
	let url: URL;
	try {
		url = new URL(t3 ? `${T3_HOSTED_APP_URL}/threads/${t3[1]}/${t3[2]}` : raw);
	} catch {
		throw invalidThreadUrl("is not a valid URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw invalidThreadUrl(
			`must be an http(s) or t3-thread://v2 link, got ${escapeForDisplay(url.protocol)}`,
		);
	}
	if (url.username || url.password) {
		throw invalidThreadUrl("must not carry credentials");
	}
	if (url.href.length > MAX_THREAD_URL_CHARS) {
		throw invalidThreadUrl(`is longer than ${MAX_THREAD_URL_CHARS} chars`);
	}
	return url.href;
}

// reads and removes --reason and --thread-url, so generated commands do not
// send them to the API
export function takeApprovalInput(
	opts: Record<string, unknown>,
): ApprovalInput {
	const { reason, threadUrl } = opts;
	delete opts.reason;
	delete opts.threadUrl;
	return {
		reason: typeof reason === "string" ? reason : undefined,
		threadUrl: parseThreadUrl(threadUrl),
	};
}

export interface ApprovalRequest extends ApprovalInput {
	endpoint: string;
	// action phrase for the heading, e.g. "env set" or "deploy"
	title: string;
	target: ApprovalTarget;
	// dialog only; may hold the new values the agent supplied. add/remove
	// lines render as a diff, so callers pass the bare text without +/-
	lines: ApprovalLine[];
	// written to the audit log, so names only, never values
	audit: Record<string, unknown>;
}

const MAX_LINE_CHARS = 200;
const MAX_HEADING_NAME_CHARS = 60;
export const MAX_APPROVAL_LINES = 20;
const MAX_REASON_CHARS = 500;
const MAX_REASON_LINES = 8;

const TRUNCATED_MARK = " [truncated]";

// one dialog row: unsafe characters escaped so nothing hides or reorders
// text, and a cut marked as a cut rather than a plain "..."
function truncate(line: string, max = MAX_LINE_CHARS): string {
	const text = escapeForDisplay(line);
	return text.length > max
		? `${text.slice(0, max - TRUNCATED_MARK.length)}${TRUNCATED_MARK}`
		: text;
}

function reasonLines(reason: string | undefined): string[] {
	const text = reason?.replaceAll("\r", "").trim();
	if (!text) return ["(none given)"];
	const clipped =
		text.length > MAX_REASON_CHARS
			? `${text.slice(0, MAX_REASON_CHARS)}${TRUNCATED_MARK}`
			: text;
	const lines = clipped.split("\n").map((line) => truncate(line));
	return lines.length > MAX_REASON_LINES
		? [
				...lines.slice(0, MAX_REASON_LINES),
				`(${lines.length - MAX_REASON_LINES} more lines not shown)`,
			]
		: lines;
}

// parseThreadUrl already bounded the URL, so the row shows all of it
function threadLines(threadUrl: string | undefined): DialogLine[] {
	return threadUrl
		? [{ kind: "link", text: threadUrl, url: threadUrl }]
		: notes(["(none given)"]);
}

const DIFF_MARKERS = { text: "  ", add: "+ ", remove: "- " };
const MARKER_CHARS = 2;

function shifted(spans: Span[]): Span[] {
	return spans.map(([start, end]) => [
		start + MARKER_CHARS,
		end + MARKER_CHARS,
	]);
}

// pairs a run of removed rows with an equal-length run of added rows that
// follows it, and marks the words that differ, like git diff-highlight
function highlightPairs(lines: DialogLine[]): DialogLine[] {
	const out = lines.map((line) => ({ ...line }));
	for (let i = 0; i < out.length; ) {
		let removes = 0;
		while (out[i + removes]?.kind === "remove") removes++;
		let adds = 0;
		while (out[i + removes + adds]?.kind === "add") adds++;
		if (removes > 0 && removes === adds) {
			for (let k = 0; k < removes; k++) {
				const before = out[i + k];
				const after = out[i + removes + k];
				const diff = wordDiff(
					before.text.slice(MARKER_CHARS),
					after.text.slice(MARKER_CHARS),
				);
				if (!diff) continue;
				before.highlights = shifted(diff.before);
				after.highlights = shifted(diff.after);
			}
		}
		i += Math.max(1, removes + adds);
	}
	return out;
}

function section(heading: string, lines: DialogLine[]): DialogLine[] {
	return [
		{ kind: "text", text: "" },
		{ kind: "heading", text: heading },
		...lines,
	];
}

function notes(texts: string[]): DialogLine[] {
	return texts.map((text) => ({ kind: "note", text }));
}

export interface ApprovalContext {
	// Dokploy instance the request would run against
	dokployUrl: string;
	requestedFrom?: string;
}

export function buildApprovalDialog(
	request: ApprovalRequest,
	blockedReason: string,
	timeoutSeconds: number,
	{ dokployUrl, requestedFrom = process.cwd() }: ApprovalContext,
): ApprovalDialog {
	const { target } = request;
	const location = [target.project, target.environment]
		.filter(Boolean)
		.join("/");
	const changes: DialogLine[] = highlightPairs(
		request.lines.slice(0, MAX_APPROVAL_LINES).map((line) => ({
			kind: line.kind,
			text: truncate(`${DIFF_MARKERS[line.kind]}${line.text}`),
		})),
	);
	if (request.lines.length > MAX_APPROVAL_LINES) {
		changes.push({
			kind: "note",
			text: `(${request.lines.length - MAX_APPROVAL_LINES} more lines not shown)`,
		});
	}
	const names = [target.name, target.appName].filter(Boolean).join(" / ");
	const shortName = target.name ?? target.appName ?? target.id;
	const headingName = truncate(shortName, MAX_HEADING_NAME_CHARS);
	const targetLines: DialogLine[] = [
		{ kind: "text", text: truncate(`dokploy: ${dokployUrl}`) },
		{
			kind: "text",
			text: truncate(`${target.kind}: ${names || target.id} (${target.id})`),
		},
		...(location
			? [{ kind: "text" as const, text: truncate(`project: ${location}`) }]
			: []),
		{ kind: "text", text: truncate(`server: ${target.server ?? "local"}`) },
	];
	return {
		title: "dokploy-agent approval",
		heading: `Approve ${request.title} on ${target.kind} ${headingName}?`,
		intro: `An agent asks for a change that needs your approval. Nothing runs unless you approve. Denied automatically after ${timeoutSeconds}s.`,
		timeoutSeconds,
		lines: [
			{ kind: "heading", text: "TARGET" },
			...targetLines,
			...section("CHANGE", changes),
			...section(
				"AGENT'S REASON (unverified)",
				notes(reasonLines(request.reason)),
			),
			...section("AGENT THREAD (unverified)", threadLines(request.threadUrl)),
			...section(
				"REQUESTED FROM (unverified)",
				notes([truncate(requestedFrom)]),
			),
			...section("BLOCKED BECAUSE", notes([truncate(blockedReason)])),
		],
	};
}

// jsonl audit log under $XDG_STATE_HOME/dokploy-agent; callers pass no values
export function appendAgentLog(file: string, entry: Record<string, unknown>) {
	const stateHome =
		process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
	const logPath = path.join(stateHome, "dokploy-agent", file);
	fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
	fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function appendApprovalLog(
	request: ApprovalRequest,
	dokployUrl: string,
	result: ApprovalResult,
) {
	appendAgentLog("approvals.jsonl", {
		time: new Date().toISOString(),
		dokployUrl,
		endpoint: request.endpoint,
		target: request.target,
		...request.audit,
		reason: request.reason,
		threadUrl: request.threadUrl,
		cwd: process.cwd(),
		result,
	});
}

// turns a policy denial into a user prompt; anything but an explicit approval
// throws, and hosts without a dialog backend keep the original denial
export async function requireUserApproval(
	config: AgentApprovalConfig | undefined,
	request: ApprovalRequest,
	blocked: CliError,
): Promise<void> {
	if (config?.enabled === false) throw blocked;
	const backend = detectApprovalBackend();
	if (!backend) {
		throw agentPolicyBlocked(
			`${blocked.message}; no approval dialog available on this host`,
		);
	}
	const timeoutSeconds =
		config?.timeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS;
	// same resolution the API client uses, so the dialog names the real target
	const { url: dokployUrl } = readAuthConfig();
	const dialog = buildApprovalDialog(request, blocked.message, timeoutSeconds, {
		dokployUrl,
	});
	if (backend.sound) runDetached(backend.sound);
	// halfway nudge for a dialog buried behind other windows or on another space
	const remainingSeconds = Math.ceil(timeoutSeconds / 2);
	const reminder = backend.reminder?.(dialog, remainingSeconds);
	const reminderTimer = reminder
		? setTimeout(
				() => runDetached(reminder),
				(timeoutSeconds - remainingSeconds) * 1000,
			)
		: undefined;
	let result: ApprovalResult;
	try {
		result = await runApprovalInvocation(
			backend.invocation(dialog),
			timeoutSeconds,
		);
	} finally {
		clearTimeout(reminderTimer);
	}
	appendApprovalLog(request, dokployUrl, result);
	if (result === "approved") return;
	if (result === "unavailable") {
		throw agentPolicyBlocked(
			`${blocked.message}; no approval dialog available on this host`,
		);
	}
	if (result === "synthetic") {
		throw new CliError(
			"AGENT_APPROVAL_SYNTHETIC",
			`the Approve click was posted by another process, not the user's mouse or keyboard; ${blocked.message}`,
			2,
		);
	}
	if (result === "timeout") {
		throw new CliError(
			"AGENT_APPROVAL_TIMEOUT",
			`user did not answer the approval dialog within ${timeoutSeconds}s; ${blocked.message}`,
			2,
		);
	}
	throw new CliError(
		"AGENT_APPROVAL_DENIED",
		`user denied the request; ${blocked.message}`,
		2,
	);
}
