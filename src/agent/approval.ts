import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentApprovalConfig,
	DEFAULT_APPROVAL_TIMEOUT_SECONDS,
} from "../client.js";
import {
	type ApprovalDialog,
	type ApprovalResult,
	type DialogLine,
	detectApprovalBackend,
	runApprovalInvocation,
} from "./approval-backends.js";
import { agentPolicyBlocked, CliError } from "./errors.js";

export interface ApprovalTarget {
	kind: string;
	id: string;
	name?: string;
	project?: string;
	environment?: string;
	server?: string;
}

export interface ApprovalLine {
	kind: "text" | "add" | "remove";
	text: string;
}

export interface ApprovalRequest {
	endpoint: string;
	title: string;
	target: ApprovalTarget;
	// dialog only; may hold the new values the agent supplied. add/remove
	// lines render as a diff, so callers pass the bare text without +/-
	lines: ApprovalLine[];
	// written to the audit log, so names only, never values
	audit: Record<string, unknown>;
	// agent-supplied explanation; shown and logged as unverified
	reason?: string;
}

const MAX_LINE_CHARS = 200;
const MAX_LINES = 20;
const MAX_REASON_CHARS = 500;
const MAX_REASON_LINES = 8;

function truncate(line: string): string {
	return line.length > MAX_LINE_CHARS
		? `${line.slice(0, MAX_LINE_CHARS - 3)}...`
		: line;
}

function reasonLines(reason: string | undefined): string[] {
	const text = reason?.replaceAll("\r", "").trim();
	if (!text) return ["(none given)"];
	const clipped =
		text.length > MAX_REASON_CHARS
			? `${text.slice(0, MAX_REASON_CHARS - 3)}...`
			: text;
	const lines = clipped.split("\n");
	return lines.length > MAX_REASON_LINES
		? [...lines.slice(0, MAX_REASON_LINES), "..."]
		: lines;
}

const DIFF_MARKERS = { text: "  ", add: "+ ", remove: "- " };

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

export function buildApprovalDialog(
	request: ApprovalRequest,
	blockedReason: string,
	timeoutSeconds: number,
	requestedFrom = process.cwd(),
): ApprovalDialog {
	const { target } = request;
	const location = [target.project, target.environment]
		.filter(Boolean)
		.join("/");
	const changes: DialogLine[] = request.lines
		.slice(0, MAX_LINES)
		.map((line) => ({
			kind: line.kind,
			text: truncate(`${DIFF_MARKERS[line.kind]}${line.text}`),
		}));
	if (request.lines.length > MAX_LINES) {
		changes.push({
			kind: "note",
			text: `(${request.lines.length - MAX_LINES} more lines not shown)`,
		});
	}
	const targetLines: DialogLine[] = [
		{
			kind: "text",
			text: `${target.kind}: ${target.name ?? target.id} (${target.id})`,
		},
		...(location
			? [{ kind: "text" as const, text: `project: ${location}` }]
			: []),
		{ kind: "text", text: `server: ${target.server ?? "local"}` },
	];
	return {
		title: "dokploy-agent approval",
		heading: `Approve ${request.title}?`,
		intro: `An agent asks to run a change outside its policy. Denied automatically after ${timeoutSeconds}s.`,
		timeoutSeconds,
		lines: [
			{ kind: "heading", text: "TARGET" },
			...targetLines,
			...section("CHANGE", changes),
			...section(
				"AGENT'S REASON (unverified)",
				notes(reasonLines(request.reason)),
			),
			...section(
				"REQUESTED FROM (unverified)",
				notes([truncate(requestedFrom)]),
			),
			...section("BLOCKED BECAUSE", notes([truncate(blockedReason)])),
		],
	};
}

function approvalLogPath(): string {
	const stateHome =
		process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
	return path.join(stateHome, "dokploy-agent", "approvals.jsonl");
}

function appendApprovalLog(request: ApprovalRequest, result: ApprovalResult) {
	const logPath = approvalLogPath();
	fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
	const entry = {
		time: new Date().toISOString(),
		endpoint: request.endpoint,
		target: request.target,
		...request.audit,
		reason: request.reason,
		cwd: process.cwd(),
		result,
	};
	fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
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
	const result = await runApprovalInvocation(
		backend.invocation(
			buildApprovalDialog(request, blocked.message, timeoutSeconds),
		),
		timeoutSeconds,
	);
	appendApprovalLog(request, result);
	if (result === "approved") return;
	if (result === "unavailable") {
		throw agentPolicyBlocked(
			`${blocked.message}; no approval dialog available on this host`,
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
