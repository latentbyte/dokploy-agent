/**
 * Generates CLI commands from the Dokploy OpenAPI spec.
 *
 * Usage:
 *   npx tsx scripts/generate.ts
 *   npx tsx scripts/generate.ts --agent-safe
 *
 * Reads openapi.json from the project root and generates:
 *   - src/generated/commands.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SPEC_PATH = path.join(ROOT, "openapi.json");
const OUT_PATH = path.join(ROOT, "src", "generated", "commands.ts");
const AGENT_BLACKLIST_PATH = path.join(
	ROOT,
	"docs",
	"agent-command-blacklist.json",
);

const AGENT_SAFE_ARG = "--agent-safe";
const AGENT_SAFE_TAG = "agent-safe";
const isAgentSafeBuild =
	process.argv.includes(AGENT_SAFE_ARG) ||
	process.env.DOKPLOY_BUILD_TAG === AGENT_SAFE_TAG;

interface OpenAPISpec {
	paths: Record<string, Record<string, OperationObject>>;
}

interface OperationObject {
	operationId?: string;
	summary?: string;
	description?: string;
	tags?: string[];
	parameters?: ParameterObject[];
	requestBody?: {
		content?: {
			"application/json"?: {
				schema?: SchemaObject;
			};
		};
	};
	responses?: Record<string, unknown>;
}

interface ParameterObject {
	name: string;
	in: string;
	required?: boolean;
	schema?: SchemaObject;
}

interface SchemaObject {
	type?: string;
	properties?: Record<string, SchemaProperty>;
	required?: string[];
	anyOf?: SchemaObject[];
	items?: SchemaObject;
	enum?: string[];
}

interface SchemaProperty {
	type?: string;
	anyOf?: SchemaObject[];
	enum?: string[];
	default?: unknown;
	description?: string;
}

interface CommandInfo {
	/** e.g. "application.create" */
	endpoint: string;
	/** e.g. "application" */
	group: string;
	/** e.g. "create" */
	action: string;
	method: "get" | "post";
	description: string;
	options: OptionInfo[];
}

interface OptionInfo {
	name: string;
	flag: string;
	description: string;
	required: boolean;
	type: "string" | "number" | "boolean";
	enumValues?: string[];
}

interface UnavailableInfo {
	endpoint: string;
	group: string;
	action: string;
	method: string;
	reason: string;
}

interface ParsedSpec {
	commands: CommandInfo[];
	unavailable: UnavailableInfo[];
}

interface SafetyEntry {
	endpoint: string;
	group: string;
	action: string;
	method: "get" | "post" | string;
	reason: string;
	risk?: string;
}

interface SafetyReport {
	mode: "full" | "agent-safe";
	allowed: SafetyEntry[];
	disallowed: SafetyEntry[];
	hidden: SafetyEntry[];
	unavailable: SafetyEntry[];
	logs: {
		allowed: SafetyEntry[];
		disallowed: SafetyEntry[];
		hidden: SafetyEntry[];
		unavailable: SafetyEntry[];
	};
}

interface BlacklistCommand {
	endpoint: string;
	reason: string;
}

interface AgentCommandBlacklist {
	version: number;
	description?: string;
	commands: BlacklistCommand[];
}

const MUTATING_GET_ENDPOINTS = new Set([
	"cluster.addManager",
	"cluster.addWorker",
]);

