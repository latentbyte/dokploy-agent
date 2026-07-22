import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../src/client.js";
import {
	annotateEnvironmentVariable,
	appendEnvironmentVariable,
	registerApplicationEnvCommands,
} from "../src/commands/application-env.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("application environment mutations", () => {
	it("appends a quoted value and comment without changing existing bytes", () => {
		const existing = "# keep this\r\nSECRET=old-value\r\n";
		expect(
			appendEnvironmentVariable(
				existing,
				"NEW_KEY",
				"value with spaces",
				"new setting",
			),
		).toBe(
			'# keep this\r\nSECRET=old-value\r\n# new setting\r\nNEW_KEY="value with spaces"\r\n',
		);
	});

	it("rejects duplicate variable names", () => {
		expect(() =>
			appendEnvironmentVariable("FOO=secret\n", "FOO", "new"),
		).toThrow("already exists");
	});

	it("prefixes every comment line to prevent assignment injection", () => {
		expect(
			annotateEnvironmentVariable(
				"\n\nFOO=secret\n",
				"FOO",
				"note\nINJECT=value",
			),
		).toBe("\n\n# note\n# INJECT=value\nFOO=secret\n");
	});

	it("fails closed when annotation target is duplicated", () => {
		expect(() =>
			annotateEnvironmentVariable("FOO=one\nFOO=two\n", "FOO", "note"),
		).toThrow("duplicated");
	});

	it("preserves companion environment fields when adding", async () => {
		const program = new Command();
		program.exitOverride();
		program.command("application");
		const getSpy = vi.spyOn(client, "apiGet").mockResolvedValue({
			env: "SECRET=old-value\n",
			buildArgs: "BUILD_MODE=release",
			buildSecrets: "TOKEN=build-secret",
			createEnvFile: true,
		});
		const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue({ ok: true });
		vi.spyOn(console, "log").mockImplementation(() => {});
		registerApplicationEnvCommands(program, { agentSafe: false });

		await program.parseAsync([
			"node",
			"cli",
			"application",
			"env",
			"add",
			"--applicationId",
			"app-1",
			"--name",
			"NEW_KEY",
			"--value",
			"new-value",
			"--comment",
			"added safely",
			"--json",
		]);

		expect(getSpy).toHaveBeenCalledWith("application.one", {
			applicationId: "app-1",
		});
		expect(postSpy).toHaveBeenCalledWith("application.saveEnvironment", {
			applicationId: "app-1",
			env: 'SECRET=old-value\n# added safely\nNEW_KEY="new-value"\n',
			buildArgs: "BUILD_MODE=release",
			buildSecrets: "TOKEN=build-secret",
			createEnvFile: true,
		});
	});

	it("lists only names and masked previews", async () => {
		const program = new Command();
		program.exitOverride();
		program.command("application");
		vi.spyOn(client, "apiGet").mockResolvedValue({
			env: "FOO=valuable-secret\nPORT=3000\n",
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		registerApplicationEnvCommands(program, { agentSafe: false });

		await program.parseAsync([
			"node",
			"cli",
			"application",
			"env",
			"list",
			"--applicationId",
			"app-1",
			"--json",
		]);

		const output = logSpy.mock.calls.flat().join("\n");
		expect(output).toContain('"name": "FOO"');
		expect(output).toContain('"preview": "valu***"');
		expect(output).toContain('"preview": "***"');
		expect(output).not.toContain("valuable-secret");
		expect(output).not.toContain("3000");
	});

	it("checks agent deploy policy before saving", async () => {
		const program = new Command();
		program.exitOverride();
		program.command("application");
		vi.spyOn(client, "apiGet").mockResolvedValue({
			env: "SECRET=old-value\n",
			buildArgs: null,
			buildSecrets: null,
			createEnvFile: false,
			environmentId: "other-env",
			environment: { project: { name: "other-project" } },
		});
		vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
			projects: [
				{
					projectName: "allowed-project",
					environmentName: "production",
					environmentId: "allowed-env",
				},
			],
			servers: [{ serverId: "server-1" }],
			domainSuffixes: [".example.com"],
			expandedApplicationIds: [],
		});
		const postSpy = vi.spyOn(client, "apiPost");
		registerApplicationEnvCommands(program, { agentSafe: true });

		await expect(
			program.parseAsync([
				"node",
				"cli",
				"application",
				"env",
				"add",
				"--applicationId",
				"app-1",
				"--name",
				"NEW_KEY",
				"--value",
				"new-value",
			]),
		).rejects.toThrow("rejects application environment mutation");
		expect(postSpy).not.toHaveBeenCalled();
	});
});
