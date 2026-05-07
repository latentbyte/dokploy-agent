import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