const SAFE_POST_ENDPOINTS = new Set([
	"application.deploy",
	"application.redeploy",
	"compose.deploy",
	"compose.deployTemplate",
	"compose.isolatedDeployment",
	"previewDeployment.redeploy",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveType(prop: SchemaProperty): "string" | "number" | "boolean" {
	const raw =
		prop.type ?? prop.anyOf?.find((s) => s.type && s.type !== "null")?.type;
	if (raw === "number" || raw === "integer") return "number";
	if (raw === "boolean") return "boolean";
	return "string";
}

function resolveEnum(prop: SchemaProperty): string[] | undefined {
	if (prop.enum) return prop.enum;
	const inner = prop.anyOf?.find((s) => s.enum);
	return inner?.enum;
}

function extractOptionsFromSchema(
	schema: SchemaObject | undefined,
): OptionInfo[] {
	if (!schema?.properties) return [];
	const required = new Set(schema.required ?? []);
	return Object.entries(schema.properties).map(([name, prop]) => {
		const type = resolveType(prop);
		const enumValues = resolveEnum(prop);
		let desc = prop.description ?? name;
		if (enumValues) desc += ` (${enumValues.join(", ")})`;
		return {
			name,
			flag: `--${name} <${type === "boolean" ? "" : "value"}>`.replace(
				/ <>/g,
				"",
			),
			description: desc,
			required: required.has(name),
			type,
			enumValues,
		};
	});
}

function extractOptionsFromParams(params: ParameterObject[]): OptionInfo[] {
	return params.map((p) => {
		const type = resolveType(p.schema ?? {});
		const enumValues = resolveEnum(p.schema ?? {});
		let desc = p.name;
		if (enumValues) desc += ` (${enumValues.join(", ")})`;
		return {
			name: p.name,
			flag: `--${p.name} <${type === "boolean" ? "" : "value"}>`.replace(
				/ <>/g,
				"",
			),
			description: desc,
			required: p.required ?? false,
			type,
			enumValues,
		};
	});
}

function camelToKebab(s: string): string {
	return s.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

function escapeSingleQuoted(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function isLogCommand(
	cmd: Pick<CommandInfo, "endpoint" | "group" | "action">,
): boolean {
	const lower = `${cmd.endpoint} ${cmd.group} ${cmd.action}`.toLowerCase();
	return lower.includes("log");
}

function riskForCommand(
	cmd: Pick<CommandInfo, "endpoint" | "method">,
): string | undefined {
	if (cmd.endpoint === "auditLog.all") return "high-privacy";
	if (cmd.endpoint === "ai.analyzeLogs") return "external-ai-data-exposure";
	if (isLogCommand(cmd as CommandInfo)) return "secret-leakage";
	if (cmd.method === "post") return "side-effect";
	return undefined;
}

function toSafetyEntry(cmd: CommandInfo, reason: string): SafetyEntry {
	return {
		endpoint: cmd.endpoint,
		group: camelToKebab(cmd.group),
		action: camelToKebab(cmd.action),
		method: cmd.method,
		reason,
		risk: riskForCommand(cmd),
	};
}

function unavailableToSafetyEntry(item: UnavailableInfo): SafetyEntry {
	const entry: SafetyEntry = {
		endpoint: item.endpoint,
		group: camelToKebab(item.group),
		action: camelToKebab(item.action),
		method: item.method,
		reason: item.reason,
	};
	if (item.endpoint.toLowerCase().includes("log")) {
		entry.risk =
			item.endpoint === "auditLog.all" ? "high-privacy" : "secret-leakage";
	}
	return entry;
}

function loadAgentCommandBlacklist(): Map<string, string> {
	if (!fs.existsSync(AGENT_BLACKLIST_PATH)) return new Map();

	const parsed = JSON.parse(
		fs.readFileSync(AGENT_BLACKLIST_PATH, "utf8"),
	) as AgentCommandBlacklist;
	return new Map(
		parsed.commands.map((command) => [command.endpoint, command.reason]),
	);
}

function classifyCommand(cmd: CommandInfo): {
	allowed: boolean;
	reason: string;
} {
	if (cmd.method === "get") {
		if (MUTATING_GET_ENDPOINTS.has(cmd.endpoint)) {
			return {
				allowed: false,
				reason: "get endpoint appears to mutate server state",
			};
		}
		return {
			allowed: true,
			reason: isLogCommand(cmd)
				? "read-only log endpoint with redaction"
				: "read-only endpoint",
		};
	}

	if (SAFE_POST_ENDPOINTS.has(cmd.endpoint)) {
		return {
			allowed: true,
			reason: "side-effect endpoint allowlisted for deploy",
		};
	}

	return { allowed: false, reason: "side-effect endpoint not allowlisted" };
}

function buildSafetyReport(
	commands: CommandInfo[],
	unavailable: UnavailableInfo[],
	blacklist: Map<string, string>,
): SafetyReport {
	const allowed: SafetyEntry[] = [];
	const disallowed: SafetyEntry[] = [];
	const hidden: SafetyEntry[] = [];
	const unavailableEntries = unavailable.map(unavailableToSafetyEntry);

	for (const cmd of commands) {
		const hiddenReason = blacklist.get(cmd.endpoint);
		if (isAgentSafeBuild && hiddenReason) {
			hidden.push(toSafetyEntry(cmd, hiddenReason));
			continue;
		}

		const decision = classifyCommand(cmd);
		if (decision.allowed) {
			allowed.push(toSafetyEntry(cmd, decision.reason));
		} else {
			disallowed.push(toSafetyEntry(cmd, decision.reason));
		}
	}

	return {
		mode: isAgentSafeBuild ? "agent-safe" : "full",
		allowed: allowed.sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
		disallowed: disallowed.sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
		hidden: hidden.sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
		unavailable: unavailableEntries.sort((a, b) =>
			a.endpoint.localeCompare(b.endpoint),
		),
		logs: {
			allowed: allowed.filter((entry) =>
				entry.endpoint.toLowerCase().includes("log"),
			),
			disallowed: disallowed.filter((entry) =>
				entry.endpoint.toLowerCase().includes("log"),
			),
			hidden: hidden.filter((entry) =>
				entry.endpoint.toLowerCase().includes("log"),
			),
			unavailable: unavailableEntries.filter((entry) =>
				entry.endpoint.toLowerCase().includes("log"),
			),
		},
	};
}

// ---------------------------------------------------------------------------
// Parse spec into CommandInfo[]
// ---------------------------------------------------------------------------

function parseSpec(spec: OpenAPISpec): ParsedSpec {
	const commands: CommandInfo[] = [];
	const unavailable: UnavailableInfo[] = [];

	for (const [pathKey, methods] of Object.entries(spec.paths)) {
		for (const [method, op] of Object.entries(methods)) {
			const endpoint = pathKey.replace(/^\//, "");
			const [group, ...rest] = endpoint.split(".");
			const action = rest.join(".");

			if (!group || !action) continue;

			if (method !== "get" && method !== "post") {
				unavailable.push({
					endpoint,
					group,
					action,
					method,
					reason: "unsupported http method",
				});
				continue;
			}

			const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
			const paramOptions = op.parameters
				? extractOptionsFromParams(op.parameters)
				: [];
			const bodyOptions = extractOptionsFromSchema(bodySchema);
			const options = [...paramOptions, ...bodyOptions];

			commands.push({
				endpoint,
				group,
				action,
				method,
				description: op.summary ?? op.description ?? `${group} ${action}`,
				options,
			});
		}
	}

	return {
		commands: commands.sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
		unavailable: unavailable.sort((a, b) =>
			a.endpoint.localeCompare(b.endpoint),
		),
	};
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

function generateOptionLine(opt: OptionInfo): string {
	const flag =
		opt.type === "boolean" ? `--${opt.name}` : `--${opt.name} <value>`;
	const escaped = escapeSingleQuoted(opt.description);
	return opt.required
		? `.requiredOption('${flag}', '${escaped}')`
		: `.option('${flag}', '${escaped}')`;
}

function generateCoercion(opt: OptionInfo): string {
	if (opt.type === "number") {
		return `if (opts["${opt.name}"] != null) opts["${opt.name}"] = Number(opts["${opt.name}"]);`;
	}
	if (opt.type === "boolean") {
		return `if (opts["${opt.name}"] != null) opts["${opt.name}"] = opts["${opt.name}"] === true || opts["${opt.name}"] === "true";`;
	}
	return "";
}

function generateCommandCode(cmd: CommandInfo, groupVar: string): string {
	const actionName = camelToKebab(cmd.action);
	const optionLines = cmd.options.map(generateOptionLine).join("\n\t\t");
	const coercions = cmd.options
		.map(generateCoercion)
		.filter(Boolean)
		.map((c) => `\t\t\t${c}`)
		.join("\n");

	const apiCall =
		cmd.method === "post"
			? `await apiPost("${cmd.endpoint}", opts)`
			: `await apiGet("${cmd.endpoint}", opts)`;

	const escapedDesc = escapeSingleQuoted(cmd.description);
	const logFlag = isLogCommand(cmd) ? "true" : "false";

	return `
	${groupVar}
		.command('${actionName}')
		.description('${escapedDesc}')
		${optionLines}
		.option('--json', 'Output raw JSON')
		.action(async (opts: Record<string, any>) => {
			const jsonOutput = opts.json; delete opts.json;
${coercions}
			const data = ${apiCall};
			printOutput(data, jsonOutput, ${logFlag});
		});`;
}

function generateBlockedCommandCode(
	cmd: CommandInfo,
	groupVar: string,
): string {
	const actionName = camelToKebab(cmd.action);
	const decision = classifyCommand(cmd);
	const entry = toSafetyEntry(cmd, decision.reason);
	const escapedReason = escapeSingleQuoted(entry.reason);
	const escapedEndpoint = escapeSingleQuoted(entry.endpoint);

	return `
	${groupVar}
		.command('${actionName}')
		.description('[blocked] ${escapeSingleQuoted(cmd.description)}')
		.allowUnknownOption(true)
		.allowExcessArguments(true)
		.action(() => {
			printBlockedCommand('${escapedEndpoint}', '${escapedReason}');
		});`;
}

function generateSafetyCommandCode(report: SafetyReport): string {
	const reportJson = JSON.stringify(report, null, "\t");
	return `
const AGENT_SAFETY_REPORT = ${reportJson} as const;

function printSafetyEntries(entries: readonly SafetyEntry[], jsonOutput: boolean) {
	if (jsonOutput) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (entries.length === 0) {
		console.log(chalk.green('none'));
		return;
	}
	for (const entry of entries) {
		const risk = entry.risk ? \` risk=\${entry.risk}\` : '';
		console.log(entry.method + ' ' + entry.endpoint + ' - ' + entry.reason + risk);
	}
}

function registerAgentSafetyCommands(program: Command) {
	const safety = program.command('agent-safety').description('agent-safe policy metadata');

	safety
		.command('summary')
		.description('show agent-safe policy summary')
		.option('--json', 'Output raw JSON')
		.action((opts: Record<string, any>) => {
			const summary = {
				mode: AGENT_SAFETY_REPORT.mode,
				allowed: AGENT_SAFETY_REPORT.allowed.length,
				disallowed: AGENT_SAFETY_REPORT.disallowed.length,
				hidden: AGENT_SAFETY_REPORT.hidden.length,
				unavailable: AGENT_SAFETY_REPORT.unavailable.length,
				logsAllowed: AGENT_SAFETY_REPORT.logs.allowed.length,
				logsDisallowed: AGENT_SAFETY_REPORT.logs.disallowed.length,
				logsHidden: AGENT_SAFETY_REPORT.logs.hidden.length,
				logsUnavailable: AGENT_SAFETY_REPORT.logs.unavailable.length,
			};
			if (opts.json) {
				console.log(JSON.stringify(summary, null, 2));
				return;
			}
			console.log(JSON.stringify(summary, null, 2));
		});

	safety
		.command('allowed')
		.description('show commands allowed for agents')
		.option('--json', 'Output raw JSON')
		.action((opts: Record<string, any>) => printSafetyEntries(AGENT_SAFETY_REPORT.allowed, opts.json));

	safety
		.command('disallowed')
		.description('show commands blocked for agents')
		.option('--json', 'Output raw JSON')
		.action((opts: Record<string, any>) => printSafetyEntries(AGENT_SAFETY_REPORT.disallowed, opts.json));

	safety
		.command('hidden')
		.description('show commands hidden from agents for token savings')
		.option('--json', 'Output raw JSON')
		.action((opts: Record<string, any>) => printSafetyEntries(AGENT_SAFETY_REPORT.hidden, opts.json));

	safety
		.command('unavailable')
		.description('show commands unavailable to agents')
		.option('--json', 'Output raw JSON')
		.action((opts: Record<string, any>) => printSafetyEntries(AGENT_SAFETY_REPORT.unavailable, opts.json));

	safety
		.command('logs')
		.description('show log command policy')
		.option('--json', 'Output raw JSON')
		.action((opts: Record<string, any>) => {
			if (opts.json) {
				console.log(JSON.stringify(AGENT_SAFETY_REPORT.logs, null, 2));
				return;
			}
			console.log('allowed');
			printSafetyEntries(AGENT_SAFETY_REPORT.logs.allowed, false);
			console.log('disallowed');
			printSafetyEntries(AGENT_SAFETY_REPORT.logs.disallowed, false);
			console.log('hidden');
			printSafetyEntries(AGENT_SAFETY_REPORT.logs.hidden, false);
			console.log('unavailable');
			printSafetyEntries(AGENT_SAFETY_REPORT.logs.unavailable, false);
		});
}
`;
}

function generateFile(
	commands: CommandInfo[],
	report: SafetyReport,
	blacklist: Map<string, string>,
): string {
	const visibleCommands = isAgentSafeBuild
		? commands.filter((cmd) => !blacklist.has(cmd.endpoint))
		: commands;
	const safeCommands = isAgentSafeBuild
		? visibleCommands.filter((cmd) => classifyCommand(cmd).allowed)
		: visibleCommands;
	const blockedCommands = isAgentSafeBuild
		? visibleCommands.filter((cmd) => !classifyCommand(cmd).allowed)
		: [];

	const groups = new Map<string, CommandInfo[]>();
	const blockedGroups = new Map<string, CommandInfo[]>();
	for (const cmd of safeCommands) {
		const existing = groups.get(cmd.group) ?? [];
		existing.push(cmd);
		groups.set(cmd.group, existing);
	}
	for (const cmd of blockedCommands) {
		const existing = blockedGroups.get(cmd.group) ?? [];
		existing.push(cmd);
		blockedGroups.set(cmd.group, existing);
	}

	const allGroups = new Set([...groups.keys(), ...blockedGroups.keys()]);
	const groupBlocks: string[] = [];
	for (const group of [...allGroups].sort((a, b) => a.localeCompare(b))) {
		const varName = `g_${group.replace(/[^a-zA-Z0-9]/g, "_")}`;
		const kebabGroup = camelToKebab(group);
		groupBlocks.push(
			`\tconst ${varName} = program.command('${kebabGroup}').description('${kebabGroup} commands');`,
		);
		for (const cmd of (groups.get(group) ?? []).sort((a, b) =>
			a.endpoint.localeCompare(b.endpoint),
		)) {
			groupBlocks.push(generateCommandCode(cmd, varName));
		}
		for (const cmd of (blockedGroups.get(group) ?? []).sort((a, b) =>
			a.endpoint.localeCompare(b.endpoint),
		)) {
			groupBlocks.push(generateBlockedCommandCode(cmd, varName));
		}
	}

	const safetyCommands = isAgentSafeBuild
		? generateSafetyCommandCode(report)
		: "";

	return `// Auto-generated from openapi.json, do not edit manually.
// Run: npx tsx scripts/generate.ts

import type { Command } from "commander";
import chalk from "chalk";
import { apiPost, apiGet } from "../client.js";
import { sanitizeForAgent } from "../redact.js";

interface SafetyEntry {
	endpoint: string;
	group: string;
	action: string;
	method: string;
	reason: string;
	risk?: string;
}

const AGENT_SAFE_BUILD = ${isAgentSafeBuild ? "true" : "false"};
${safetyCommands}
function printOutput(data: unknown, jsonOutput: boolean, logOutput: boolean) {
	const output = AGENT_SAFE_BUILD ? sanitizeForAgent(data, { logOutput }) : data;
	if (jsonOutput) {
		console.log(JSON.stringify(output, null, 2));
		return;
	}
	if (output === null || output === undefined) {
		console.log(chalk.green("OK"));
		return;
	}
	if (typeof output === "string") {
		console.log(output);
		return;
	}
	console.log(JSON.stringify(output, null, 2));
}

function printBlockedCommand(endpoint: string, reason: string) {
	console.error(chalk.red(\`Blocked by agent-safe policy: \${endpoint}\`));
	console.error(reason);
	console.error("Ask the user for approval or use the full CLI outside agent-safe mode.");
	process.exitCode = 2;
}

export function registerGeneratedCommands(program: Command) {
${isAgentSafeBuild ? "\tregisterAgentSafetyCommands(program);\n" : ""}${groupBlocks.join("\n")}
}
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const spec: OpenAPISpec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
const parsed = parseSpec(spec);
const blacklist = loadAgentCommandBlacklist();
const report = buildSafetyReport(
	parsed.commands,
	parsed.unavailable,
	blacklist,
);

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, generateFile(parsed.commands, report, blacklist));

const target = isAgentSafeBuild ? "agent-safe" : "full";
const generatedCount = isAgentSafeBuild
	? report.allowed.length + report.disallowed.length
	: parsed.commands.length;
console.log(
	`Generated ${generatedCount} ${target} commands -> ${path.relative(ROOT, OUT_PATH)}`,
);
