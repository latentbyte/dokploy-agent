import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function decodeInput(query: string): unknown {
	const input = new URLSearchParams(query.slice(1)).get("input");
	if (!input) return undefined;
	return JSON.parse(input);
}

describe("readAuthConfig", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		delete process.env.DOKPLOY_URL;
		delete process.env.DOKPLOY_API_KEY;
		delete process.env.DOKPLOY_AUTH_TOKEN;
		delete process.env.DOKPLOY_CONFIG_PATH;
		delete process.env.XDG_CONFIG_HOME;
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
	});

	it("should read from DOKPLOY_API_KEY env var", async () => {
		process.env.DOKPLOY_URL = "https://test.dokploy.com";
		process.env.DOKPLOY_API_KEY = "test-key-123";

		const { readAuthConfig } = await import("../src/client.js");
		const config = readAuthConfig();

		expect(config.url).toBe("https://test.dokploy.com");
		expect(config.token).toBe("test-key-123");
	});

	it("should read from DOKPLOY_AUTH_TOKEN env var as fallback", async () => {
		process.env.DOKPLOY_URL = "https://test.dokploy.com";
		process.env.DOKPLOY_AUTH_TOKEN = "auth-token-456";

		const { readAuthConfig } = await import("../src/client.js");
		const config = readAuthConfig();

		expect(config.url).toBe("https://test.dokploy.com");
		expect(config.token).toBe("auth-token-456");
	});

	it("should prefer DOKPLOY_API_KEY over DOKPLOY_AUTH_TOKEN", async () => {
		process.env.DOKPLOY_URL = "https://test.dokploy.com";
		process.env.DOKPLOY_API_KEY = "api-key";
		process.env.DOKPLOY_AUTH_TOKEN = "auth-token";

		const { readAuthConfig } = await import("../src/client.js");
		const config = readAuthConfig();

		expect(config.token).toBe("api-key");
	});
});

describe("apiGet", () => {
	it("should encode GET input with tRPC json wrapper", async () => {
		const { buildGetInputQuery } = await import("../src/client.js");
		const query = buildGetInputQuery({ applicationId: "app-1" });

		expect(decodeInput(query)).toEqual({
			json: { applicationId: "app-1" },
		});
	});

	it("should omit GET input when params are empty", async () => {
		const { buildGetInputQuery } = await import("../src/client.js");

		expect(buildGetInputQuery()).toBe("");
		expect(buildGetInputQuery({})).toBe("");
	});
});

describe("formatCliError", () => {
	it("should include redacted HTTP response body", async () => {
		const { formatCliError } = await import("../src/client.js");
		const output = formatCliError({
			isAxiosError: true,
			message: "Request failed with status code 400",
			response: {
				data: {
					message: "Invalid input",
					token: "secret-token-value",
				},
			},
		});

		expect(output).toContain("Request failed with status code 400");
		expect(output).toContain("Response body:");
		expect(output).toContain("Invalid input");
		expect(output).toContain("secr***");
		expect(output).not.toContain("secret-token-value");
	});
});

describe("saveAuthConfig", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("should write config under XDG config home", async () => {
		const configHome = fs.mkdtempSync(
			path.join(os.tmpdir(), "dokploy-config-"),
		);
		process.env.XDG_CONFIG_HOME = configHome;

		const { getAuthConfigPath, saveAuthConfig } = await import(
			"../src/client.js"
		);
		saveAuthConfig("https://test.dokploy.com", "test-token");

		const configPath = getAuthConfigPath();
		expect(configPath).toBe(path.join(configHome, "dokploy", "config.json"));
		expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
			url: "https://test.dokploy.com",
			token: "test-token",
		});
	});

	it("should preserve agent deploy policy when saving auth", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-config-"));
		const customPath = path.join(tempDir, "custom.json");
		process.env.DOKPLOY_CONFIG_PATH = customPath;
		fs.writeFileSync(
			customPath,
			JSON.stringify({
				agentDeployPolicy: {
					projects: [
						{
							projectName: "agent_sandbox",
							environmentName: "production",
							environmentId: "env-1",
						},
					],
					servers: [{ serverId: "server-1" }],
					domainSuffixes: [".apps.example.com"],
				},
			}),
		);

		const { getAuthConfigPath, saveAuthConfig } = await import(
			"../src/client.js"
		);
		saveAuthConfig("https://test.dokploy.com", "test-token");

		expect(getAuthConfigPath()).toBe(customPath);
		expect(JSON.parse(fs.readFileSync(customPath, "utf8"))).toMatchObject({
			url: "https://test.dokploy.com",
			token: "test-token",
			agentDeployPolicy: {
				projects: [
					{
						projectName: "agent_sandbox",
						environmentId: "env-1",
					},
				],
			},
		});
	});

	it("should allow overriding config path", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-config-"));
		const customPath = path.join(tempDir, "custom.json");
		process.env.DOKPLOY_CONFIG_PATH = customPath;

		const { getAuthConfigPath, saveAuthConfig } = await import(
			"../src/client.js"
		);
		saveAuthConfig("https://test.dokploy.com", "test-token");

		expect(getAuthConfigPath()).toBe(customPath);
		expect(fs.existsSync(customPath)).toBe(true);
	});
});
