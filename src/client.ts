import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import axios, { type AxiosInstance } from "axios";
import { CliError } from "./agent/errors.js";
import { redactString, sanitizeForAgent } from "./redact.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const legacyConfigPath = path.join(__dirname, "..", "config.json");
const CONFIG_DIR_NAME = "dokploy";
const CONFIG_FILE_NAME = "config.json";
const MAX_ERROR_BODY_CHARS = 4000;

export interface AgentDeployServerConfig {
	serverId: string;
	name?: string;
	hint?: string;
	domainSuffixes?: string[];
}

export interface AgentDeployProjectConfig {
	projectName: string;
	projectId?: string;
	environmentName: string;
	environmentId: string;
}

export interface ExpandedProjectConfig {
	projectName: string;
	projectId?: string;
	/** when set, only these environment names match (case-insensitive) */
	environmentNames?: string[];
	/**
	 * omitted: all applications in the project
	 * []: no applications from this entry
	 * non-empty: only matching application name/appName (case-insensitive)
	 */
	applicationNames?: string[];
}

export interface ExpandedApplicationCandidate {
	applicationId?: string;
	name?: string;
	appName?: string;
	projectName?: string;
	projectId?: string;
	environmentName?: string;
	environmentId?: string;
}

export interface AgentDeployPolicyConfig {
	projects: AgentDeployProjectConfig[];
	servers: AgentDeployServerConfig[];
	allowAnyServer?: boolean;
	domainSuffixes: string[];
	domainNameSuffix?: string;
	expandedProjects: ExpandedProjectConfig[];
	expandedApplicationIds: string[];
	/** @deprecated prefer expandedProjects; kept as legacy global name fallback */
	expandedApplicationNames: string[];
}

export interface AuthConfig {
	token: string;
	url: string;
	agentDeployPolicy?: AgentDeployPolicyConfig;
}

