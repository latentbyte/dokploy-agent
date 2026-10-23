import chalk from "chalk";
import type { Command } from "commander";
import { printAgentDeployPolicy } from "./policy.js";

export interface SafetyEntry {
	readonly endpoint: string;
	readonly group: string;
	readonly action: string;
	readonly method: string;
	readonly reason: string;
	readonly risk?: string;
}

interface SafetyEntryGroups {
	readonly allowed: readonly SafetyEntry[];
	readonly disallowed: readonly SafetyEntry[];
	readonly hidden: readonly SafetyEntry[];
	readonly unavailable: readonly SafetyEntry[];
}

export interface AgentSafetyReport extends SafetyEntryGroups {
	readonly mode: string;
	readonly logs: SafetyEntryGroups;
}

// docker, traefik, and domain reads surfaced by `state`
const AGENT_STATE_ENDPOINTS: ReadonlySet<string> = new Set([
	"application.readTraefikConfig",
	"domain.byApplicationId",
	"domain.byComposeId",
	"domain.canGenerateTraefikMeDomains",
	"domain.one",
	"docker.getConfig",
	"docker.getContainers",
	"docker.getContainersByAppLabel",
	"docker.getContainersByAppNameMatch",
	"docker.getServiceContainersByAppName",
	"docker.getStackContainersByAppName",
	"settings.getDockerDiskUsage",
	"settings.getTraefikPorts",
	"settings.haveTraefikDashboardPortEnabled",
	"settings.health",
	"settings.readMiddlewareTraefikConfig",
	"settings.readTraefikConfig",
	"settings.readTraefikEnv",
	"settings.readTraefikFile",
	"settings.readWebServerTraefikConfig",
]);

function printSafetyEntries(
	entries: readonly SafetyEntry[],
	jsonOutput: boolean,
) {
	if (jsonOutput) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (entries.length === 0) {
		console.log(chalk.green("none"));
		return;
	}
	for (const entry of entries) {
		const risk = entry.risk ? ` risk=${entry.risk}` : "";
		console.log(`${entry.method} ${entry.endpoint} - ${entry.reason}${risk}`);
	}
}

function printCommandExamples(entries: readonly SafetyEntry[]) {
	const bin = process.env.DOKPLOY_AGENT_BIN ?? "dokploy";
	console.log("");
	console.log("examples");
	for (const entry of entries) {
		console.log(`${bin} ${entry.group} ${entry.action} --help`);
	}
}

function printAgentLogCommands(report: AgentSafetyReport, jsonOutput: boolean) {
	if (jsonOutput) {
		console.log(JSON.stringify(report.logs, null, 2));
		return;
	}
	console.log("agent-safe log commands");
	printSafetyEntries(report.logs.allowed, false);
	printCommandExamples(report.logs.allowed);
}

function printAgentStateCommands(
	report: AgentSafetyReport,
	jsonOutput: boolean,
) {
	const entries = report.allowed.filter((entry) =>
		AGENT_STATE_ENDPOINTS.has(entry.endpoint),
	);
	if (jsonOutput) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	console.log("agent-safe docker, traefik, and domain state commands");
	printSafetyEntries(entries, false);
	printCommandExamples(entries);
}

export function registerAgentSafetyCommands(
	program: Command,
	report: AgentSafetyReport,
) {
	program
		.command("logs")
		.description("show agent-safe log commands")
		.option("--json", "Output raw JSON")
		.action((opts: Record<string, any>) =>
			printAgentLogCommands(report, opts.json),
		);

	program
		.command("state")
		.description("show docker, traefik, and domain state commands")
		.option("--json", "Output raw JSON")
		.action((opts: Record<string, any>) =>
			printAgentStateCommands(report, opts.json),
		);

	const safety = program
		.command("agent-safety")
		.description("agent-safe policy metadata");

	safety
		.command("summary")
		.description("show agent-safe policy summary")
		.option("--json", "Output raw JSON")
		.action((opts: Record<string, any>) => {
			const summary = {
				mode: report.mode,
				allowed: report.allowed.length,
				disallowed: report.disallowed.length,
				hidden: report.hidden.length,
				unavailable: report.unavailable.length,
				logsAllowed: report.logs.allowed.length,
				logsDisallowed: report.logs.disallowed.length,
				logsHidden: report.logs.hidden.length,
				logsUnavailable: report.logs.unavailable.length,
			};
			if (opts.json) {
				console.log(JSON.stringify(summary, null, 2));
				return;
			}
			console.log(JSON.stringify(summary, null, 2));
		});

	safety
		.command("allowed")
		.description("show commands allowed for agents")
		.option("--json", "Output raw JSON")
		.action((opts: Record<string, any>) =>
			printSafetyEntries(report.allowed, opts.json),
		);

	safety
		.command("disallowed")
		.description("show commands blocked for agents")
		.option("--json", "Output raw JSON")
		.action((opts: Record<string, any>) =>
			printSafetyEntries(report.disallowed, opts.json),
		);

	safety
		.command("hidden")
		.description("show commands hidden from agents for token savings")
		.option("--json", "Output raw JSON")
		.action((opts: Record<string, any>) =>
			printSafetyEntries(report.hidden, opts.json),
		);

	safety
		.command("unavailable")
		.description("show commands unavailable to agents")
		.option("--json", "Output raw JSON")
		.action((opts: Record<string, any>) =>
			printSafetyEntries(report.unavailable, opts.json),
		);

	safety
		.command("logs")
		.description("show log command policy")
		.option("--json", "Output raw JSON")
		.action((opts: Record<string, any>) => {
			if (opts.json) {
				console.log(JSON.stringify(report.logs, null, 2));
				return;
			}
			console.log("allowed");
			printSafetyEntries(report.logs.allowed, false);
			console.log("disallowed");
			printSafetyEntries(report.logs.disallowed, false);
			console.log("hidden");
			printSafetyEntries(report.logs.hidden, false);
			console.log("unavailable");
			printSafetyEntries(report.logs.unavailable, false);
		});

	safety
		.command("deploy-policy")
		.description("show agent-safe write limits for deploys")
		.option("--json", "Output raw JSON")
		.action(async (opts: Record<string, any>) =>
			printAgentDeployPolicy(opts.json),
		);
}
