import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import axios, { type AxiosInstance } from "axios";
import chalk from "chalk";
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
}

export interface AgentDeployProjectConfig {
	projectName: string;
	projectId?: string;
	environmentName: string;
	environmentId: string;
}

export interface AgentDeployPolicyConfig {
	projects: AgentDeployProjectConfig[];
	servers: AgentDeployServerConfig[];
	domainSuffixes: string[];
	domainNameSuffix?: string;
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

function loadEnvFile(): void {
	const envPath = path.resolve(process.cwd(), ".env");
	if (!fs.existsSync(envPath)) return;

	const content = fs.readFileSync(envPath, "utf8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		const value = trimmed
			.slice(eqIndex + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
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
		return { token: envToken, url: envUrl };
	}

	const readableConfigPath = getReadableConfigPath();

	if (!readableConfigPath) {
		console.error(
			chalk.red(
				"No configuration found. Please run 'dokploy auth' first or set DOKPLOY_URL and DOKPLOY_API_KEY (or DOKPLOY_AUTH_TOKEN) environment variables.",
			),
		);
		process.exit(1);
	}

	const config = JSON.parse(fs.readFileSync(readableConfigPath, "utf8"));
	const { token, url } = config;

	if (!url || !token) {
		console.error(
			chalk.red(
				"Incomplete auth config. Run 'dokploy auth' or set environment variables.",
			),
		);
		process.exit(1);
	}

	return { token, url };
}

export function saveAuthConfig(url: string, token: string): void {
	const configPath = getAuthConfigPath();
	const existing = fs.existsSync(configPath)
		? JSON.parse(fs.readFileSync(configPath, "utf8"))
		: {};
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(
		configPath,
		JSON.stringify({ ...existing, url, token }, null, 2),
	);
}

function assertString(value: unknown, name: string): string {
	if (typeof value === "string" && value.trim()) return value;
	throw new Error(`Missing ${name} in agentDeployPolicy config.`);
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

	const servers = Array.isArray(policy.servers)
		? policy.servers.map((server: Record<string, unknown>) => ({
				serverId: assertString(server.serverId, "servers[].serverId"),
				name:
					typeof server.name === "string" && server.name.trim()
						? server.name
						: undefined,
				hint:
					typeof server.hint === "string" && server.hint.trim()
						? server.hint
						: undefined,
			}))
		: [];
	if (servers.length === 0) {
		throw new Error(
			"agentDeployPolicy.servers must include at least one server.",
		);
	}

	const domainSuffixes = Array.isArray(policy.domainSuffixes)
		? policy.domainSuffixes.map((suffix: unknown) =>
				assertString(suffix, "domainSuffixes[]"),
			)
		: [];
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
		domainSuffixes,
		domainNameSuffix,
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
