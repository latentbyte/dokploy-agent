import type { Command } from "commander";
import {
	type ApprovalLine,
	approvalTarget,
	requireUserApproval,
} from "../agent/approval.js";
import { agentPolicyBlocked, CliError } from "../agent/errors.js";
import {
	type AgentServiceKind,
	servicePerimeterDenial,
} from "../agent/policy.js";
import { apiGet, apiPost, readAgentDeployPolicyConfig } from "../client.js";

interface DomainMoveOptions {
	agentSafe: boolean;
}

type DomainRecord = Record<string, any>;

// settings domain.create takes that travel with the domain; serviceName and
// domainType describe the old parent
const MOVED_FIELDS = [
	"host",
	"path",
	"port",
	"https",
	"certificateType",
	"customCertResolver",
	"customEntrypoint",
	"internalPath",
	"stripPath",
	"middlewares",
	"forwardAuthEnabled",
];
// a change to any of these while the dialog is open voids the approval
const DOMAIN_STATE_FIELDS = [
	...MOVED_FIELDS,
	"applicationId",
	"composeId",
	"enabled",
];
const TARGET_STATE_FIELDS = ["environmentId", "serverId", "applicationStatus"];

function domainParent(domain: DomainRecord) {
	if (domain?.applicationId) {
		return {
			kind: "application" as AgentServiceKind,
			id: String(domain.applicationId),
		};
	}
	if (domain?.composeId) {
		return {
			kind: "compose" as AgentServiceKind,
			id: String(domain.composeId),
		};
	}
	throw new Error(
		"domain move allows only application or compose domains; preview domains stay with their deployment.",
	);
}

function parsePort(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid port: ${String(value)}`);
	}
	return port;
}

function movedDomain(
	domain: DomainRecord,
	applicationId: string,
	port: number | undefined,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		applicationId,
		domainType: "application",
	};
	for (const field of MOVED_FIELDS) {
		if (domain[field] !== null && domain[field] !== undefined) {
			payload[field] = domain[field];
		}
	}
	if (port !== undefined) payload.port = port;
	return payload;
}

function sameDomainRoute(a: DomainRecord, b: DomainRecord): boolean {
	return (
		String(a.host).toLowerCase() === String(b.host).toLowerCase() &&
		(a.path ?? "/") === (b.path ?? "/")
	);
}

function changed(
	before: DomainRecord,
	after: DomainRecord,
	fields: string[],
): boolean {
	return fields.some(
		(field) =>
			JSON.stringify(before[field] ?? null) !==
			JSON.stringify(after?.[field] ?? null),
	);
}

function serviceLabel(kind: string, id: string, record: DomainRecord): string {
	const names = [record.name, record.appName].filter(Boolean).join(" / ");
	return `${kind} ${names || id} (${id})`;
}

function moveLines(
	domain: DomainRecord,
	parent: ReturnType<typeof domainParent>,
	source: DomainRecord,
	applicationId: string,
	target: DomainRecord,
	payload: Record<string, unknown>,
): ApprovalLine[] {
	const url = `${payload.https ? "https" : "http"}://${domain.host}${domain.path ?? ""}`;
	const portChange =
		payload.port === domain.port
			? `port ${payload.port ?? "default"}`
			: `port ${domain.port ?? "default"} changes to ${payload.port}`;
	const lines: ApprovalLine[] = [
		{
			kind: "remove",
			text: `${url} on ${serviceLabel(parent.kind, parent.id, source)}`,
		},
		{
			kind: "add",
			text: `${url} on ${serviceLabel("application", applicationId, target)}`,
		},
		{
			kind: "text",
			text: `${portChange}, certificate ${domain.certificateType ?? "none"}`,
		},
	];
	if (domain.middlewares?.length > 0 || domain.forwardAuthEnabled) {
		lines.push({
			kind: "text",
			text: `also moves: ${domain.middlewares?.length ?? 0} middlewares${domain.forwardAuthEnabled ? ", forward auth" : ""}`,
		});
	}
	if (parent.kind === "compose") {
		lines.push(
			{
				kind: "text",
				text: "the compose keeps serving this host from its container labels until it is stopped or redeployed",
			},
			{
				kind: "text",
				text: "both routes are live until then; stopping the compose is the real cutover",
			},
		);
	} else {
		lines.push({
			kind: "text",
			text: "the old application route is removed right after the new one is created",
		});
	}
	if (target.applicationStatus !== "done") {
		lines.push({
			kind: "text",
			text: `target status is ${target.applicationStatus ?? "unknown"}: it may not be able to serve this host yet`,
		});
	}
	return lines;
}

