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
const AGENT_SAFE_TAG = "agent-safe";
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
const OUT_PATH = outArg ? path.resolve(ROOT, outArg) : DEFAULT_OUT_PATH;

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
	"application.create",
	"application.deploy",
	"application.redeploy",
	"application.update",
	"compose.create",
	"compose.deploy",
	"compose.isolatedDeployment",
	"compose.update",
	"domain.create",
	"domain.update",
]);

const AGENT_HELP_GROUPS = new Set([
	"application",
	"compose",
	"deployment",
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
			cmd.endpoint === "compose.create") &&
		opt.name === "environmentId"
			? `${opt.description}; optional in agent-safe builds, forced to configured agentDeployPolicy project`
			: opt.description;
	const escaped = escapeSingleQuoted(policyDesc);
	const required =
		opt.required &&
		!(
			isAgentSafeBuild &&
			(cmd.endpoint === "application.create" ||
				cmd.endpoint === "compose.create") &&
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
	return "";
}

function generateCommandCode(cmd: CommandInfo, groupVar: string): string {
	const actionName = camelToKebab(cmd.action);
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
		...cmd.options.map((opt) => generateOptionLine(cmd, opt)),
		...agentLogOptionLines,
	].join("\n\t\t");
	const coercions = cmd.options
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
const AGENT_DEPLOY_DOMAIN_MUTATIONS = new Set(['domain.create', 'domain.update']);

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function agentDeployServerLabel(server: { serverId: string; name?: string }) {
	return (server.name ? server.name + ' ' : '') + '(' + server.serverId + ')';
}

function ensureAgentDeployServer(policy: ReturnType<typeof readAgentDeployPolicyConfig>, opts: Record<string, any>) {
	if (!opts.serverId) return undefined;
	const server = policy.servers.find((candidate) => candidate.serverId === opts.serverId);
	if (server) return server;
	throw new Error('agent-safe deploy policy rejects serverId ' + opts.serverId + '; allowed servers: ' + policy.servers.map(agentDeployServerLabel).join(', '));
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
	ensureAgentDeployServer(policy, opts);
	if (!opts.serverId) opts.serverId = policy.servers[0]?.serverId;
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
	return stringValue(service?.serverId) ?? stringValue(service?.server?.serverId) ?? stringValue(service?.buildServer?.serverId);
}

async function assertAgentServiceInDeployProject(policy: ReturnType<typeof readAgentDeployPolicyConfig>, kind: 'application' | 'compose', id: string | undefined) {
	if (!id) throw new Error('agent-safe deploy policy requires ' + kind + ' id');
	const endpoint = kind === 'application' ? 'application.one' : 'compose.one';
	const key = kind === 'application' ? 'applicationId' : 'composeId';
	const service = await apiGet(endpoint, { [key]: id });
	if (!policy.projects.some((project) => serviceMatchesAgentDeployProject(project, service))) {
		const serviceProject = service?.environment?.project?.name ?? service?.project?.name ?? 'unknown';
		const serviceEnvironment = service?.environment?.name ?? service?.environmentId ?? 'unknown';
		throw new Error('agent-safe deploy policy rejects ' + kind + ' ' + id + ' in ' + serviceProject + '/' + serviceEnvironment + '; allowed projects: ' + policy.projects.map(agentDeployProjectLabel).join(', '));
	}
	const serverId = serviceServerId(service);
	if (serverId) ensureAgentDeployServer(policy, { serverId });
	return service;
}

function agentDeployDomainSuffixesForServer(policy: ReturnType<typeof readAgentDeployPolicyConfig>, serverId: string | undefined) {
	if (!serverId) return policy.domainSuffixes;
	const server = ensureAgentDeployServer(policy, { serverId });
	return server?.domainSuffixes?.length ? server.domainSuffixes : policy.domainSuffixes;
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
	const normalizedHost = host.toLowerCase();
	const allowedSuffixes = agentDeployDomainSuffixesForServer(policy, serverId);
	const domainSuffix = matchingAgentDomainSuffix(normalizedHost, allowedSuffixes);
	if (!domainSuffix) {
		throw new Error('agent-safe deploy policy rejects host ' + host + '; allowed wildcard domains: *' + allowedSuffixes.join(', *'));
	}
	if (!policy.domainNameSuffix) return;
	const domainName = normalizedHost.slice(0, -domainSuffix.length);
	if (domainName.endsWith(policy.domainNameSuffix)) return;
	throw new Error('agent-safe deploy policy rejects host ' + host + '; domain name before ' + domainSuffix + ' must end with: ' + policy.domainNameSuffix);
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

async function guardAgentSafePost(endpoint: string, opts: Record<string, any>) {
	const policy = readAgentDeployPolicyConfig();
	if (endpoint === 'application.create' || endpoint === 'compose.create') {
		normalizeAgentDeployCreate(policy, opts);
		return;
	}
	if (AGENT_DEPLOY_SERVICE_MUTATIONS.has(endpoint)) {
		ensureAgentDeployEnvironment(policy, opts);
		ensureAgentDeployServer(policy, opts);
		if (endpoint.startsWith('application.')) {
			await assertAgentServiceInDeployProject(policy, 'application', opts.applicationId);
		} else {
			await assertAgentServiceInDeployProject(policy, 'compose', opts.composeId);
		}
		return;
	}
	if (AGENT_DEPLOY_DOMAIN_MUTATIONS.has(endpoint)) {
		const service = await assertAgentDomainInDeployProject(policy, opts);
		assertAgentDomainHost(policy, opts.host, serviceServerId(service));
		return;
	}
	throw new Error('agent-safe deploy policy does not allow write endpoint ' + endpoint);
}

function agentDeployPolicy() {
	const policy = readAgentDeployPolicyConfig();
	return {
		...policy,
		examples: [
			'dokploy-agent compose create --name demo --composeType docker-compose --composeFile <compose.yaml>',
			'dokploy-agent application create --name demo --serverId ' + policy.servers[0]?.serverId,
			'dokploy-agent domain create --composeId <id> --host demo' + (policy.domainNameSuffix ?? '') + policy.domainSuffixes[0] + ' --https --certificateType letsencrypt --domainType compose',
		],
	};
}

function printAgentDeployPolicy(jsonOutput: boolean) {
	const policy = agentDeployPolicy();
	if (jsonOutput) {
		console.log(JSON.stringify(policy, null, 2));
		return;
	}
	console.log('agent-safe deploy policy');
	console.log('projects:');
	for (const project of policy.projects) console.log('- ' + agentDeployProjectLabel(project));
	console.log('servers:');
	for (const server of policy.servers) console.log('- ' + agentDeployServerLabel(server) + (server.hint ? ' ' + server.hint : ''));
	console.log('domain suffixes: ' + policy.domainSuffixes.join(', '));
	for (const server of policy.servers) {
		if (server.domainSuffixes?.length) console.log('domain suffixes for ' + agentDeployServerLabel(server) + ': ' + server.domainSuffixes.join(', '));
	}
	console.log('domain name suffix: ' + (policy.domainNameSuffix ?? '(none)'));
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
		.action((opts: Record<string, any>) => printAgentDeployPolicy(opts.json));
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
		? "apiPost, apiGet, readAgentDeployPolicyConfig"
		: "apiPost, apiGet";

	return `// Auto-generated from openapi.json, do not edit manually.
// Run: npx tsx scripts/generate.ts

import type { Command } from "commander";
import chalk from "chalk";
import { ${clientImports} } from "../client.js";
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