export function getAuthConfigPath(): string {
	if (process.env.DOKPLOY_CONFIG_PATH) {
		return path.resolve(process.env.DOKPLOY_CONFIG_PATH);
	}

	const configHome =
		process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
	return path.join(configHome, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

function getReadableConfigPath(): string | undefined {
	const configPath = getAuthConfigPath();
	if (fs.existsSync(configPath)) return configPath;
	if (fs.existsSync(legacyConfigPath)) return legacyConfigPath;
	return undefined;
}

function normalizeUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function parseEnvValue(raw: string): string {
	const trimmed = raw.trim();
	const quote = trimmed[0];
	if (quote === '"' || quote === "'") {
		const end = trimmed.lastIndexOf(quote);
		return trimmed.slice(1, end > 0 ? end : undefined);
	}
	return trimmed.replace(/\s+#.*$/, "").trim();
}

function loadEnvFile(): void {
	const envPath = path.resolve(process.cwd(), ".env");
	if (!fs.existsSync(envPath)) return;

	const content = fs.readFileSync(envPath, "utf8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const entry = trimmed.startsWith("export ")
			? trimmed.slice("export ".length).trim()
			: trimmed;
		const eqIndex = entry.indexOf("=");
		if (eqIndex === -1) continue;
		const key = entry.slice(0, eqIndex).trim();
		const value = parseEnvValue(entry.slice(eqIndex + 1));
		if (!process.env[key]) {
			process.env[key] = value;
		}
	}
}

export function readAuthConfig(): AuthConfig {
	loadEnvFile();

	const envToken =
		process.env.DOKPLOY_API_KEY ?? process.env.DOKPLOY_AUTH_TOKEN;
	const envUrl = process.env.DOKPLOY_URL;

	if (envToken && envUrl) {
		return { token: envToken, url: normalizeUrl(envUrl) };
	}

	const readableConfigPath = getReadableConfigPath();

	if (!readableConfigPath) {
		throw new CliError(
			"AUTH_CONFIG_MISSING",
			"No configuration found. Please run 'dokploy auth' first or set DOKPLOY_URL and DOKPLOY_API_KEY (or DOKPLOY_AUTH_TOKEN) environment variables.",
		);
	}

	const config = JSON.parse(fs.readFileSync(readableConfigPath, "utf8"));
	const { token, url } = config;

	if (!url || !token) {
		throw new CliError(
			"AUTH_CONFIG_INCOMPLETE",
			"Incomplete auth config. Run 'dokploy auth' or set environment variables.",
		);
	}

	return { token, url: normalizeUrl(url) };
}

export function saveAuthConfig(url: string, token: string): void {
	const configPath = getAuthConfigPath();
	const existing = fs.existsSync(configPath)
		? JSON.parse(fs.readFileSync(configPath, "utf8"))
		: {};
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(
		configPath,
		JSON.stringify({ ...existing, url: normalizeUrl(url), token }, null, 2),
		{ mode: 0o600 },
	);
	fs.chmodSync(configPath, 0o600);
}

function assertString(value: unknown, name: string): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw new Error(`Missing ${name} in agentDeployPolicy config.`);
}

function normalizeDomainSuffix(value: unknown, name: string): string {
	const suffix = assertString(value, name).toLowerCase();
	if (suffix.startsWith("*.")) return suffix.slice(1);
	return suffix.startsWith(".") ? suffix : `.${suffix}`;
}

function readDomainSuffixes(
	value: unknown,
	name: string,
): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.map((suffix) => normalizeDomainSuffix(suffix, name));
}

export function readAgentDeployPolicyConfig(): AgentDeployPolicyConfig {
	loadEnvFile();
	const readableConfigPath = getReadableConfigPath();
	if (!readableConfigPath) {
		throw new Error(
			"No Dokploy config file found. Configure agentDeployPolicy in the Dokploy config file.",
		);
	}

	const config = JSON.parse(fs.readFileSync(readableConfigPath, "utf8"));
	const policy = config.agentDeployPolicy;
	if (!policy || typeof policy !== "object") {
		throw new Error(
			`Missing agentDeployPolicy in ${readableConfigPath}. Run dokploy-agent agent-safety deploy-policy --help for expected fields.`,
		);
	}

	const allowAnyServer = policy.servers === "*";
	const servers = Array.isArray(policy.servers)
		? policy.servers.map((server: Record<string, unknown>) => ({
				serverId: assertString(server.serverId, "servers[].serverId"),
				name:
					typeof server.name === "string" && server.name.trim()
						? server.name.trim()
						: undefined,
				hint:
					typeof server.hint === "string" && server.hint.trim()
						? server.hint.trim()
						: undefined,
				domainSuffixes: readDomainSuffixes(
					server.domainSuffixes,
					"servers[].domainSuffixes[]",
				),
			}))
		: [];
	if (!allowAnyServer && servers.length === 0) {
		throw new Error(
			'agentDeployPolicy.servers must be "*" or include at least one server.',
		);
	}

	const domainSuffixes =
		readDomainSuffixes(policy.domainSuffixes, "domainSuffixes[]") ?? [];
	if (domainSuffixes.length === 0) {
		throw new Error(
			"agentDeployPolicy.domainSuffixes must include at least one suffix.",
		);
	}

	const domainNameSuffix =
		typeof policy.domainNameSuffix === "string" &&
		policy.domainNameSuffix.trim()
			? policy.domainNameSuffix.trim()
			: undefined;

	const expandedApplicationIds = Array.isArray(policy.expandedApplicationIds)
		? policy.expandedApplicationIds.map((applicationId: unknown) =>
				assertString(applicationId, "expandedApplicationIds[]"),
			)
		: [];
	const expandedApplicationNames = Array.isArray(
		policy.expandedApplicationNames,
	)
		? policy.expandedApplicationNames.map((applicationName: unknown) =>
				assertString(applicationName, "expandedApplicationNames[]"),
			)
		: [];
	const expandedProjects = Array.isArray(policy.expandedProjects)
		? policy.expandedProjects.map(
				(project: Record<string, unknown>, index: number) =>
					parseExpandedProject(project, `expandedProjects[${index}]`),
			)
		: [];

	const rawProjects = Array.isArray(policy.projects)
		? policy.projects
		: [
				{
					projectName: policy.projectName,
					projectId: policy.projectId,
					environmentName: policy.environmentName,
					environmentId: policy.environmentId,
				},
			];
	const projects = rawProjects.map((project: Record<string, unknown>) => ({
		projectName: assertString(project.projectName, "projects[].projectName"),
		projectId:
			typeof project.projectId === "string" && project.projectId.trim()
				? project.projectId
				: undefined,
		environmentName: assertString(
			project.environmentName,
			"projects[].environmentName",
		),
		environmentId: assertString(
			project.environmentId,
			"projects[].environmentId",
		),
	}));
	if (projects.length === 0) {
		throw new Error(
			"agentDeployPolicy.projects must include at least one project.",
		);
	}

	return {
		projects,
		servers,
		allowAnyServer,
		domainSuffixes,
		domainNameSuffix,
		expandedProjects,
		expandedApplicationIds,
		expandedApplicationNames,
	};
}

function parseOptionalStringList(
	value: unknown,
	name: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(`Missing ${name} in agentDeployPolicy config.`);
	}
	return value.map((entry) => assertString(entry, `${name}[]`));
}

