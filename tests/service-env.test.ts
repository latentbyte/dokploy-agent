import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../src/client.js";
import {
	annotateEnvironmentVariable,
	appendEnvironmentVariable,
	registerServiceEnvCommands,
	setEnvironmentVariable,
	unsetEnvironmentVariable,
} from "../src/commands/service-env.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("service environment mutations", () => {
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

	it("removes every assignment of a name and keeps other bytes", () => {
		expect(
			unsetEnvironmentVariable(
				"# db\r\nFOO=one\r\nBAR=keep\r\nexport FOO=two",
				"FOO",
			),
		).toBe("# db\r\nBAR=keep\r\n");
		expect(() => unsetEnvironmentVariable("BAR=keep\n", "FOO")).toThrow(
			"does not exist",
		);
		expect(unsetEnvironmentVariable("FOOBAR=1\nFOO=2\n", "FOO")).toBe(
			"FOOBAR=1\n",
		);
	});

	it("treats a multi-line quoted value as one assignment", () => {
		const document = 'A=1\nKEY="line1\nB=evil\nline3"\nC=3\n';
		expect(unsetEnvironmentVariable(document, "KEY")).toBe("A=1\nC=3\n");
		expect(setEnvironmentVariable(document, "KEY", "x")).toBe(
			'A=1\nKEY="x"\nC=3\n',
		);
		expect(() => unsetEnvironmentVariable(document, "B")).toThrow(
			"does not exist",
		);
		expect(unsetEnvironmentVariable("K='a\nb' # note\r\nZ=1", "K")).toBe("Z=1");
	});

	it("keeps CRLF line endings when replacing a value", () => {
		expect(setEnvironmentVariable("FOO=old\r\nBAR=1\r\n", "FOO", "new")).toBe(
			'FOO="new"\r\nBAR=1\r\n',
		);
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
		registerServiceEnvCommands(program, { agentSafe: false });

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
		registerServiceEnvCommands(program, { agentSafe: false });

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
		expect(output).toContain('"preview": "valu*** (15 chars)"');
		expect(output).toContain('"preview": "*** (4 chars)"');
		expect(output).not.toContain("valuable-secret");
		expect(output).not.toContain("3000");
	});

	it("allows environment changes on any server with wildcard policy", async () => {
		const program = new Command();
		program.exitOverride();
		program.command("application");
		vi.spyOn(client, "apiGet").mockResolvedValue({
			env: "SECRET=old-value\n",
			buildArgs: null,
			buildSecrets: null,
			createEnvFile: false,
			environmentId: "allowed-env",
			environment: { project: { name: "allowed-project" } },
			serverId: "any-server",
		});
		vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
			projects: [
				{
					projectName: "allowed-project",
					environmentName: "production",
					environmentId: "allowed-env",
				},
			],
			servers: [],
			allowAnyServer: true,
			domainSuffixes: [".example.com"],
			expandedProjects: [],
			expandedApplicationIds: [],
			expandedApplicationNames: [],
		});
		const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue({ ok: true });
		registerServiceEnvCommands(program, { agentSafe: true });

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
		]);

		expect(postSpy).toHaveBeenCalledOnce();
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
			expandedProjects: [],
			expandedApplicationIds: [],
			expandedApplicationNames: [],
		});
		const postSpy = vi.spyOn(client, "apiPost");
		registerServiceEnvCommands(program, { agentSafe: true });

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
		).rejects.toMatchObject({
			code: "AGENT_POLICY_BLOCKED",
			exitCode: 2,
			message: expect.stringContaining("rejects application app-1"),
		});
		expect(postSpy).not.toHaveBeenCalled();
	});

	it("writes compose env alone and keeps compose in the deploy project", async () => {
		const program = new Command();
		program.exitOverride();
		program.command("compose");
		vi.spyOn(client, "apiGet").mockImplementation(async (_endpoint, opts) => ({
			env: "SECRET=old-value\nOLD=1\n",
			environmentId: opts?.composeId === "compose-ok" ? "allowed-env" : "x",
			environment: { project: { name: "allowed-project" } },
		}));
		vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
			projects: [
				{
					projectName: "allowed-project",
					environmentName: "production",
					environmentId: "allowed-env",
				},
			],
			servers: [],
			allowAnyServer: true,
			domainSuffixes: [".example.com"],
			expandedProjects: [{ projectName: "allowed-project" }],
			expandedApplicationIds: [],
			expandedApplicationNames: [],
		});
		const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue(true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		registerServiceEnvCommands(program, { agentSafe: true });
		const args = (composeId: string) => [
			"node",
			"cli",
			"compose",
			"env",
			"unset",
			"--composeId",
			composeId,
			"--name",
			"OLD",
			"--json",
		];

		await program.parseAsync(args("compose-ok"));
		expect(postSpy).toHaveBeenCalledWith("compose.saveEnvironment", {
			composeId: "compose-ok",
			env: "SECRET=old-value\n",
		});
		expect(logSpy.mock.calls.flat().join("\n")).not.toContain("old-value");

		await expect(
			program.parseAsync(args("compose-other")),
		).rejects.toMatchObject({
			code: "AGENT_POLICY_BLOCKED",
			message: expect.stringContaining("rejects compose compose-other"),
		});
		expect(postSpy).toHaveBeenCalledOnce();
	});

	it("allows expanded projects for environment set", async () => {
		const program = new Command();
		program.exitOverride();
		program.command("application");
		vi.spyOn(client, "apiGet").mockResolvedValue({
			name: "catalog",
			appName: "storefront-catalog-x1y2z3",
			env: 'APP_BASE_URL="https://old.example"\nSECRET=old-value\n',
			buildArgs: null,
			buildSecrets: null,
			createEnvFile: false,
			environmentId: "other-env",
			environment: { name: "production", project: { name: "storefront" } },
		});
		vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
			projects: [
				{
					projectName: "allowed-project",
					environmentName: "production",
					environmentId: "allowed-env",
				},
			],
			servers: [],
			allowAnyServer: true,
			domainSuffixes: [".example.com"],
			expandedProjects: [
				{ projectName: "storefront", applicationNames: ["catalog"] },
			],
			expandedApplicationIds: [],
			expandedApplicationNames: [],
		});
		const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue({ ok: true });
		registerServiceEnvCommands(program, { agentSafe: true });

		await program.parseAsync([
			"node",
			"cli",
			"application",
			"env",
			"set",
			"--applicationId",
			"app-1",
			"--name",
			"APP_BASE_URL",
			"--value",
			"https://new.example",
			"--json",
		]);

		expect(postSpy).toHaveBeenCalledWith("application.saveEnvironment", {
			applicationId: "app-1",
			env: 'APP_BASE_URL="https://new.example"\nSECRET=old-value\n',
			buildArgs: null,
			buildSecrets: null,
			createEnvFile: false,
		});
	});
});
