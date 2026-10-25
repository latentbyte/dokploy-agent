import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as backends from "../src/agent/approval-backends.js";
import * as client from "../src/client.js";
import {
	annotateEnvironmentVariable,
	appendEnvironmentVariable,
	environmentUrlParts,
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

	it("extracts URL parts without credentials or query", () => {
		expect(
			environmentUrlParts(
				'DATABASE_URL="postgres://user:hunter2@db.example.net:5432/app?sslpassword=x"\n',
				"DATABASE_URL",
			),
		).toEqual({
			scheme: "postgres",
			host: "db.example.net",
			port: "5432",
			database: "app",
		});
		expect(
			environmentUrlParts(
				"HOOK=https://hooks.example.com/services/T0/B0/token\n",
				"HOOK",
			),
		).toEqual({
			scheme: "https",
			host: "hooks.example.com",
			port: null,
			database: null,
		});
	});

	it("rejects non-URL values without echoing them", () => {
		let error: unknown;
		try {
			environmentUrlParts("SECRET=not-a-url-hunter2\n", "SECRET");
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({ code: "INVALID_ENV_URL" });
		expect(String((error as Error).message)).not.toContain("hunter2");
		expect(() => environmentUrlParts("A=1\n", "B")).toThrow("does not exist");
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

describe("environment approval outside the deploy policy", () => {
	const policy = (approval?: client.AgentApprovalConfig) => ({
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
		approval,
	});
	const outsideApp = {
		name: "web",
		appName: "web-a1b2c3",
		env: "API_URL=https://old.example.com\nSECRET=old-value\n",
		buildArgs: null,
		buildSecrets: null,
		createEnvFile: false,
		environmentId: "other-env",
		environment: { name: "production", project: { name: "storefront" } },
	};
	const setArgs = [
		"node",
		"cli",
		"application",
		"env",
		"set",
		"--applicationId",
		"app-1",
		"--name",
		"API_URL",
		"--value",
		"https://new.example.com",
		"--json",
	];

	// records the dialog and answers with the given result
	function answerDialog(result: backends.ApprovalResult) {
		const dialogs: string[] = [];
		vi.mocked(backends.detectApprovalBackend).mockReturnValue({
			name: "macos",
			invocation: (dialog) => {
				dialogs.push(dialog.message);
				return {
					command: process.execPath,
					args: ["-e", `process.stdout.write(${JSON.stringify(result)})`],
					env: {},
					parse: (_status, stdout) => stdout as backends.ApprovalResult,
				};
			},
		});
		return dialogs;
	}

	function setup(
		records: Record<string, unknown>[],
		approval?: client.AgentApprovalConfig,
		group = "application",
	) {
		const program = new Command();
		program.exitOverride();
		program.command(group);
		const getSpy = vi.spyOn(client, "apiGet");
		for (const record of records) getSpy.mockResolvedValueOnce(record);
		vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue(
			policy(approval),
		);
		const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue(true);
		vi.spyOn(console, "log").mockImplementation(() => {});
		registerServiceEnvCommands(program, { agentSafe: true });
		return { program, postSpy, getSpy };
	}

	afterEach(() => {
		vi.mocked(backends.detectApprovalBackend).mockReset();
		vi.mocked(backends.detectApprovalBackend).mockReturnValue(undefined);
	});

	it("writes after the user approves and shows the change", async () => {
		const dialogs = answerDialog("approved");
		const { program, postSpy } = setup([outsideApp, outsideApp]);

		await program.parseAsync([
			...setArgs,
			"--reason",
			"point the app at the new API host",
		]);

		expect(postSpy).toHaveBeenCalledWith("application.saveEnvironment", {
			applicationId: "app-1",
			env: 'API_URL="https://new.example.com"\nSECRET=old-value\n',
			buildArgs: null,
			buildSecrets: null,
			createEnvFile: false,
		});
		expect(dialogs).toHaveLength(1);
		expect(dialogs[0]).toContain("application: web / web-a1b2c3 (app-1)");
		expect(dialogs[0]).toContain("project: storefront/production");
		expect(dialogs[0]).toContain("replace API_URL (current: ");
		expect(dialogs[0]).toContain('new value: "https://new.example.com"');
		expect(dialogs[0]).toContain(
			"agent's reason (unverified):\npoint the app at the new API host",
		);
		expect(dialogs[0]).not.toContain("old-value");
		expect(dialogs[0]).not.toContain("https://old.example.com");
	});

	it("writes nothing when the user denies", async () => {
		answerDialog("denied");
		const { program, postSpy } = setup([outsideApp]);

		await expect(program.parseAsync(setArgs)).rejects.toMatchObject({
			code: "AGENT_APPROVAL_DENIED",
			exitCode: 2,
		});
		expect(postSpy).not.toHaveBeenCalled();
	});

	it("aborts when the environment changed while the dialog was open", async () => {
		answerDialog("approved");
		const { program, postSpy } = setup([
			outsideApp,
			{ ...outsideApp, env: `${outsideApp.env}NEW=1\n` },
		]);

		await expect(program.parseAsync(setArgs)).rejects.toMatchObject({
			code: "AGENT_APPROVAL_STALE",
		});
		expect(postSpy).not.toHaveBeenCalled();
	});

	it("keeps the hard block when approval is disabled", async () => {
		const dialogs = answerDialog("approved");
		const { program, postSpy } = setup([outsideApp], {
			enabled: false,
			timeoutSeconds: 90,
		});

		await expect(program.parseAsync(setArgs)).rejects.toMatchObject({
			code: "AGENT_POLICY_BLOCKED",
			message: expect.stringContaining("rejects application app-1"),
		});
		expect(dialogs).toHaveLength(0);
		expect(postSpy).not.toHaveBeenCalled();
	});

	it("validates the edit before prompting", async () => {
		const dialogs = answerDialog("approved");
		const { program } = setup([outsideApp]);

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
				"SECRET",
				"--value",
				"x",
			]),
		).rejects.toThrow("already exists");
		expect(dialogs).toHaveLength(0);
	});

	it("does not prompt inside the deploy project", async () => {
		const dialogs = answerDialog("denied");
		const inside = { ...outsideApp, environmentId: "allowed-env" };
		inside.environment = {
			name: "production",
			project: { name: "allowed-project" },
		};
		const { program, postSpy } = setup([inside]);

		await program.parseAsync(setArgs);
		expect(dialogs).toHaveLength(0);
		expect(postSpy).toHaveBeenCalledOnce();
	});

	it("lists env outside the deploy policy without prompting", async () => {
		const dialogs = answerDialog("denied");
		const { program } = setup([outsideApp]);

		await program.parseAsync([
			"node",
			"cli",
			"application",
			"env",
			"list",
			"--applicationId",
			"app-1",
		]);
		expect(dialogs).toHaveLength(0);
		const output = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(output).toContain('"name":"SECRET"');
		expect(output).not.toContain("old-value");
	});

	const dbApp = {
		...outsideApp,
		env: "DATABASE_URL=postgres://app:hunter2@db.example.net:5432/app\n",
	};
	const urlArgs = [
		"node",
		"cli",
		"application",
		"env",
		"url",
		"--applicationId",
		"app-1",
		"--name",
		"DATABASE_URL",
		"--reason",
		"check which database host prod uses",
	];

	it("reads URL parts after the user approves", async () => {
		const dialogs = answerDialog("approved");
		const { program } = setup([dbApp]);

		await program.parseAsync(urlArgs);
		expect(dialogs).toHaveLength(1);
		expect(dialogs[0]).toContain(
			"read scheme, host, port, and database of DATABASE_URL",
		);
		expect(dialogs[0]).toContain("check which database host prod uses");
		expect(dialogs[0]).not.toContain("hunter2");
		const output = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(JSON.parse(output)).toEqual({
			applicationId: "app-1",
			name: "DATABASE_URL",
			scheme: "postgres",
			host: "db.example.net",
			port: "5432",
			database: "app",
		});
		expect(output).not.toContain("hunter2");
	});

	it("prints nothing when the user denies the URL read", async () => {
		answerDialog("denied");
		const { program } = setup([dbApp]);

		await expect(program.parseAsync(urlArgs)).rejects.toMatchObject({
			code: "AGENT_APPROVAL_DENIED",
		});
		expect(console.log).not.toHaveBeenCalled();
	});

	it("keeps the URL read blocked without a dialog backend", async () => {
		const { program } = setup([dbApp]);

		await expect(program.parseAsync(urlArgs)).rejects.toMatchObject({
			code: "AGENT_POLICY_BLOCKED",
		});
		expect(console.log).not.toHaveBeenCalled();
	});

	it("reads URL parts inside the deploy project without prompting", async () => {
		const dialogs = answerDialog("denied");
		const { program } = setup([
			{
				...dbApp,
				environmentId: "allowed-env",
				environment: {
					name: "production",
					project: { name: "allowed-project" },
				},
			},
		]);

		await program.parseAsync(urlArgs);
		expect(dialogs).toHaveLength(0);
		expect(console.log).toHaveBeenCalledOnce();
	});

	it("edits database env through saveEnvironment with only id and env", async () => {
		answerDialog("denied");
		const database = {
			name: "db",
			env: "POSTGRES_EXTRA=1\n",
			environmentId: "allowed-env",
			environment: { name: "production", project: { name: "allowed-project" } },
		};
		const { program, postSpy, getSpy } = setup(
			[database],
			undefined,
			"postgres",
		);

		await program.parseAsync([
			"node",
			"cli",
			"postgres",
			"env",
			"unset",
			"--postgresId",
			"pg-1",
			"--name",
			"POSTGRES_EXTRA",
		]);
		expect(getSpy).toHaveBeenCalledWith("postgres.one", { postgresId: "pg-1" });
		expect(postSpy).toHaveBeenCalledWith("postgres.saveEnvironment", {
			postgresId: "pg-1",
			env: "",
		});
	});
});