function parseExpandedProject(
	project: Record<string, unknown>,
	pathLabel: string,
): ExpandedProjectConfig {
	const applicationNames = parseOptionalStringList(
		project.applicationNames,
		`${pathLabel}.applicationNames`,
	);
	const environmentNames = parseOptionalStringList(
		project.environmentNames,
		`${pathLabel}.environmentNames`,
	);
	return {
		projectName: assertString(project.projectName, `${pathLabel}.projectName`),
		projectId:
			typeof project.projectId === "string" && project.projectId.trim()
				? project.projectId.trim()
				: undefined,
		environmentNames,
		applicationNames,
	};
}

function normalizeComparableName(
	value: string | undefined,
): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed.toLowerCase() : undefined;
}

function applicationCandidateNames(
	application: ExpandedApplicationCandidate,
): string[] {
	return [application.name, application.appName]
		.map((name) => normalizeComparableName(name))
		.filter((name): name is string => Boolean(name));
}

function expandedProjectMatches(
	project: ExpandedProjectConfig,
	application: ExpandedApplicationCandidate,
): boolean {
	const projectMatches = project.projectId
		? application.projectId === project.projectId
		: normalizeComparableName(application.projectName) ===
			normalizeComparableName(project.projectName);
	if (!projectMatches) return false;

	if (project.environmentNames !== undefined) {
		if (project.environmentNames.length === 0) return false;
		const environmentName = normalizeComparableName(
			application.environmentName,
		);
		if (!environmentName) return false;
		const allowedEnvironments = new Set(
			project.environmentNames
				.map((name) => normalizeComparableName(name))
				.filter((name): name is string => Boolean(name)),
		);
		if (!allowedEnvironments.has(environmentName)) return false;
	}

	if (project.applicationNames === undefined) return true;
	if (project.applicationNames.length === 0) return false;

	const allowedNames = new Set(
		project.applicationNames
			.map((name) => normalizeComparableName(name))
			.filter((name): name is string => Boolean(name)),
	);
	return applicationCandidateNames(application).some((name) =>
		allowedNames.has(name),
	);
}

function legacyExpandedNameMatches(
	policy: AgentDeployPolicyConfig,
	application: ExpandedApplicationCandidate,
): boolean {
	if (policy.expandedApplicationNames.length === 0) return false;
	const allowedNames = new Set(
		policy.expandedApplicationNames
			.map((name) => normalizeComparableName(name))
			.filter((name): name is string => Boolean(name)),
	);
	return applicationCandidateNames(application).some((name) =>
		allowedNames.has(name),
	);
}

