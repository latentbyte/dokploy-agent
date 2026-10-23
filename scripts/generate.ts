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

const MUTATING_GET_ENDPOINTS = new Set([
	"cluster.addManager",
	"cluster.addWorker",
]);

const AGENT_PROTECTED_UPDATE_FIELDS = new Map<string, Set<string>>([
	[
		"application.update",
		new Set([
			"env",
			"previewEnv",
			"buildArgs",
			"previewBuildArgs",
			"buildSecrets",
			"previewBuildSecrets",
			"password",
			"refreshToken",
		]),
	],
	["compose.update", new Set(["env", "refreshToken"])],
]);

const AGENT_EXPANDED_APPLICATION_ENDPOINTS = [
	"application.cancelDeployment",
	"application.cleanQueues",
	"application.clearDeployments",
	"application.delete",
	"application.disconnectGitProvider",
	"application.killBuild",
	"application.markRunning",
	"application.move",
	"application.refreshToken",
	"application.reload",
	"application.saveBitbucketProvider",
	"application.saveBuildType",
	"application.saveDockerProvider",
	"application.saveEnvironment",
	"application.saveGiteaProvider",
	"application.saveGithubProvider",
	"application.saveGitProvider",
	"application.saveGitlabProvider",
	"application.start",
	"application.stop",
	"application.updateTraefikConfig",
] as const;

const AGENT_DATABASE_KINDS = [
	"libsql",
	"mariadb",
	"mongo",
	"mysql",
	"postgres",
	"redis",
] as const;

const SAFE_POST_ENDPOINTS = new Set([
	"application.create",
	"application.deploy",
	"application.redeploy",
	"application.update",
	...AGENT_EXPANDED_APPLICATION_ENDPOINTS,
	"compose.create",
	"compose.deploy",
	"compose.isolatedDeployment",
	"compose.update",
	"domain.create",
	"mounts.create",
	"port.create",
	"volumeBackups.create",
	"volumeBackups.runManually",
	...AGENT_DATABASE_KINDS.flatMap((kind) => [
		`${kind}.create`,
		`${kind}.deploy`,
	]),
]);

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