export function registerDomainMoveCommand(
	program: Command,
	options: DomainMoveOptions,
): void {
	const group = program.commands.find((command) => command.name() === "domain");
	if (!group) return;
	group
		.command("move")
		.description(
			"move an existing domain to an application in the same environment and server",
		)
		.requiredOption("--domainId <value>", "domainId")
		.requiredOption("--applicationId <value>", "target applicationId")
		.option(
			"--port <value>",
			"container port on the target, when it differs from the current one",
		)
		.option(
			"--reason <text>",
			"why this move is needed; always shown in the approval dialog",
		)
		.option("--json", "Output JSON")
		.action(async (opts: Record<string, unknown>) => {
			const domainId = String(opts.domainId);
			const applicationId = String(opts.applicationId);
			const port = parsePort(opts.port);
			const domain = (await apiGet("domain.one", { domainId })) as DomainRecord;
			const parent = domainParent(domain);
			if (parent.kind === "application" && parent.id === applicationId) {
				throw new Error(
					`Domain ${domainId} already routes to this application.`,
				);
			}
			// Dokploy creates domains enabled, so a move would switch this one on
			if (domain.enabled === false) {
				throw new Error(
					`Domain ${domainId} is disabled; enable it before moving.`,
				);
			}
			const source = (await apiGet(`${parent.kind}.one`, {
				[`${parent.kind}Id`]: parent.id,
			})) as DomainRecord;
			const target = (await apiGet("application.one", {
				applicationId,
			})) as DomainRecord;
			const existing = (await apiGet("domain.byApplicationId", {
				applicationId,
			})) as DomainRecord[];
			if (existing.some((other) => sameDomainRoute(other, domain))) {
				throw new Error(
					`Application ${applicationId} already has ${domain.host}; delete domain ${domainId} in Dokploy to finish the move.`,
				);
			}
			const payload = movedDomain(domain, applicationId, port);
			if (options.agentSafe) {
				const policy = readAgentDeployPolicyConfig();
				if (
					!source.environmentId ||
					source.environmentId !== target.environmentId
				) {
					throw agentPolicyBlocked(
						`agent-safe domain move requires ${parent.kind} ${parent.id} and application ${applicationId} in one environment`,
					);
				}
				if ((source.serverId ?? null) !== (target.serverId ?? null)) {
					throw agentPolicyBlocked(
						`agent-safe domain move requires ${parent.kind} ${parent.id} and application ${applicationId} on one server, since DNS points the host at the current one`,
					);
				}
				const misses = [
					servicePerimeterDenial(policy, "application", applicationId, target),
					servicePerimeterDenial(policy, parent.kind, parent.id, source),
				].flatMap((denial) => (denial ? [denial.message] : []));
				await requireUserApproval(
					policy.approval,
					{
						endpoint: "domain.move",
						title: "domain move",
						target: approvalTarget("application", applicationId, target),
						lines: moveLines(
							domain,
							parent,
							source,
							applicationId,
							target,
							payload,
						),
						audit: {
							operation: "move",
							domainId,
							host: domain.host,
							fromKind: parent.kind,
							fromId: parent.id,
						},
						reason: typeof opts.reason === "string" ? opts.reason : undefined,
					},
					agentPolicyBlocked(
						[
							`domain move always needs the user: it skips the host suffix and in-use checks for ${domain.host}`,
							...misses,
						].join("; "),
					),
				);
				const currentDomain = (await apiGet("domain.one", {
					domainId,
				})) as DomainRecord;
				const currentTarget = (await apiGet("application.one", {
					applicationId,
				})) as DomainRecord;
				if (
					changed(domain, currentDomain, DOMAIN_STATE_FIELDS) ||
					changed(target, currentTarget, TARGET_STATE_FIELDS)
				) {
					throw new CliError(
						"AGENT_APPROVAL_STALE",
						`domain ${domainId} or application ${applicationId} changed while the approval dialog was open; nothing was written, retry to review the new state`,
					);
				}
			}
			// Dokploy has no unique host, so creating first leaves the old record
			// untouched when the create fails and no restore is needed
			const created = (await apiPost("domain.create", payload)) as DomainRecord;
			try {
				await apiPost("domain.delete", { domainId });
			} catch (error) {
				throw new CliError(
					"DOMAIN_MOVE_INCOMPLETE",
					`created domain ${created?.domainId} on application ${applicationId}, but deleting domain ${domainId} failed: ${(error as Error).message}. Both records exist; delete the old one in Dokploy`,
				);
			}
			const result = {
				domainId: created?.domainId,
				previousDomainId: domainId,
				applicationId,
				host: domain.host,
				moved: true,
			};
			console.log(JSON.stringify(result, null, opts.json === true ? 2 : 0));
		});
}