/** true when application is on the expanded allowlist (ids, projects, or legacy names) */
export function isApplicationExpandedAllowed(
	policy: AgentDeployPolicyConfig,
	application: ExpandedApplicationCandidate,
): boolean {
	if (
		application.applicationId &&
		policy.expandedApplicationIds.includes(application.applicationId)
	) {
		return true;
	}
	if (
		policy.expandedProjects.some((project) =>
			expandedProjectMatches(project, application),
		)
	) {
		return true;
	}
	return legacyExpandedNameMatches(policy, application);
}

export function hasExpandedApplicationAllowlist(
	policy: AgentDeployPolicyConfig,
): boolean {
	return (
		policy.expandedApplicationIds.length > 0 ||
		policy.expandedProjects.length > 0 ||
		policy.expandedApplicationNames.length > 0
	);
}

export function expandedApplicationAllowlistReason(): string {
	return "expandedApplicationIds, expandedProjects, or expandedApplicationNames";
}

export function applicationCandidateFromService(
	service: Record<string, unknown> | null | undefined,
	applicationId?: string,
): ExpandedApplicationCandidate {
	const environment =
		service?.environment && typeof service.environment === "object"
			? (service.environment as Record<string, unknown>)
			: undefined;
	const project =
		(environment?.project && typeof environment.project === "object"
			? (environment.project as Record<string, unknown>)
			: undefined) ??
		(service?.project && typeof service.project === "object"
			? (service.project as Record<string, unknown>)
			: undefined);
	return {
		applicationId:
			applicationId ??
			(typeof service?.applicationId === "string"
				? service.applicationId
				: undefined),
		name: typeof service?.name === "string" ? service.name : undefined,
		appName: typeof service?.appName === "string" ? service.appName : undefined,
		projectName: typeof project?.name === "string" ? project.name : undefined,
		projectId:
			typeof project?.projectId === "string" ? project.projectId : undefined,
		environmentName:
			typeof environment?.name === "string" ? environment.name : undefined,
		environmentId:
			typeof service?.environmentId === "string"
				? service.environmentId
				: typeof environment?.environmentId === "string"
					? environment.environmentId
					: undefined,
	};
}

export function createClient(): AxiosInstance {
	const auth = readAuthConfig();
	return axios.create({
		baseURL: `${auth.url}/api`,
		headers: {
			"x-api-key": auth.token,
			"Content-Type": "application/json",
		},
	});
}

export async function apiPost(
	endpoint: string,
	data?: Record<string, unknown>,
) {
	const client = createClient();
	const response = await client.post(
		`/trpc/${endpoint}`,
		data ? { json: data } : undefined,
	);
	return response.data?.result?.data?.json ?? response.data;
}

export function buildGetInputQuery(params?: Record<string, unknown>): string {
	if (!params || Object.keys(params).length === 0) return "";
	return `?input=${encodeURIComponent(JSON.stringify({ json: params }))}`;
}

function formatErrorBody(data: unknown): string {
	const sanitized =
		typeof data === "string" ? redactString(data) : sanitizeForAgent(data);
	const body =
		typeof sanitized === "string"
			? sanitized
			: (JSON.stringify(sanitized, null, 2) ?? String(sanitized));
	if (body.length <= MAX_ERROR_BODY_CHARS) return body;
	return `${body.slice(0, MAX_ERROR_BODY_CHARS)}\n[truncated ${body.length - MAX_ERROR_BODY_CHARS} chars]`;
}

export function formatCliError(err: unknown): string {
	if (axios.isAxiosError(err)) {
		const lines = [err.message];
		if (err.response?.data !== undefined) {
			lines.push(`Response body:\n${formatErrorBody(err.response.data)}`);
		}
		return lines.join("\n");
	}

	if (err instanceof Error) return err.message;
	return String(err);
}

export async function apiGet(
	endpoint: string,
	params?: Record<string, unknown>,
) {
	const client = createClient();
	const response = await client.get(
		`/trpc/${endpoint}${buildGetInputQuery(params)}`,
	);
	return response.data?.result?.data?.json ?? response.data;
}
