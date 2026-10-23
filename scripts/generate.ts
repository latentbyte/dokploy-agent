/**
 * Generates CLI commands from the Dokploy OpenAPI spec.
 *
 * Usage:
 *   npx tsx scripts/generate.ts
 *   npx tsx scripts/generate.ts --agent-safe
 *   npx tsx scripts/generate.ts --agent-safe --out /tmp/src/generated/commands.ts
 *
 * Reads openapi.json from the project root and generates:
 *   - src/generated/commands.ts by default
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	AGENT_DATABASE_KINDS,
	AGENT_PROTECTED_UPDATE_FIELDS,
	MUTATING_GET_ENDPOINTS,
	SAFE_POST_ENDPOINTS,
} from "../src/agent/policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SPEC_PATH = path.join(ROOT, "openapi.json");
const DEFAULT_OUT_PATH = path.join(ROOT, "src", "generated", "commands.ts");
const AGENT_BLACKLIST_PATH = path.join(
	ROOT,
	"docs",
	"agent-command-blacklist.json",
);
const USER_CONFIG_HOME =
	process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
const USER_AGENT_BLACKLIST_PATH = path.join(
	USER_CONFIG_HOME,
	"dokploy",
	"agent-command-blacklist.json",
);
const LEGACY_USER_AGENT_BLACKLIST_PATH = path.join(
	USER_CONFIG_HOME,
	"dokploy-agent",
	"command-blacklist.json",
);

const AGENT_SAFE_ARG = "--agent-safe";
const OUT_ARG = "--out";
const IMPORTS_ROOT_ARG = "--imports-root";
const AGENT_SAFE_TAG = "agent-safe";
const CUSTOM_OVERLAY_ENDPOINTS = new Set(["deployment.readLogs"]);
const isAgentSafeBuild =
	process.argv.includes(AGENT_SAFE_ARG) ||
	process.env.DOKPLOY_BUILD_TAG === AGENT_SAFE_TAG;

function readArgValue(name: string): string | undefined {
	const equalsArg = process.argv.find((arg) => arg.startsWith(`${name}=`));
	if (equalsArg) return equalsArg.slice(name.length + 1);

	const index = process.argv.indexOf(name);
	if (index === -1) return undefined;

	const value = process.argv[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${name} requires a value`);
	}
	return value;
}

const outArg = readArgValue(OUT_ARG);
const importsRootArg = readArgValue(IMPORTS_ROOT_ARG);
const OUT_PATH = outArg ? path.resolve(ROOT, outArg) : DEFAULT_OUT_PATH;
const IMPORTS_ROOT = importsRootArg
	? path.resolve(ROOT, importsRootArg)
	: path.join(ROOT, "src");

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

type OptionType = "string" | "number" | "boolean" | "array" | "object";

interface OptionInfo {
	name: string;
	flag: string;
	description: string;
	required: boolean;
	type: OptionType;
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

const AGENT_HELP_GROUPS = new Set([
	"application",
	"compose",
	"deployment",
	"destination",
	"docker",
	"domain",
	"environment",
	"libsql",
	"mariadb",
	"mongo",
	"mysql",
	"postgres",
	"previewDeployment",
	"project",
	"redis",
	"server",
	"volumeBackups",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveType(prop: SchemaProperty): OptionType {
	const direct = resolveSchemaType(prop.type);
	if (direct) return direct;
	const nested = prop.anyOf?.find((candidate) => {
		if (candidate.type === undefined) return true;
		return candidate.type !== "null";
	});
	if (nested) return resolveType(nested);
	return "string";
}

function resolveSchemaType(value: string | undefined): OptionType | undefined {
	if (!value) return undefined;
	if (value === "number" || value === "integer") return "number";
	if (value === "boolean") return "boolean";
	if (value === "array") return "array";
	if (value === "object") return "object";
	if (value === "string") return "string";
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

function loadAgentCommandBlacklistFile(
	blacklistPath: string,
): BlacklistCommand[] {
	if (!fs.existsSync(blacklistPath)) return [];

	const parsed = JSON.parse(
		fs.readFileSync(blacklistPath, "utf8"),
	) as AgentCommandBlacklist;
	return parsed.commands;
}

function loadAgentCommandBlacklist(): Map<string, string> {
	const customPath = process.env.DOKPLOY_AGENT_BLACKLIST_PATH;
	const paths = [
		AGENT_BLACKLIST_PATH,
		USER_AGENT_BLACKLIST_PATH,
		LEGACY_USER_AGENT_BLACKLIST_PATH,
		...(customPath ? [customPath] : []),
	];
	const blacklist = new Map<string, string>();

	for (const blacklistPath of paths) {
		for (const command of loadAgentCommandBlacklistFile(blacklistPath)) {
			blacklist.set(command.endpoint, command.reason);
		}
	}

	return blacklist;
}

function getBlacklistReason(
	endpoint: string,
	blacklist: Map<string, string>,
): string | undefined {
	const exact = blacklist.get(endpoint);
	if (exact) return exact;

	for (const [pattern, reason] of blacklist) {
		if (pattern.endsWith(".*") && endpoint.startsWith(pattern.slice(0, -1))) {
			return reason;
		}
	}

	return undefined;
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
			reason: "side-effect endpoint guarded by agent deploy policy",
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
		const hiddenReason = getBlacklistReason(cmd.endpoint, blacklist);
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
			if (CUSTOM_OVERLAY_ENDPOINTS.has(endpoint)) continue;
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

function generateOptionLine(cmd: CommandInfo, opt: OptionInfo): string {
	const flag =
		opt.type === "boolean" ? `--${opt.name}` : `--${opt.name} <value>`;
	const policyDesc =
		isAgentSafeBuild &&
		(cmd.endpoint === "application.create" ||
			cmd.endpoint === "compose.create" ||
			AGENT_DATABASE_KINDS.some((kind) => cmd.endpoint === `${kind}.create`)) &&
		opt.name === "environmentId"
			? `${opt.description}; optional in agent-safe builds, forced to configured agentDeployPolicy project`
			: opt.description;
	const escaped = escapeSingleQuoted(policyDesc);
	const required =
		opt.required &&
		!(
			isAgentSafeBuild &&
			(cmd.endpoint === "application.create" ||
				cmd.endpoint === "compose.create" ||
				AGENT_DATABASE_KINDS.some(
					(kind) => cmd.endpoint === `${kind}.create`,
				)) &&
			opt.name === "environmentId"
		);
	return required
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
	if (opt.type === "array" || opt.type === "object") {
		return `if (opts["${opt.name}"] != null) opts["${opt.name}"] = parseJsonOption(opts["${opt.name}"], "${opt.name}", "${opt.type}");`;
	}
	return "";
}

function generateCommandCode(cmd: CommandInfo, groupVar: string): string {
	const actionName = camelToKebab(cmd.action);
	const protectedFields = AGENT_PROTECTED_UPDATE_FIELDS.get(cmd.endpoint);
	const commandOptions =
		isAgentSafeBuild && protectedFields
			? cmd.options.filter((option) => !protectedFields.has(option.name))
			: cmd.options;
	const agentLogOptionLines =
		isAgentSafeBuild && isLogCommand(cmd)
			? [
					".option('--local-search <value>', 'Filter returned logs locally after redaction')",
					".option('--local-context <value>', 'Include N lines around local log search matches')",
					".option('--local-case-sensitive', 'Use case-sensitive local log search')",
					".option('--local-tail <value>', 'Limit printed logs to last N lines after redaction/filtering, 0 disables line limit')",
					".option('--local-max-chars <value>', 'Limit printed logs to last N chars after redaction/filtering, 0 disables char limit')",
				]
			: [];
	const optionLines = [
		...commandOptions.map((opt) => generateOptionLine(cmd, opt)),
		...agentLogOptionLines,
	].join("\n\t\t");
	const coercions = commandOptions
		.map(generateCoercion)
		.filter(Boolean)
		.map((c) => `\t\t\t${c}`)
		.join("\n");

	const agentPostGuard =
		isAgentSafeBuild && cmd.method === "post"
			? `\n\t\t\tawait guardAgentSafePost("${cmd.endpoint}", opts);`
			: "";
	const apiCall =
		cmd.method === "post"
			? `await apiPost("${cmd.endpoint}", opts)`
			: `await apiGet("${cmd.endpoint}", opts)`;

	const escapedDesc = escapeSingleQuoted(cmd.description);
	const logFlag = isLogCommand(cmd) ? "true" : "false";
	const logOptionsLine =
		isAgentSafeBuild && isLogCommand(cmd)
			? "\t\t\tconst agentLogOptions = extractAgentLogOptions(opts);"
			: "";
	const logOptionsArg =
		isAgentSafeBuild && isLogCommand(cmd) ? ", agentLogOptions" : "";

	return `
	${groupVar}
		.command('${actionName}')
		.description('${escapedDesc}')
		${optionLines}
		.option('--json', 'Output raw JSON')
		.action(async (opts: Record<string, any>) => {
			const jsonOutput = opts.json; delete opts.json;
${logOptionsLine}
${coercions}${agentPostGuard}
			const data = ${apiCall};
			printOutput(data, jsonOutput, ${logFlag}${logOptionsArg});
		});`;
}

function shouldShowAgentHelpGroup(group: string): boolean {
	return !isAgentSafeBuild || AGENT_HELP_GROUPS.has(group);
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
		.command('${actionName}', { hidden: true })
		.description('[blocked] ${escapeSingleQuoted(cmd.description)}')
		.option('--json', 'Output JSON error')
		.allowUnknownOption(true)
		.allowExcessArguments(true)
		.action(() => {
			printBlockedCommand('${escapedEndpoint}', '${escapedReason}');
		});`;
}

function generateSafetyCommandCode(report: SafetyReport): string {
	return `
const AGENT_SAFETY_REPORT: AgentSafetyReport = ${JSON.stringify(report, null, "\t")};
`;
}

function generateFile(
	commands: CommandInfo[],
	report: SafetyReport,
	blacklist: Map<string, string>,
): string {
	const visibleCommands = isAgentSafeBuild
		? commands.filter((cmd) => !getBlacklistReason(cmd.endpoint, blacklist))
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
		const helpVisibility = shouldShowAgentHelpGroup(group)
			? ""
			: ", { hidden: true }";
		groupBlocks.push(
			`\tconst ${varName} = program.command('${kebabGroup}'${helpVisibility}).description('${kebabGroup} commands');`,
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
	const relativeImport = (...segments: string[]) => {
		const relative = path
			.relative(path.dirname(OUT_PATH), path.join(IMPORTS_ROOT, ...segments))
			.replaceAll(path.sep, "/");
		return relative.startsWith(".") ? relative : `./${relative}`;
	};
	const agentImports = isAgentSafeBuild
		? `import { guardAgentSafePost } from "${relativeImport("agent", "policy.js")}";
import { type AgentSafetyReport, registerAgentSafetyCommands } from "${relativeImport("agent", "safety-commands.js")}";
`
		: "";

	return `// Auto-generated from openapi.json, do not edit manually.
// Run: npx tsx scripts/generate.ts

import type { Command } from "commander";
import chalk from "chalk";
import { CliError } from "${relativeImport("agent", "errors.js")}";
import { apiGet, apiPost } from "${relativeImport("client.js")}";
import { sanitizeForAgent } from "${relativeImport("redact.js")}";
${agentImports}
export const AGENT_SAFE_BUILD = ${isAgentSafeBuild ? "true" : "false"};
${safetyCommands}
function parseJsonOption(value: unknown, name: string, kind: "array" | "object") {
	if (value === null || value === undefined || value === "") return value;
	if (kind === "array" && (value === null || Array.isArray(value))) return value;
	if (
		kind === "object" &&
		(value === null || (value && typeof value === "object" && !Array.isArray(value)))
	) return value;
	if (typeof value !== "string") {
		throw new Error("Invalid " + kind + " for --" + name + "; expected JSON string.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error("Invalid JSON for --" + name + ": " + (error instanceof Error ? error.message : "invalid JSON"));
	}
	if (kind === "array" && parsed !== null && !Array.isArray(parsed)) {
		throw new Error("Expected array for --" + name + ", received: " + String(parsed) + ".");
	}
	if (
		kind === "object" &&
		parsed !== null &&
		(typeof parsed !== "object" || Array.isArray(parsed))
	) {
		throw new Error("Expected object for --" + name + ", received: " + String(parsed) + ".");
	}
	return parsed;
}

function extractAgentLogOptions(opts: Record<string, any>) {
	const options = {
		logSearch: opts.localSearch,
		logContext: opts.localContext == null ? undefined : Number(opts.localContext),
		logCaseSensitive: opts.localCaseSensitive === true || opts.localCaseSensitive === "true",
		maxLogLines: opts.localTail == null ? undefined : Number(opts.localTail),
		maxLogChars: opts.localMaxChars == null ? undefined : Number(opts.localMaxChars),
	};
	delete opts.localSearch;
	delete opts.localContext;
	delete opts.localCaseSensitive;
	delete opts.localTail;
	delete opts.localMaxChars;
	return options;
}

function printOutput(data: unknown, jsonOutput: boolean, logOutput: boolean, agentLogOptions = {}) {
	const output = sanitizeForAgent(data, { logOutput, ...agentLogOptions });
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

function printBlockedCommand(endpoint: string, reason: string): never {
	throw new CliError(
		"AGENT_POLICY_BLOCKED",
		\`Blocked by agent-safe policy: \${endpoint}. \${reason} Ask the user for approval or use the full CLI outside agent-safe mode.\`,
		2,
	);
}

export function registerGeneratedCommands(program: Command) {
${isAgentSafeBuild ? "\tregisterAgentSafetyCommands(program, AGENT_SAFETY_REPORT);\n" : ""}${groupBlocks.join("\n")}
}
`;
}

// resource ID keys are the `<group>Id`-style params of `<group>.one` lookups;
// redaction keeps them visible so new upstream resources work without allowlisting
function collectResourceIdKeys(spec: OpenAPISpec): string[] {
	const keys = new Set<string>();
	for (const [pathKey, methods] of Object.entries(spec.paths)) {
		if (!/^\/[A-Za-z]+\.one$/.test(pathKey)) continue;
		for (const param of methods.get?.parameters ?? []) {
			if (/^[a-z][A-Za-z0-9]*Id$/.test(param.name)) keys.add(param.name);
		}
	}
	return [...keys].sort();
}

function generateResourceIdsFile(keys: string[]): string {
	return `// Auto-generated from openapi.json by scripts/generate.ts. Do not edit.
export const DOKPLOY_RESOURCE_ID_KEYS: readonly string[] = ${JSON.stringify(keys, null, "\t")};
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
const generatedFile = generateFile(parsed.commands, report, blacklist).replace(
	/^[\t ]+$/gm,
	"",
);
fs.writeFileSync(OUT_PATH, generatedFile);
fs.writeFileSync(
	path.join(path.dirname(OUT_PATH), "resource-ids.ts"),
	generateResourceIdsFile(collectResourceIdKeys(spec)),
);

const target = isAgentSafeBuild ? "agent-safe" : "full";
const generatedCount = isAgentSafeBuild
	? report.allowed.length + report.disallowed.length
	: parsed.commands.length;
console.log(
	`Generated ${generatedCount} ${target} commands -> ${path.relative(ROOT, OUT_PATH)}`,
);
