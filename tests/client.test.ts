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
	const originalCwd = process.cwd();

	beforeEach(() => {
		delete process.env.DOKPLOY_URL;
		delete process.env.DOKPLOY_API_KEY;
		delete process.env.DOKPLOY_AUTH_TOKEN;
		delete process.env.DOKPLOY_CONFIG_PATH;
		delete process.env.XDG_CONFIG_HOME;
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		process.chdir(originalCwd);
		vi.restoreAllMocks();
	});

	it("should read from DOKPLOY_API_KEY env var", async () => {
		process.env.DOKPLOY_URL = "https://test.dokploy.com/";
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

	it("should read exported values from .env", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-env-"));
		process.chdir(tempDir);
		process.env.XDG_CONFIG_HOME = path.join(tempDir, "config");
		fs.writeFileSync(
			path.join(tempDir, ".env"),
			[
				'export DOKPLOY_URL="https://env-file.dokploy.com" # panel url',
				"export DOKPLOY_API_KEY='env-file-key#kept' # token comment",
			].join("\n"),
		);

		const { readAuthConfig } = await import("../src/client.js");
		const config = readAuthConfig();

		expect(config).toEqual({
			url: "https://env-file.dokploy.com",
			token: "env-file-key#kept",
		});
	});

	it("should prefer shell env vars over .env values", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-env-"));
		process.chdir(tempDir);
		process.env.DOKPLOY_URL = "https://shell.dokploy.com";
		process.env.DOKPLOY_API_KEY = "shell-key";
		fs.writeFileSync(
			path.join(tempDir, ".env"),
			[
				"DOKPLOY_URL=https://env-file.dokploy.com",
				"DOKPLOY_API_KEY=env-file-key",
			].join("\n"),
		);

		const { readAuthConfig } = await import("../src/client.js");
		const config = readAuthConfig();

		expect(config).toEqual({
			url: "https://shell.dokploy.com",
			token: "shell-key",
		});
	});

	it("should throw a typed error when config is missing", async () => {
		process.env.XDG_CONFIG_HOME = fs.mkdtempSync(
			path.join(os.tmpdir(), "dokploy-config-"),
		);

		const { readAuthConfig } = await import("../src/client.js");

		let error: unknown;
		try {
			readAuthConfig();
		} catch (caught) {
			error = caught;
		}

		expect(error).toMatchObject({
			code: "AUTH_CONFIG_MISSING",
			exitCode: 1,
		});
		expect(String(error)).toContain("DOKPLOY_API_KEY");
		expect(String(error)).toContain("DOKPLOY_AUTH_TOKEN");
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

describe("readAgentDeployPolicyConfig", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	function writePolicyConfig(policy: Record<string, unknown>) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-config-"));
		const customPath = path.join(tempDir, "custom.json");
		process.env.DOKPLOY_CONFIG_PATH = customPath;
		fs.writeFileSync(
			customPath,
			JSON.stringify({
				url: "https://test.dokploy.com",
				token: "test-token",
				agentDeployPolicy: policy,
			}),
		);
	}

	const basePolicy = {
		projects: [
			{
				projectName: "agent_sandbox",
				environmentName: "production",
				environmentId: "env-1",
			},
		],
		servers: [{ serverId: "server-1" }],
		domainSuffixes: [".apps.example.com"],
	};

	it("should allow every server with a wildcard", async () => {
		writePolicyConfig({ ...basePolicy, servers: "*" });

		const { readAgentDeployPolicyConfig } = await import("../src/client.js");

		expect(readAgentDeployPolicyConfig()).toMatchObject({
			servers: [],
			allowAnyServer: true,
		});
	});

	it("should default domain name suffix to no requirement", async () => {
		writePolicyConfig(basePolicy);

		const { readAgentDeployPolicyConfig } = await import("../src/client.js");

		expect(readAgentDeployPolicyConfig()).toMatchObject({
			domainSuffixes: [".apps.example.com"],
			domainNameSuffix: undefined,
		});
	});

	it("should read optional domain name suffix", async () => {
		writePolicyConfig({ ...basePolicy, domainNameSuffix: "-agent" });

		const { readAgentDeployPolicyConfig } = await import("../src/client.js");

		expect(readAgentDeployPolicyConfig()).toMatchObject({
			domainNameSuffix: "-agent",
			expandedProjects: [],
			expandedApplicationIds: [],
			expandedApplicationNames: [],
		});
	});

	it("should read expanded application allowlist", async () => {
		writePolicyConfig({
			...basePolicy,
			expandedApplicationIds: ["app-1", " app-2 "],
		});

		const { readAgentDeployPolicyConfig } = await import("../src/client.js");

		expect(readAgentDeployPolicyConfig().expandedApplicationIds).toEqual([
			"app-1",
			"app-2",
		]);
	});

	it("should read expanded application name allowlist", async () => {
		writePolicyConfig({
			...basePolicy,
			expandedApplicationNames: ["my-app", " future-app "],
		});

		const { readAgentDeployPolicyConfig } = await import("../src/client.js");

		expect(readAgentDeployPolicyConfig().expandedApplicationNames).toEqual([
			"my-app",
			"future-app",
		]);
	});

	it("should read expanded projects allowlist", async () => {
		writePolicyConfig({
			...basePolicy,
			expandedProjects: [
				{ projectName: " my-app " },
				{
					projectName: "storefront",
					projectId: "proj-storefront",
					environmentNames: [" Production "],
					applicationNames: [" catalog ", "web"],
				},
				{
					projectName: "empty-apps",
					applicationNames: [],
				},
			],
		});

		const { readAgentDeployPolicyConfig } = await import("../src/client.js");

		expect(readAgentDeployPolicyConfig().expandedProjects).toEqual([
			{
				projectName: "my-app",
				projectId: undefined,
				environmentNames: undefined,
				applicationNames: undefined,
			},
			{
				projectName: "storefront",
				projectId: "proj-storefront",
				environmentNames: ["Production"],
				applicationNames: ["catalog", "web"],
			},
			{
				projectName: "empty-apps",
				projectId: undefined,
				environmentNames: undefined,
				applicationNames: [],
			},
		]);
	});

	it("matches expanded projects by whole project or scoped apps", async () => {
		const { isApplicationExpandedAllowed } = await import("../src/client.js");
		const policy = {
			projects: basePolicy.projects,
			servers: basePolicy.servers,
			allowAnyServer: false,
			domainSuffixes: [".apps.example.com"],
			expandedProjects: [
				{ projectName: "toolbox" },
				{
					projectName: "storefront",
					applicationNames: ["catalog"],
				},
				{
					projectName: "agent_sandbox",
					projectId: "proj-agent",
					environmentNames: ["production"],
					applicationNames: ["journal"],
				},
			],
			expandedApplicationIds: [],
			expandedApplicationNames: [],
		};

		expect(
			isApplicationExpandedAllowed(policy, {
				applicationId: "api-1",
				name: "api",
				projectName: "toolbox",
				environmentName: "production",
			}),
		).toBe(true);
		expect(
			isApplicationExpandedAllowed(policy, {
				applicationId: "catalog-1",
				name: "catalog",
				projectName: "storefront",
			}),
		).toBe(true);
		expect(
			isApplicationExpandedAllowed(policy, {
				applicationId: "other-1",
				name: "other",
				projectName: "storefront",
			}),
		).toBe(false);
		expect(
			isApplicationExpandedAllowed(policy, {
				applicationId: "web-1",
				name: "web",
				projectName: "unrelated",
			}),
		).toBe(false);
		expect(
			isApplicationExpandedAllowed(policy, {
				applicationId: "journal-1",
				name: "journal",
				projectName: "renamed-agent",
				projectId: "proj-agent",
				environmentName: "production",
			}),
		).toBe(true);
		expect(
			isApplicationExpandedAllowed(policy, {
				applicationId: "journal-2",
				name: "journal",
				projectName: "renamed-agent",
				projectId: "proj-agent",
				environmentName: "staging",
			}),
		).toBe(false);
	});

	it("should normalize wildcard and bare domain suffixes", async () => {
		writePolicyConfig({
			...basePolicy,
			domainSuffixes: ["*.agent.srv1.example.net"],
			servers: [
				{
					serverId: "server-1",
					domainSuffixes: ["srv1.example.net"],
				},
			],
		});

		const { readAgentDeployPolicyConfig } = await import("../src/client.js");

		expect(readAgentDeployPolicyConfig()).toMatchObject({
			domainSuffixes: [".agent.srv1.example.net"],
			servers: [
				{
					serverId: "server-1",
					domainSuffixes: [".srv1.example.net"],
				},
			],
		});
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
		saveAuthConfig("https://test.dokploy.com/", "test-token");

		const configPath = getAuthConfigPath();
		expect(configPath).toBe(path.join(configHome, "dokploy", "config.json"));
		expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
			url: "https://test.dokploy.com",
			token: "test-token",
		});
		expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
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
