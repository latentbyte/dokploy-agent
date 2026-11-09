import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as backends from "../src/agent/approval-backends.js";
import * as client from "../src/client.js";
import {
	annotateEnvironmentVariable,
	appendEnvironmentVariable,
	checkEnvironmentValue,
	copyEnvironmentVariables,
	environmentCopyNames,
	environmentPresence,
	environmentReferenceRisk,
	environmentRenameRisk,
	environmentUrlCredentialRisk,
	environmentUrlParts,
	matchCheckFromOptions,
	registerServiceEnvCommands,
	renameEnvironmentVariable,
	replaceEnvironmentUrlHost,
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

	it("rejects comments with line separators or control characters", () => {
		for (const comment of [
			"note\u2028INJECT=value",
			"note\u0085X=1",
			"a\u202eb",
		]) {
			expect(() =>
				annotateEnvironmentVariable("FOO=secret\n", "FOO", comment),
			).toThrow(/control or line-separator character U\+/);
			expect(() => appendEnvironmentVariable("", "NEW", "v", comment)).toThrow(
				/use plain text/,
			);
		}
		expect(
			appendEnvironmentVariable("", "NEW", "v", "line one\r\nline two"),
		).toBe('# line one\n# line two\nNEW="v"\n');
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

	it("renames in place and keeps prefix, separator, and raw value", () => {
		expect(
			renameEnvironmentVariable(
				"# db\r\nexport OLD = 'a\nb' # note\r\nZ=1\r\n",
				"OLD",
				"NEW",
			),
		).toBe("# db\r\nexport NEW = 'a\nb' # note\r\nZ=1\r\n");
		expect(() => renameEnvironmentVariable("A=1\n", "B", "C")).toThrow(
			"B does not exist",
		);
		expect(() => renameEnvironmentVariable("A=1\nA=2\n", "A", "C")).toThrow(
			"duplicated",
		);
		expect(() => renameEnvironmentVariable("A=1\nC=2\n", "A", "C")).toThrow(
			"C already exists",
		);
		expect(() => renameEnvironmentVariable("A=1\n", "A", "A")).toThrow(
			"A already exists",
		);
		expect(() => renameEnvironmentVariable("A=1\n", "A", "1BAD")).toThrow(
			"Invalid environment variable name: 1BAD",
		);
	});

	it("copies raw assignment bytes after the target document", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Dokploy reference syntax
		const reference = "B=${{project.KEY}}";
		expect(
			copyEnvironmentVariables(
				`export A = 'x\ny' # note\r\n${reference}\r\nC=skip\r\n`,
				"KEEP=1",
				["A", "B"],
			),
		).toBe(`KEEP=1\nexport A = 'x\ny' # note\n${reference}\n`);
		expect(copyEnvironmentVariables("A=1\n", "", ["A"])).toBe("A=1\n");
	});

	it("refuses copies that would be ambiguous or overwrite the target", () => {
		expect(() => copyEnvironmentVariables("A=1\n", "A=2\n", ["A"])).toThrow(
			"A already exists",
		);
		expect(() => copyEnvironmentVariables("A=1\nA=2\n", "", ["A"])).toThrow(
			"duplicated",
		);
	});

	it("selects names in source order from --names or --all", () => {
		const source = "B=1\nA=2\nC=3\n";
		expect(environmentCopyNames(source, { all: true })).toEqual([
			"B",
			"A",
			"C",
		]);
		expect(environmentCopyNames(source, { names: "C, B,C" })).toEqual([
			"B",
			"C",
		]);
		expect(() => environmentCopyNames(source, {})).toThrow("exactly one");
		expect(() =>
			environmentCopyNames(source, { names: "A", all: true }),
		).toThrow("exactly one");
		expect(() => environmentCopyNames(source, { names: " , " })).toThrow(
			"lists no variables",
		);
		expect(() => environmentCopyNames(source, { names: "NOPE" })).toThrow(
			"NOPE does not exist",
		);
		expect(() => environmentCopyNames("", { all: true })).toThrow(
			"no environment variables",
		);
	});

	it("flags renames that publish a value or drop a secret-looking name", () => {
		expect(environmentRenameRisk("DB_PASSWORD", "NEXT_PUBLIC_DB")).toContain(
			"NEXT_PUBLIC_ client-bundle prefix",
		);
		expect(environmentRenameRisk("SITE_NAME", "VITE_SITE_NAME")).toContain(
			"VITE_",
		);
		expect(environmentRenameRisk("STRIPE_SECRET", "STRIPE_SK")).toContain(
			"no longer redacted",
		);
		expect(environmentRenameRisk("VITE_TITLE", "VITE_APP_TITLE")).toBe(
			undefined,
		);
		expect(environmentRenameRisk("DB_PASSWORD", "DATABASE_PASSWORD")).toBe(
			undefined,
		);
		expect(environmentRenameRisk("LOG_LEVEL", "LOGGING_LEVEL")).toBe(undefined);
	});

	it("flags shared-variable references under a client-bundle prefix", () => {
		const reference = `$${"{{project.DB_PASSWORD}}"}`;
		expect(environmentReferenceRisk("NEXT_PUBLIC_DB", reference)).toContain(
			"NEXT_PUBLIC_ client-bundle prefix",
		);
		expect(environmentReferenceRisk("DB_PASSWORD", reference)).toBe(undefined);
		expect(environmentReferenceRisk("VITE_TITLE", "Shop")).toBe(undefined);
	});

	it("flags moving a URL that carries credentials to another host", () => {
		const document =
			'DB="postgres://user:hunter2@old.example.net/app"\nAPI=https://old.example.com\n';
		const risk = environmentUrlCredentialRisk(
			document,
			"DB",
			"new.example.net",
		);
		expect(risk).toBe(
			"DB carries credentials that would be sent to new.example.net",
		);
		expect(risk).not.toContain("hunter2");
		expect(
			environmentUrlCredentialRisk(document, "API", "new.example.com"),
		).toBe(undefined);
		expect(environmentUrlCredentialRisk(document, "MISSING", "x")).toBe(
			undefined,
		);
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

	it("refuses URLs with an @ after the host without echoing them", () => {
		let error: unknown;
		try {
			environmentUrlParts(
				"DB=postgres://user:hun/ter2@db.example.net/app\n",
				"DB",
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({ code: "INVALID_ENV_URL" });
		expect(String((error as Error).message)).not.toContain("ter2");
	});

	it("swaps only the host of a URL value", () => {
		expect(
			replaceEnvironmentUrlHost(
				'A=1\nDB="postgres://user:hunter2@Old.Example.net:5432/app?x=1"\nB=2\n',
				"DB",
				"old.example.net",
				"new.example.net",
			),
		).toBe(
			'A=1\nDB="postgres://user:hunter2@new.example.net:5432/app?x=1"\nB=2\n',
		);
		expect(
			replaceEnvironmentUrlHost(
				"export BASE=https://old.example.com\r\n",
				"BASE",
				"old.example.com",
				"new.example.com",
			),
		).toBe("export BASE=https://new.example.com\r\n");
	});

	it("refuses a host that is not the expected one without echoing the value", () => {
		const cases: Array<[string, string]> = [
			["U=https://other.example.com/old.example.com\n", "old.example.com"],
			["U=https://old.example.com.evil.example/\n", "old.example.com"],
			["U=not-a-url-hunter2\n", "old.example.com"],
		];
		for (const [document, from] of cases) {
			let error: unknown;
			try {
				replaceEnvironmentUrlHost(document, "U", from, "new.example.com");
			} catch (caught) {
				error = caught;
			}
			expect(error).toMatchObject({ code: "ENV_URL_HOST_MISMATCH" });
			expect(String((error as Error).message)).not.toContain("hunter2");
			expect(String((error as Error).message)).not.toContain("other");
		}
		expect(() =>
			replaceEnvironmentUrlHost(
				"U=https://old.example.com\n",
				"U",
				"old.example.com",
				"new.example.com/path",
			),
		).toThrow("--to must be a bare hostname");
	});

	it("reports presence without the value", () => {
		const document = 'A="x"\nEMPTY=""\nDUP=1\nDUP=2\n';
		expect(environmentPresence(document, "A")).toEqual({
			exists: true,
			duplicated: false,
			empty: false,
		});
		expect(environmentPresence(document, "EMPTY")).toMatchObject({
			empty: true,
		});
		expect(environmentPresence(document, "DUP")).toEqual({
			exists: true,
			duplicated: true,
			empty: null,
		});
		expect(environmentPresence(document, "MISSING")).toEqual({
			exists: false,
			duplicated: false,
			empty: null,
		});
	});

	it("checks a stored value by equality, digest, or substring", () => {
		const document = 'TOKEN="hunter2-secret"\n';
		const sha256 = createHash("sha256").update("hunter2-secret").digest("hex");
		const sha512 = createHash("sha512").update("hunter2-secret").digest("hex");
		const check = (opts: Record<string, unknown>) =>
			checkEnvironmentValue(document, "TOKEN", matchCheckFromOptions(opts));
		expect(check({ value: "hunter2-secret" })).toBe(true);
		expect(check({ value: "hunter2" })).toBe(false);
		expect(check({ sha256: sha256.toUpperCase() })).toBe(true);
		expect(check({ sha512 })).toBe(true);
		expect(check({ sha256: "0".repeat(64) })).toBe(false);
		expect(
			checkEnvironmentValue(document, "TOKEN", {
				kind: "contains",
				substring: "2-sec",
			}),
		).toBe(true);
		expect(() => check({})).toThrow("exactly one");
		expect(() => check({ value: "a", sha256 })).toThrow("exactly one");
		expect(() => check({ sha256: "abc" })).toThrow("64 hex");
		expect(() =>
			checkEnvironmentValue("A=1\nA=2\n", "A", { kind: "equals", value: "1" }),
		).toThrow("duplicated");
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
				dialogs.push(backends.plainDialogText(dialog));
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
			"--thread-url",
			"t3-thread://v2/env-1/thread-1",
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
		expect(dialogs[0]).toMatch(
			/\n- API_URL=http\*\*\* \(23 chars\)\n\+ API_URL="https:\/\/new\.example\.com"\n/,
		);
		expect(dialogs[0]).toContain(
			"AGENT'S REASON (unverified)\npoint the app at the new API host",
		);
		expect(dialogs[0]).toContain(
			"AGENT THREAD (unverified)\nhttps://app.t3.codes/threads/env-1/thread-1\n",
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

	it("asks before publishing a shared variable inside the deploy project", async () => {
		const dialogs = answerDialog("denied");
		const inside = {
			...outsideApp,
			environmentId: "allowed-env",
			environment: {
				name: "production",
				project: { name: "allowed-project" },
			},
		};
		const { program, postSpy } = setup([inside]);
		const args = [...setArgs];
		args[args.indexOf("API_URL")] = "NEXT_PUBLIC_API";
		args[args.indexOf("https://new.example.com")] =
			`$${"{{project.API_TOKEN}}"}`;

		await expect(program.parseAsync(args)).rejects.toMatchObject({
			code: "AGENT_APPROVAL_DENIED",
		});
		expect(dialogs).toHaveLength(1);
		expect(dialogs[0]).toContain("references a shared variable");
		expect(postSpy).not.toHaveBeenCalled();
	});

	describe("env checks", () => {
		const inside = {
			...outsideApp,
			environmentId: "allowed-env",
			environment: {
				name: "production",
				project: { name: "allowed-project" },
			},
		};
		const args = (command: string, ...rest: string[]) => [
			"node",
			"cli",
			"application",
			"env",
			command,
			"--applicationId",
			"app-1",
			...rest,
			"--json",
		];
		const checkLog = () => {
			const file = path.join(
				process.env.XDG_STATE_HOME ?? "",
				"dokploy-agent",
				"env-checks.jsonl",
			);
			return fs
				.readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		};
		const printed = () =>
			JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		function stubAuth() {
			vi.stubEnv("DOKPLOY_URL", "https://dokploy.example.com");
			vi.stubEnv("DOKPLOY_API_KEY", "test-token");
		}

		it("answers has without a dialog and logs it", async () => {
			stubAuth();
			const dialogs = answerDialog("approved");
			const { program } = setup([outsideApp]);

			await program.parseAsync(args("has", "--name", "SECRET"));

			expect(dialogs).toHaveLength(0);
			expect(printed()).toEqual({
				applicationId: "app-1",
				name: "SECRET",
				exists: true,
				duplicated: false,
				empty: false,
			});
			expect(checkLog().at(-1)).toMatchObject({
				operation: "has",
				name: "SECRET",
				dokployUrl: "https://dokploy.example.com",
				target: { kind: "application", id: "app-1" },
			});
		});

		it("asks even inside the policy and logs no input", async () => {
			stubAuth();
			const dialogs = answerDialog("approved");
			const { program } = setup([inside]);
			const digest = createHash("sha256").update("old-value").digest("hex");

			await program.parseAsync(
				args("match", "--name", "SECRET", "--sha256", digest),
			);

			expect(printed()).toMatchObject({ check: "sha256", matches: true });
			expect(dialogs).toHaveLength(1);
			expect(dialogs[0]).toContain(
				`check sha256(SECRET) equals ${digest.slice(0, 16)}...`,
			);
			expect(dialogs[0]).not.toContain("old-value");
			const entry = checkLog().at(-1);
			expect(entry).toMatchObject({
				operation: "match",
				check: "sha256",
				result: true,
			});
			expect(JSON.stringify(entry)).not.toContain(digest.slice(0, 16));
		});

		it("logs the input length but not the substring", async () => {
			stubAuth();
			answerDialog("approved");
			const { program } = setup([outsideApp]);

			await program.parseAsync(
				args("contains", "--name", "API_URL", "--substring", "old.example"),
			);

			expect(printed()).toMatchObject({ contains: true });
			const entry = checkLog().at(-1);
			expect(entry).toMatchObject({ inputLength: 11, result: true });
			expect(JSON.stringify(entry)).not.toContain("old.example");
		});

		it("answers nothing when the user denies", async () => {
			stubAuth();
			answerDialog("denied");
			const { program } = setup([inside]);

			await expect(
				program.parseAsync(args("match", "--name", "SECRET", "--value", "x")),
			).rejects.toMatchObject({ code: "AGENT_APPROVAL_DENIED" });
			expect(console.log).not.toHaveBeenCalled();
			expect(checkLog().at(-1)).toMatchObject({
				operation: "match",
				check: "equals",
				inputLength: 1,
				result: "AGENT_APPROVAL_DENIED",
			});
		});

		it("stays blocked when approval is disabled", async () => {
			stubAuth();
			const { program } = setup([inside], {
				enabled: false,
				timeoutSeconds: 90,
			});

			await expect(
				program.parseAsync(
					args("contains", "--name", "SECRET", "--substring", "old"),
				),
			).rejects.toMatchObject({
				code: "AGENT_POLICY_BLOCKED",
				message: expect.stringContaining("always needs the user"),
			});
		});
	});

	describe("env replace-host", () => {
		const replaceArgs = (from: string) => [
			"node",
			"cli",
			"application",
			"env",
			"replace-host",
			"--applicationId",
			"app-1",
			"--name",
			"API_URL",
			"--from",
			from,
			"--to",
			"new.example.com",
			"--json",
		];

		it("writes after approval and shows only the hosts", async () => {
			const dialogs = answerDialog("approved");
			const { program, postSpy } = setup([outsideApp, outsideApp]);

			await program.parseAsync(replaceArgs("old.example.com"));

			expect(postSpy).toHaveBeenCalledWith("application.saveEnvironment", {
				applicationId: "app-1",
				env: "API_URL=https://new.example.com\nSECRET=old-value\n",
				buildArgs: null,
				buildSecrets: null,
				createEnvFile: false,
			});
			expect(dialogs[0]).toContain(
				"- API_URL host old.example.com\n+ API_URL host new.example.com",
			);
			expect(dialogs[0]).not.toContain("old-value");
		});

		it("prompts before checking the host outside the policy", async () => {
			const dialogs = answerDialog("denied");
			const { program, postSpy } = setup([outsideApp]);

			await expect(
				program.parseAsync(replaceArgs("guess.example.com")),
			).rejects.toMatchObject({ code: "AGENT_APPROVAL_DENIED" });
			expect(dialogs).toHaveLength(1);
			expect(postSpy).not.toHaveBeenCalled();
		});

		it("checks the host after approval", async () => {
			answerDialog("approved");
			const { program, postSpy } = setup([outsideApp, outsideApp]);

			await expect(
				program.parseAsync(replaceArgs("guess.example.com")),
			).rejects.toMatchObject({ code: "ENV_URL_HOST_MISMATCH" });
			expect(postSpy).not.toHaveBeenCalled();
		});

		it("keeps the hard block when approval is disabled", async () => {
			const { program, postSpy } = setup([outsideApp], {
				enabled: false,
				timeoutSeconds: 90,
			});

			await expect(
				program.parseAsync(replaceArgs("guess.example.com")),
			).rejects.toMatchObject({ code: "AGENT_POLICY_BLOCKED" });
			expect(postSpy).not.toHaveBeenCalled();
		});
	});

	describe("env rename", () => {
		const inside = {
			...outsideApp,
			environmentId: "allowed-env",
			environment: {
				name: "production",
				project: { name: "allowed-project" },
			},
		};
		const renameArgs = (name: string, newName: string) => [
			"node",
			"cli",
			"application",
			"env",
			"rename",
			"--applicationId",
			"app-1",
			"--name",
			name,
			"--new-name",
			newName,
			"--json",
		];

		it("renames inside the deploy project without prompting", async () => {
			const dialogs = answerDialog("denied");
			const { program, postSpy } = setup([inside]);

			await program.parseAsync(renameArgs("API_URL", "SERVICE_URL"));
			expect(dialogs).toHaveLength(0);
			expect(postSpy).toHaveBeenCalledWith(
				"application.saveEnvironment",
				expect.objectContaining({
					env: "SERVICE_URL=https://old.example.com\nSECRET=old-value\n",
				}),
			);
			expect(console.log).toHaveBeenCalledWith(
				expect.stringContaining('"newName": "SERVICE_URL"'),
			);
		});

		it("asks before publishing a value inside the deploy project", async () => {
			const dialogs = answerDialog("approved");
			const { program, postSpy } = setup([inside, inside]);

			await program.parseAsync(renameArgs("SECRET", "NEXT_PUBLIC_SECRET"));
			expect(dialogs).toHaveLength(1);
			expect(dialogs[0]).toMatch(
				/\n- SECRET=\*\*\* \(9 chars\)\n\+ NEXT_PUBLIC_SECRET=\*\*\* \(9 chars\)\n/,
			);
			expect(dialogs[0]).toContain("NEXT_PUBLIC_ client-bundle prefix");
			expect(dialogs[0]).not.toContain("old-value");
			expect(postSpy).toHaveBeenCalledWith(
				"application.saveEnvironment",
				expect.objectContaining({
					env: "API_URL=https://old.example.com\nNEXT_PUBLIC_SECRET=old-value\n",
				}),
			);
		});

		it("asks before dropping a secret-looking name and writes nothing on deny", async () => {
			const dialogs = answerDialog("denied");
			const { program, postSpy } = setup([inside]);

			await expect(
				program.parseAsync(renameArgs("SECRET", "PLAIN")),
			).rejects.toMatchObject({ code: "AGENT_APPROVAL_DENIED", exitCode: 2 });
			expect(dialogs[0]).toContain("no longer redacted");
			expect(postSpy).not.toHaveBeenCalled();
		});

		it("blocks a risky rename on hosts without a dialog", async () => {
			const { program, postSpy } = setup([inside]);

			await expect(
				program.parseAsync(renameArgs("SECRET", "VITE_SECRET")),
			).rejects.toMatchObject({
				code: "AGENT_POLICY_BLOCKED",
				message: expect.stringContaining("no approval dialog available"),
			});
			expect(postSpy).not.toHaveBeenCalled();
		});

		it("names both the perimeter and the rename risk in one dialog", async () => {
			const dialogs = answerDialog("approved");
			const { program, postSpy } = setup([outsideApp, outsideApp]);

			await program.parseAsync(renameArgs("SECRET", "VITE_SECRET"));
			expect(dialogs).toHaveLength(1);
			expect(dialogs[0]).toContain("rejects application app-1");
			expect(dialogs[0]).toContain("VITE_ client-bundle prefix");
			expect(postSpy).toHaveBeenCalledOnce();
		});
	});

	describe("env copy", () => {
		const compose = {
			name: "backend",
			appName: "backend-a1b2c3",
			env: "API_URL=https://api.example.com\nSECRET=old-compose-value\nNEXT_PUBLIC_SITE=https://site.example.com\nOTHER=skip\n",
			environmentId: "other-env",
			environment: { name: "production", project: { name: "storefront" } },
		};
		const emptyApp = { ...outsideApp, env: "KEEP=1\n" };
		const copyArgs = [
			"node",
			"cli",
			"application",
			"env",
			"copy",
			"--from-compose",
			"compose-1",
			"--applicationId",
			"app-1",
			"--names",
			"API_URL,SECRET,NEXT_PUBLIC_SITE",
			"--reason",
			"move backend to an application",
			"--json",
		];

		it("copies one approved batch and prints no values", async () => {
			const dialogs = answerDialog("approved");
			const { program, postSpy } = setup([
				compose,
				emptyApp,
				compose,
				emptyApp,
			]);
			await program.parseAsync(copyArgs);
			expect(dialogs).toHaveLength(1);
			expect(dialogs[0]).toContain("Approve env copy on application web?");
			expect(dialogs[0]).toContain("from compose backend / backend-a1b2c3");
			expect(dialogs[0]).toContain("[NEXT_PUBLIC_ client-bundle prefix]");
			expect(dialogs[0]).toContain("env copy always needs the user");
			expect(dialogs[0]).not.toContain("old-compose-value");
			expect(postSpy).toHaveBeenCalledTimes(1);
			expect(postSpy.mock.calls[0]?.[1]).toMatchObject({
				applicationId: "app-1",
				env: "KEEP=1\nAPI_URL=https://api.example.com\nSECRET=old-compose-value\nNEXT_PUBLIC_SITE=https://site.example.com\n",
			});
			const output = vi.mocked(console.log).mock.calls.flat().join("\n");
			expect(JSON.parse(output)).toEqual({
				applicationId: "app-1",
				fromComposeId: "compose-1",
				names: ["API_URL", "SECRET", "NEXT_PUBLIC_SITE"],
				copied: true,
			});
		});

		it("asks even when both services are inside the deploy project", async () => {
			const inside = {
				environmentId: "allowed-env",
				environment: {
					name: "production",
					project: { name: "allowed-project" },
				},
			};
			const dialogs = answerDialog("approved");
			const records = [
				{ ...compose, ...inside },
				{ ...emptyApp, ...inside },
				{ ...compose, ...inside },
				{ ...emptyApp, ...inside },
			];
			const { program, postSpy } = setup(records);
			await program.parseAsync(copyArgs);
			expect(dialogs).toHaveLength(1);
			expect(postSpy).toHaveBeenCalledTimes(1);
		});

		it("records key names but no values in the audit log", async () => {
			answerDialog("approved");
			const logPath = path.join(
				process.env.XDG_STATE_HOME ?? "",
				"dokploy-agent",
				"approvals.jsonl",
			);
			const { program } = setup([compose, emptyApp, compose, emptyApp]);
			await program.parseAsync(copyArgs);
			const log = fs.readFileSync(logPath, "utf8").trim().split("\n");
			const entry = log.at(-1) ?? "";
			expect(JSON.parse(entry)).toMatchObject({
				endpoint: "application.saveEnvironment",
				operation: "copy",
				fromComposeId: "compose-1",
				names: ["API_URL", "SECRET", "NEXT_PUBLIC_SITE"],
				result: "approved",
			});
			expect(entry).not.toContain("old-compose-value");
		});

		it.each([
			["denied", "AGENT_APPROVAL_DENIED"],
			["timeout", "AGENT_APPROVAL_TIMEOUT"],
		] as const)("writes nothing on %s", async (result, code) => {
			answerDialog(result);
			const { program, postSpy } = setup([compose, emptyApp]);
			await expect(program.parseAsync(copyArgs)).rejects.toMatchObject({
				code,
			});
			expect(postSpy).not.toHaveBeenCalled();
		});

		it("stays blocked on hosts without a dialog and when disabled", async () => {
			const { program, postSpy } = setup([compose, emptyApp]);
			await expect(program.parseAsync(copyArgs)).rejects.toMatchObject({
				code: "AGENT_POLICY_BLOCKED",
				message: expect.stringContaining("no approval dialog available"),
			});
			const dialogs = answerDialog("approved");
			const disabled = setup([compose, emptyApp], { enabled: false });
			await expect(disabled.program.parseAsync(copyArgs)).rejects.toMatchObject(
				{
					code: "AGENT_POLICY_BLOCKED",
				},
			);
			expect(dialogs).toHaveLength(0);
			expect(postSpy).not.toHaveBeenCalled();
			expect(disabled.postSpy).not.toHaveBeenCalled();
		});

		it.each([
			["source", [{ ...compose, env: "SECRET=rotated\n" }, emptyApp]],
			["target", [compose, { ...emptyApp, env: "KEEP=2\n" }]],
			["companion field", [compose, { ...emptyApp, buildArgs: "A=1" }]],
		])(
			"aborts when the %s changed while the dialog was open",
			async (_, after) => {
				answerDialog("approved");
				const { program, postSpy } = setup([compose, emptyApp, ...after]);
				await expect(program.parseAsync(copyArgs)).rejects.toMatchObject({
					code: "AGENT_APPROVAL_STALE",
				});
				expect(postSpy).not.toHaveBeenCalled();
			},
		);

		it("denies across environments before any prompt", async () => {
			const dialogs = answerDialog("approved");
			const { program } = setup([
				compose,
				{ ...emptyApp, environmentId: "third-env" },
			]);
			await expect(program.parseAsync(copyArgs)).rejects.toMatchObject({
				code: "AGENT_POLICY_BLOCKED",
				message: expect.stringContaining("in one environment"),
			});
			expect(dialogs).toHaveLength(0);
		});

		it("denies a batch the dialog cannot show in full", async () => {
			const dialogs = answerDialog("approved");
			const env = Array.from({ length: 19 }, (_, i) => `KEY_${i}=v\n`).join("");
			const { program } = setup([{ ...compose, env }, emptyApp]);
			await expect(
				program.parseAsync([
					"node",
					"cli",
					"application",
					"env",
					"copy",
					"--from-compose",
					"compose-1",
					"--applicationId",
					"app-1",
					"--all",
				]),
			).rejects.toMatchObject({
				code: "AGENT_POLICY_BLOCKED",
				message: expect.stringContaining("does not fit"),
			});
			expect(dialogs).toHaveLength(0);
		});

		it("accepts the largest batch the dialog shows in full", async () => {
			const dialogs = answerDialog("approved");
			const source = {
				...compose,
				env: Array.from({ length: 18 }, (_, i) => `KEY_${i}=v\n`).join(""),
			};
			const { program, postSpy } = setup([source, emptyApp, source, emptyApp]);
			await program.parseAsync([
				"node",
				"cli",
				"application",
				"env",
				"copy",
				"--from-compose",
				"compose-1",
				"--applicationId",
				"app-1",
				"--all",
			]);
			expect(dialogs[0]).toContain("KEY_17=");
			expect(dialogs[0]).not.toContain("more lines not shown");
			expect(postSpy).toHaveBeenCalledOnce();
		});

		it("refuses to overwrite a target key before any prompt", async () => {
			const dialogs = answerDialog("approved");
			const { program } = setup([
				compose,
				{ ...emptyApp, env: "SECRET=target-value\n" },
			]);
			await expect(program.parseAsync(copyArgs)).rejects.toThrow(
				"SECRET already exists",
			);
			expect(dialogs).toHaveLength(0);
		});
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

	it("keeps URL parse errors behind the approval", async () => {
		const { program } = setup([
			{
				...dbApp,
				env: "DATABASE_URL=postgres://app:hun/ter2@db.example.net/app\n",
			},
		]);

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