const AGENT_STATE_ENDPOINTS = [
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
];

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
	const reportJson = JSON.stringify(report, null, "\t");
	const stateEndpointJson = JSON.stringify(AGENT_STATE_ENDPOINTS, null, "\t");
	return `
const AGENT_SAFETY_REPORT = ${reportJson} as const;
const AGENT_STATE_ENDPOINTS = new Set(${stateEndpointJson});
const AGENT_DEPLOY_SERVICE_MUTATIONS = new Set([
	'application.deploy',
	'application.redeploy',
	'application.update',
	'compose.deploy',
	'compose.isolatedDeployment',
	'compose.update',
]);
const AGENT_DEPLOY_DOMAIN_MUTATIONS = new Set(['domain.create']);
const AGENT_EXPANDED_APPLICATION_MUTATIONS = new Set(${JSON.stringify(AGENT_EXPANDED_APPLICATION_ENDPOINTS)});
const AGENT_DATABASE_KINDS = new Set(${JSON.stringify(AGENT_DATABASE_KINDS)});
const AGENT_FORBIDDEN_UPDATE_FIELDS: Record<string, readonly string[]> = ${JSON.stringify(Object.fromEntries([...AGENT_PROTECTED_UPDATE_FIELDS].map(([endpoint, fields]) => [endpoint, [...fields]])))};

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function agentDeployServerLabel(server: { serverId: string; name?: string }) {
	return (server.name ? server.name + ' ' : '') + '(' + server.serverId + ')';
}

function ensureAgentDeployServer(
	policy: ReturnType<typeof readAgentDeployPolicyConfig>,
	serverId: string | undefined,
	label = "serverId",
) {
	if (!serverId || policy.allowAnyServer) return undefined;
	const server = policy.servers.find((candidate) => candidate.serverId === serverId);
	if (server) return server;
	throw new Error(
		'agent-safe deploy policy rejects ' +
			label +
			' ' +
			serverId +
			'; allowed servers: ' +
			policy.servers.map(agentDeployServerLabel).join(', '),
	);
}

function agentDeployProjectLabel(project: { projectName: string; environmentName: string; environmentId: string }) {
	return project.projectName + '/' + project.environmentName + ' (' + project.environmentId + ')';
}

function allowedAgentDeployProject(policy: ReturnType<typeof readAgentDeployPolicyConfig>, environmentId: string | undefined) {
	if (!environmentId) return policy.projects[0];
	return policy.projects.find((project) => project.environmentId === environmentId);
}

function ensureAgentDeployEnvironment(policy: ReturnType<typeof readAgentDeployPolicyConfig>, opts: Record<string, any>) {
	const project = allowedAgentDeployProject(policy, opts.environmentId);
	if (project) return project;
	throw new Error('agent-safe deploy policy rejects environmentId ' + opts.environmentId + '; allowed projects: ' + policy.projects.map(agentDeployProjectLabel).join(', '));
}

function normalizeAgentDeployCreate(policy: ReturnType<typeof readAgentDeployPolicyConfig>, opts: Record<string, any>) {
	const project = ensureAgentDeployEnvironment(policy, opts);
	opts.environmentId = project.environmentId;
	ensureAgentDeployServer(policy, stringValue(opts.serverId), 'serverId');
	if (!opts.serverId && !policy.allowAnyServer) opts.serverId = policy.servers[0]?.serverId;
}

function serviceProjectName(service: any): string | undefined {
	return stringValue(service?.environment?.project?.name) ?? stringValue(service?.project?.name);
}

function serviceMatchesAgentDeployProject(project: ReturnType<typeof readAgentDeployPolicyConfig>['projects'][number], service: any) {
	const projectMatches = project.projectId
		? service?.environment?.project?.projectId === project.projectId
		: serviceProjectName(service) === project.projectName;
	return service?.environmentId === project.environmentId && projectMatches;
}

function serviceServerId(service: any): string | undefined {
	return (
		stringValue(service?.serverId) ??
		stringValue(service?.server?.serverId) ??
		stringValue(service?.buildServer?.serverId) ??
		stringValue(service?.buildServerId)
	);
}

function validateAgentDeployServerIds(
	policy: ReturnType<typeof readAgentDeployPolicyConfig>,
	labelsToServerIds: Array<{ label: string; serverId: string | undefined }>,
) {
	const seen = new Set<string>();
	for (const { label, serverId } of labelsToServerIds) {
		if (!serverId || seen.has(serverId)) continue;
		seen.add(serverId);
		ensureAgentDeployServer(policy, serverId, label);
	}
}

function assertServiceServersAllowed(
	policy: ReturnType<typeof readAgentDeployPolicyConfig>,
	service: any,
) {
	validateAgentDeployServerIds(policy, [
		{ label: 'serverId', serverId: stringValue(service?.serverId) },
		{ label: 'buildServerId', serverId: stringValue(service?.buildServerId) },
		{ label: 'server.serverId', serverId: stringValue(service?.server?.serverId) },
		{ label: 'buildServer.serverId', serverId: stringValue(service?.buildServer?.serverId) },
	]);
}

async function assertAgentServiceInDeployProject(
	policy: ReturnType<typeof readAgentDeployPolicyConfig>,
	kind: 'application' | 'compose' | 'libsql' | 'mariadb' | 'mongo' | 'mysql' | 'postgres' | 'redis',
	id: string | undefined,
) {
	if (!id) throw new Error('agent-safe deploy policy requires ' + kind + ' id');
	const endpoint = kind + '.one';
	const key = kind + 'Id';
	const service = await apiGet(endpoint, { [key]: id });
	if (!policy.projects.some((project) => serviceMatchesAgentDeployProject(project, service))) {
		const serviceProject =
			service?.environment?.project?.name ?? service?.project?.name ?? 'unknown';
		const serviceEnvironment =
			service?.environment?.name ?? service?.environmentId ?? 'unknown';
		throw new Error(
			'agent-safe deploy policy rejects ' +
				kind +
				' ' +
				id +
				' in ' +
				serviceProject +
				'/' +
				serviceEnvironment +
				'; allowed projects: ' +
				policy.projects.map(agentDeployProjectLabel).join(', '),
		);
	}
	assertServiceServersAllowed(policy, service);
	return service;
}

async function assertExpandedApplicationAllowed(
	policy: ReturnType<typeof readAgentDeployPolicyConfig>,
	applicationId: string | undefined,
) {
	if (!applicationId) {
		throw new Error('agent-safe deploy policy requires applicationId for this operation');
	}
	const application = await apiGet('application.one', { applicationId });
	if (
		isApplicationExpandedAllowed(
			policy,
			applicationCandidateFromService(application, applicationId),
		)
	) {
		assertServiceServersAllowed(policy, application);
		return application;
	}
	throw new Error(
		'agent-safe deploy policy requires application in ' +
			expandedApplicationAllowlistReason() +
			' for this operation',
	);
}

async function assertApplicationWritable(
	policy: ReturnType<typeof readAgentDeployPolicyConfig>,
	applicationId: string | undefined,
) {
	if (!applicationId) throw new Error('agent-safe deploy policy requires applicationId');
	try {
		return await assertExpandedApplicationAllowed(policy, applicationId);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!error.message.includes(expandedApplicationAllowlistReason())
		) {
			throw error;
		}
	}
	return assertAgentServiceInDeployProject(policy, 'application', applicationId);
}

function databaseKindForEndpoint(endpoint: string) {
	const kind = endpoint.split('.')[0];
	return AGENT_DATABASE_KINDS.has(kind) ? kind as 'libsql' | 'mariadb' | 'mongo' | 'mysql' | 'postgres' | 'redis' : undefined;
}

function agentDeployDomainSuffixesForServer(policy: ReturnType<typeof readAgentDeployPolicyConfig>, serverId: string | undefined) {
	if (!serverId) return policy.domainSuffixes;
	const server = ensureAgentDeployServer(policy, serverId, 'serverId');
	return server?.domainSuffixes?.length ? server.domainSuffixes : policy.domainSuffixes;
}

function normalizeAgentDomainHost(value: unknown): string | undefined {
	const host = stringValue(value);
	if (!host) return undefined;
	try {
		return new URL(host.includes('://') ? host : 'https://' + host).hostname.toLowerCase().replace(/\\.$/, '');
	} catch {
		return undefined;
	}
}

function matchingAgentDomainSuffix(host: string, suffixes: string[]) {
	return suffixes
		.filter((suffix) => host.endsWith(suffix))
		.filter((suffix) => {
			const domainName = host.slice(0, -suffix.length);
			return domainName.length > 0 && !domainName.includes('.');
		})
		.sort((a, b) => b.length - a.length)[0];
}

function assertAgentDomainHost(policy: ReturnType<typeof readAgentDeployPolicyConfig>, host: string | undefined, serverId: string | undefined) {
	if (!host) return;
	const normalizedHost = normalizeAgentDomainHost(host);
	const allowedSuffixes = agentDeployDomainSuffixesForServer(policy, serverId);
	const domainSuffix = normalizedHost
		? matchingAgentDomainSuffix(normalizedHost, allowedSuffixes)
		: undefined;
	if (!normalizedHost || !domainSuffix) {
		throw new Error('agent-safe deploy policy rejects host ' + host + '; allowed wildcard domains: *' + allowedSuffixes.join(', *'));
	}
	if (!policy.domainNameSuffix) return;
	const domainName = normalizedHost.slice(0, -domainSuffix.length);
	if (domainName.endsWith(policy.domainNameSuffix)) return;
	throw new Error('agent-safe deploy policy rejects host ' + host + '; domain name before ' + domainSuffix + ' must end with: ' + policy.domainNameSuffix);
}

function collectDokployDomainHosts(value: unknown, hosts = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) collectDokployDomainHosts(item, hosts);
		return hosts;
	}
	if (!value || typeof value !== 'object') return hosts;
	for (const [key, item] of Object.entries(value)) {
		if (key === 'host' || key === 'hostname' || key === 'domain' || key === 'url') {
			const host = normalizeAgentDomainHost(item);
			if (host) hosts.add(host);
		}
		collectDokployDomainHosts(item, hosts);
	}
	return hosts;
}

async function assertAgentDomainHostUnused(host: string | undefined) {
	const normalizedHost = normalizeAgentDomainHost(host);
	if (!normalizedHost) throw new Error('agent-safe domain.create requires a valid host');
	const inventory = await apiGet('project.all', {});
	if (collectDokployDomainHosts(inventory).has(normalizedHost)) {
		throw new Error('agent-safe domain.create rejects host ' + normalizedHost + '; domain is already in use in Dokploy');
	}
}

async function assertAgentDomainInDeployProject(policy: ReturnType<typeof readAgentDeployPolicyConfig>, opts: Record<string, any>) {
	if (opts.applicationId) {
		return assertAgentServiceInDeployProject(policy, 'application', opts.applicationId);
	}
	if (opts.composeId) {
		return assertAgentServiceInDeployProject(policy, 'compose', opts.composeId);
	}
	if (!opts.domainId) throw new Error('agent-safe deploy policy requires applicationId, composeId, or domainId for domain writes');
	const domain = await apiGet('domain.one', { domainId: opts.domainId });
	if (domain?.applicationId) {
		return assertAgentServiceInDeployProject(policy, 'application', domain.applicationId);
	}
	if (domain?.composeId) {
		return assertAgentServiceInDeployProject(policy, 'compose', domain.composeId);
	}
	throw new Error('agent-safe deploy policy could not resolve domain parent service');
}

const AGENT_VOLUME_BACKUP_SERVICE_KINDS = new Set(['application', 'compose', ...AGENT_DATABASE_KINDS]);

function volumeBackupParentFromOpts(opts: Record<string, any>) {
	const serviceType = stringValue(opts.serviceType);
	if (serviceType && AGENT_VOLUME_BACKUP_SERVICE_KINDS.has(serviceType)) {
		return { kind: serviceType, id: stringValue(opts[serviceType + 'Id']) };
	}
	for (const kind of AGENT_VOLUME_BACKUP_SERVICE_KINDS) {
		const id = stringValue(opts[kind + 'Id']);
		if (id) return { kind, id };
	}
	return undefined;
}

async function assertAgentVolumeBackupParentWritable(
	policy: ReturnType<typeof readAgentDeployPolicyConfig>,
	opts: Record<string, any>,
	endpoint: string,
) {
	const parent = volumeBackupParentFromOpts(opts);
	if (!parent?.id) {
		throw new Error('agent-safe ' + endpoint + ' requires a parent service id');
	}
	const kind = parent.kind as 'application' | 'compose' | 'libsql' | 'mariadb' | 'mongo' | 'mysql' | 'postgres' | 'redis';
	if (kind === 'application') {
		return assertApplicationWritable(policy, parent.id);
	}
	return assertAgentServiceInDeployProject(policy, kind, parent.id);
}

async function assertAgentVolumeBackupWritable(
	policy: ReturnType<typeof readAgentDeployPolicyConfig>,
	volumeBackupId: string | undefined,
	endpoint: string,
) {
	if (!volumeBackupId) throw new Error('agent-safe ' + endpoint + ' requires volumeBackupId');
	const backup = await apiGet('volumeBackups.one', { volumeBackupId });
	return assertAgentVolumeBackupParentWritable(policy, backup ?? {}, endpoint);
}

async function guardAgentSafePost(endpoint: string, opts: Record<string, any>) {
	const forbiddenUpdateFields = AGENT_FORBIDDEN_UPDATE_FIELDS[endpoint] ?? [];
	const forbiddenFields = Object.keys(opts).filter((field) => forbiddenUpdateFields.includes(field));
	if (forbiddenFields.length > 0) {
		throw new Error('agent-safe ' + endpoint + ' rejects protected fields: ' + forbiddenFields.join(', ') + '; use constrained commands');
	}
	const policy = readAgentDeployPolicyConfig();
	const databaseKind = databaseKindForEndpoint(endpoint);
	if (endpoint === 'application.create' || endpoint === 'compose.create' || (databaseKind && endpoint.endsWith('.create'))) {
		normalizeAgentDeployCreate(policy, opts);
		return;
	}
	if (databaseKind && endpoint.endsWith('.deploy')) {
		await assertAgentServiceInDeployProject(policy, databaseKind, opts[databaseKind + 'Id']);
		return;
	}
	if (AGENT_EXPANDED_APPLICATION_MUTATIONS.has(endpoint)) {
		await assertExpandedApplicationAllowed(policy, opts.applicationId);
		return;
	}
	if (endpoint === 'mounts.create') {
		if (opts.serviceType !== 'application') {
			throw new Error('agent-safe mounts.create allows only allowlisted applications');
		}
		await assertExpandedApplicationAllowed(policy, opts.serviceId);
		return;
	}
	if (endpoint === 'port.create') {
		await assertExpandedApplicationAllowed(policy, opts.applicationId);
		return;
	}
	if (endpoint === 'volumeBackups.create') {
		await assertAgentVolumeBackupParentWritable(policy, opts, endpoint);
		return;
	}
	if (endpoint === 'volumeBackups.runManually') {
		await assertAgentVolumeBackupWritable(policy, opts.volumeBackupId, endpoint);
		return;
	}
	if (AGENT_DEPLOY_SERVICE_MUTATIONS.has(endpoint)) {
		ensureAgentDeployEnvironment(policy, opts);
		ensureAgentDeployServer(policy, stringValue(opts.serverId), 'serverId');
		ensureAgentDeployServer(policy, stringValue(opts.buildServerId), 'buildServerId');
		if (endpoint.startsWith('application.')) {
			await assertApplicationWritable(policy, opts.applicationId);
		} else {
			await assertAgentServiceInDeployProject(policy, 'compose', opts.composeId);
		}
		return;
	}
	if (AGENT_DEPLOY_DOMAIN_MUTATIONS.has(endpoint)) {
		const service = await assertAgentDomainInDeployProject(policy, opts);
		assertAgentDomainHost(policy, opts.host, serviceServerId(service));
		await assertAgentDomainHostUnused(opts.host);
		return;
	}
	throw new Error('agent-safe deploy policy does not allow write endpoint ' + endpoint);
}

async function resolveExpandedApplications(policy: ReturnType<typeof readAgentDeployPolicyConfig>) {
	if (!hasExpandedApplicationAllowlist(policy)) return [];
	const data = await apiGet('project.all', {});
	const projects = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : [];
	const matches: Array<Record<string, string | undefined>> = [];
	const seen = new Set<string>();
	for (const project of projects) {
		const environments = Array.isArray(project?.environments) ? project.environments : [];
		for (const environment of environments) {
			const applications = Array.isArray(environment?.applications) ? environment.applications : [];
			for (const application of applications) {
				const applicationId = stringValue(application?.applicationId);
				const candidate = {
					applicationId,
					name: stringValue(application?.name),
					appName: stringValue(application?.appName),
					projectName: stringValue(project?.name),
					projectId: stringValue(project?.projectId),
					environmentName: stringValue(environment?.name),
					environmentId: stringValue(environment?.environmentId) ?? stringValue(application?.environmentId),
				};
				if (!isApplicationExpandedAllowed(policy, candidate)) continue;
				const key = applicationId ?? [candidate.projectName, candidate.environmentName, candidate.name].join('/');
				if (seen.has(key)) continue;
				seen.add(key);
				matches.push({
					name: candidate.name,
					appName: candidate.appName,
					applicationId: candidate.applicationId,
					projectName: candidate.projectName,
					environmentName: candidate.environmentName,
				});
			}
		}
	}
	return matches;
}

async function agentDeployPolicy() {
	const policy = readAgentDeployPolicyConfig();
	return {
		...policy,
		expandedApplications: await resolveExpandedApplications(policy),
		examples: [
			'dokploy-agent compose create --name demo --composeType docker-compose --composeFile <compose.yaml>',
			'dokploy-agent application create --name demo' + (policy.allowAnyServer ? '' : ' --serverId ' + policy.servers[0]?.serverId),
			'dokploy-agent domain create --composeId <id> --host demo' + (policy.domainNameSuffix ?? '') + policy.domainSuffixes[0] + ' --https --certificateType letsencrypt --domainType compose',
		],
	};
}

async function printAgentDeployPolicy(jsonOutput: boolean) {
	const policy = await agentDeployPolicy();
	if (jsonOutput) {
		console.log(JSON.stringify(policy, null, 2));
		return;
	}
	console.log('agent-safe deploy policy');
	console.log('projects:');
	for (const project of policy.projects) console.log('- ' + agentDeployProjectLabel(project));
	console.log('servers:');
	if (policy.allowAnyServer) console.log('- * (all servers, including the local Dokploy server)');
	for (const server of policy.servers) console.log('- ' + agentDeployServerLabel(server) + (server.hint ? ' ' + server.hint : ''));
	console.log('domain suffixes: ' + policy.domainSuffixes.join(', '));
	for (const server of policy.servers) {
		if (server.domainSuffixes?.length) console.log('domain suffixes for ' + agentDeployServerLabel(server) + ': ' + server.domainSuffixes.join(', '));
	}
	console.log('domain name suffix: ' + (policy.domainNameSuffix ?? '(none)'));
	console.log('expanded application IDs: ' + (policy.expandedApplicationIds.join(', ') || '(none)'));
	console.log('expanded projects:');
	if (policy.expandedProjects.length === 0) console.log('- (none)');
	for (const project of policy.expandedProjects) {
		const parts = [project.projectName];
		if (project.projectId) parts.push('id=' + project.projectId);
		if (project.environmentNames) parts.push('envs=' + (project.environmentNames.join('|') || '(none)'));
		parts.push(
			project.applicationNames === undefined
				? 'apps=*'
				: project.applicationNames.length === 0
					? 'apps=(none)'
					: 'apps=' + project.applicationNames.join('|'),
		);
		console.log('- ' + parts.join(' '));
	}
	if (policy.expandedApplicationNames.length > 0) {
		console.log(
			'legacy expanded application names (prefer expandedProjects): ' +
				policy.expandedApplicationNames.join(', '),
		);
	}
	console.log('resolved expanded applications:');
	for (const application of policy.expandedApplications) {
		console.log('- ' + application.name + ' (' + application.applicationId + ') in ' + application.projectName + '/' + application.environmentName);
	}
	console.log('examples:');
	for (const example of policy.examples) console.log(example);
}


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

function printCommandExamples(entries: readonly SafetyEntry[]) {
	const bin = process.env.DOKPLOY_AGENT_BIN ?? 'dokploy';
	console.log('');
	console.log('examples');
	for (const entry of entries) {
		console.log(bin + ' ' + entry.group + ' ' + entry.action + ' --help');
	}
}

function printAgentLogCommands(jsonOutput: boolean) {
	if (jsonOutput) {
		console.log(JSON.stringify(AGENT_SAFETY_REPORT.logs, null, 2));
		return;
	}
	console.log('agent-safe log commands');
	printSafetyEntries(AGENT_SAFETY_REPORT.logs.allowed, false);
	printCommandExamples(AGENT_SAFETY_REPORT.logs.allowed);
}

function printAgentStateCommands(jsonOutput: boolean) {
	const entries = AGENT_SAFETY_REPORT.allowed.filter((entry) => AGENT_STATE_ENDPOINTS.has(entry.endpoint));
	if (jsonOutput) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	console.log('agent-safe docker, traefik, and domain state commands');
	printSafetyEntries(entries, false);
	printCommandExamples(entries);
}

function registerAgentSafetyCommands(program: Command) {
	program
		.command('logs')
		.description('show agent-safe log commands')
		.option('--json', 'Output raw JSON')
		.action((opts: Record<string, any>) => printAgentLogCommands(opts.json));

	program
		.command('state')
		.description('show docker, traefik, and domain state commands')
		.option('--json', 'Output raw JSON')
		.action((opts: Record<string, any>) => printAgentStateCommands(opts.json));

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

	safety
		.command('deploy-policy')
		.description('show agent-safe write limits for deploys')
		.option('--json', 'Output raw JSON')
		.action(async (opts: Record<string, any>) => printAgentDeployPolicy(opts.json));
}
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
	const clientImports = isAgentSafeBuild
		? "apiPost, apiGet, readAgentDeployPolicyConfig, isApplicationExpandedAllowed, hasExpandedApplicationAllowlist, expandedApplicationAllowlistReason, applicationCandidateFromService"
		: "apiPost, apiGet";

	const clientImport = path
		.relative(path.dirname(OUT_PATH), path.join(IMPORTS_ROOT, "client.js"))
		.replaceAll(path.sep, "/");
	const redactImport = path
		.relative(path.dirname(OUT_PATH), path.join(IMPORTS_ROOT, "redact.js"))
		.replaceAll(path.sep, "/");
	const errorsImport = path
		.relative(
			path.dirname(OUT_PATH),
			path.join(IMPORTS_ROOT, "agent", "errors.js"),
		)
		.replaceAll(path.sep, "/");

	const normalizedClientImport = clientImport.startsWith(".")
		? clientImport
		: `./${clientImport}`;
	const normalizedRedactImport = redactImport.startsWith(".")
		? redactImport
		: `./${redactImport}`;
	const normalizedErrorsImport = errorsImport.startsWith(".")
		? errorsImport
		: `./${errorsImport}`;

	return `// Auto-generated from openapi.json, do not edit manually.
// Run: npx tsx scripts/generate.ts

import type { Command } from "commander";
import chalk from "chalk";
import { CliError } from "${normalizedErrorsImport}";
import { ${clientImports} } from "${normalizedClientImport}";
import { sanitizeForAgent } from "${normalizedRedactImport}";

interface SafetyEntry {
	endpoint: string;
	group: string;
	action: string;
	method: string;
	reason: string;
	risk?: string;
}

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
${isAgentSafeBuild ? "\tregisterAgentSafetyCommands(program);\n" : ""}${groupBlocks.join("\n")}
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
