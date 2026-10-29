import { type AgentApprovalConfig, apiGet } from "../client.js";
import { sanitizeForAgent } from "../redact.js";
import {
	type ApprovalLine,
	approvalTarget,
	requireUserApproval,
} from "./approval.js";
import { agentPolicyBlocked, CliError } from "./errors.js";

export interface PerimeterTarget {
	kind: string;
	id: string;
	record: Record<string, any>;
}

export interface PerimeterApproval {
	endpoint: string;
	opts: Record<string, any>;
	target: PerimeterTarget | undefined;
	denials: string[];
	reason: string | undefined;
}

// unchanged lines kept around each change in a multi-line field diff
const DIFF_CONTEXT_LINES = 1;
// past this many LCS cells the changed block shows as all removed, then all added
const MAX_DIFF_CELLS = 1_000_000;

// dialog text reaches the backend as argv, which any local process (the agent
// included) can read, so stored values go through the agent redaction;
// values the agent supplied are shown as given
function storedText(field: string, value: unknown): string {
	const sanitized = sanitizeForAgent({ [field]: value }) as Record<
		string,
		unknown
	>;
	return displayText(sanitized[field]);
}

function displayText(value: unknown): string {
	if (value === undefined) return "(unset)";
	return typeof value === "string" ? value : JSON.stringify(value);
}

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function isMultiline(value: unknown): value is string {
	return typeof value === "string" && value.includes("\n");
}

// LCS diff over the lines between the common prefix and suffix
function diffLines(before: string[], after: string[]) {
	let start = 0;
	while (
		start < before.length &&
		start < after.length &&
		before[start] === after[start]
	)
		start++;
	let end = 0;
	while (
		end < before.length - start &&
		end < after.length - start &&
		before[before.length - 1 - end] === after[after.length - 1 - end]
	)
		end++;
	const a = before.slice(start, before.length - end);
	const b = after.slice(start, after.length - end);
	const ops: ApprovalLine[] = before
		.slice(0, start)
		.map((text) => ({ kind: "text", text }));
	const suffix: ApprovalLine[] = before
		.slice(before.length - end)
		.map((text) => ({ kind: "text", text }));
	if (a.length * b.length > MAX_DIFF_CELLS) {
		return [
			...ops,
			...a.map((text): ApprovalLine => ({ kind: "remove", text })),
			...b.map((text): ApprovalLine => ({ kind: "add", text })),
			...suffix,
		];
	}
	const lcs = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0),
	);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i][j] =
				a[i] === b[j]
					? lcs[i + 1][j + 1] + 1
					: Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			ops.push({ kind: "text", text: a[i++] });
			j++;
		} else if (
			i < a.length &&
			(j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])
		) {
			ops.push({ kind: "remove", text: a[i++] });
		} else {
			ops.push({ kind: "add", text: b[j++] });
		}
	}
	return [...ops, ...suffix];
}

// hides unchanged runs away from any change behind a single "..." line
function collapseContext(ops: ApprovalLine[]): ApprovalLine[] {
	const near = ops.map((_, index) =>
		ops
			.slice(
				Math.max(0, index - DIFF_CONTEXT_LINES),
				index + DIFF_CONTEXT_LINES + 1,
			)
			.some((op) => op.kind !== "text"),
	);
	const lines: ApprovalLine[] = [];
	ops.forEach((op, index) => {
		if (near[index]) lines.push(op);
		else if (near[index - 1] !== false)
			lines.push({ kind: "text", text: "..." });
	});
	return lines;
}

function fieldDiff(
	field: string,
	before: unknown,
	after: unknown,
): ApprovalLine[] {
	if (sameValue(before, after)) return [];
	if (isMultiline(before) || isMultiline(after)) {
		const ops = diffLines(
			typeof before === "string" ? before.split("\n") : [],
			typeof after === "string" ? after.split("\n") : [],
		).map((op) =>
			op.kind === "add" ? op : { ...op, text: storedText(field, op.text) },
		);
		return [{ kind: "text", text: `${field}:` }, ...collapseContext(ops)];
	}
	return [
		{ kind: "remove", text: `${field}: ${storedText(field, before)}` },
		{ kind: "add", text: `${field}: ${displayText(after)}` },
	];
}

// "application.saveBuildType" on an application reads "save build type";
// writes through another router keep its name, e.g. "domain create"
function actionTitle(endpoint: string, kind: string): string {
	const [group, action = ""] = endpoint.split(".");
	const words = action.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
	return group === kind ? words : `${group} ${words}`;
}

// asks the user to let a write through its perimeter misses; the hard checks
// already passed. throws unless approved and the record is unchanged since
export async function approvePerimeterPost(
	config: AgentApprovalConfig | undefined,
	{ endpoint, opts, target, denials, reason }: PerimeterApproval,
): Promise<void> {
	const blocked = agentPolicyBlocked(denials.join("; "));
	if (!target) throw blocked;
	const idKey = `${target.kind}Id`;
	// a field diff only when the endpoint writes the record the guard checked
	const writesTarget = endpoint.split(".")[0] === target.kind;
	const fields = Object.keys(opts).filter(
		(field) => field !== idKey && opts[field] !== undefined,
	);
	const lines: ApprovalLine[] = fields.flatMap((field) =>
		writesTarget
			? fieldDiff(field, target.record[field], opts[field])
			: [{ kind: "add", text: `${field}: ${displayText(opts[field])}` }],
	);
	if (lines.length === 0) {
		lines.push({
			kind: "text",
			text:
				fields.length === 0
					? `run ${endpoint}`
					: `${endpoint} with no changes to ${fields.join(", ")}`,
		});
	}
	const { record } = target;
	await requireUserApproval(
		config,
		{
			endpoint,
			title: actionTitle(endpoint, target.kind),
			target: approvalTarget(target.kind, target.id, record),
			lines,
			audit: { fields },
			reason,
		},
		blocked,
	);
	const current = await apiGet(`${target.kind}.one`, { [idKey]: target.id });
	const watched = [
		"environmentId",
		"serverId",
		...(writesTarget ? fields : []),
	];
	if (watched.some((field) => !sameValue(record[field], current?.[field]))) {
		throw new CliError(
			"AGENT_APPROVAL_STALE",
			`${target.kind} ${target.id} changed while the approval dialog was open; nothing was written, retry to review the new state`,
		);
	}
}
