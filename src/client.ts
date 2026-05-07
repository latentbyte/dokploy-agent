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

export interface AuthConfig {
	token: string;
	url: string;
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
				"No configuration found. Please run 'dokploy auth' first or set DOKPLOY_URL and DOKPLOY_AUTH_TOKEN environment variables.",
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
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify({ url, token }, null, 2));
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
