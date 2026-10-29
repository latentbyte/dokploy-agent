import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as backends from "../src/agent/approval-backends.js";
import * as client from "../src/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

afterEach(() => {
	vi.restoreAllMocks();
});

async function loadAgentSafeGeneratedCommands() {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "dokploy-cli-agent-safe-"),
	);
	const outPath = path.join(tempDir, "src", "generated", "commands.ts");

	try {
		execFileSync(
			"pnpm",
			["exec", "tsx", "scripts/generate.ts", "--agent-safe", "--out", outPath],
			{
				cwd: ROOT,
			},
		);

		const modulePath = pathToFileURL(outPath).href;
		const { AGENT_SAFE_BUILD, registerGeneratedCommands } = await import(
			modulePath
		);
		return { AGENT_SAFE_BUILD, registerGeneratedCommands, tempDir };
	} catch (error) {
		fs.rmSync(tempDir, { recursive: true, force: true });
		throw error;
	}
}

describe("generator", () => {
	const specPath = path.join(ROOT, "openapi.json");
	const generatedPath = path.join(ROOT, "src", "generated", "commands.ts");

	it("openapi.json should exist", () => {
		expect(fs.existsSync(specPath)).toBe(true);
	});

	it("generated commands file should exist", () => {
		expect(fs.existsSync(generatedPath)).toBe(true);
	});

	it("generated file should export registerGeneratedCommands", () => {
		const content = fs.readFileSync(generatedPath, "utf8");
		expect(content).toContain("export function registerGeneratedCommands");
		expect(content).toContain("export const AGENT_SAFE_BUILD = false");
	});

	it("generated file should import from client", () => {
		const content = fs.readFileSync(generatedPath, "utf8");
		expect(content).toContain('from "../client.js"');
	});

	it("generated file should contain command groups from the spec", () => {
		const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
		const content = fs.readFileSync(generatedPath, "utf8");

		// Only check groups that have a dot-separated action (group.action)
		const groups = new Set<string>();
		for (const p of Object.keys(spec.paths)) {
			const clean = p.replace(/^\//, "");
			const [group, ...rest] = clean.split(".");
			if (group && rest.length > 0) groups.add(group);
		}

		for (const group of groups) {
			expect(content).toContain(`"${group}.`);
		}
	});

	it("generated file should include read log endpoints", () => {
		const content = fs.readFileSync(generatedPath, "utf8");

		expect(content).toContain('apiGet("application.readLogs"');
		expect(content).toContain('apiGet("compose.readLogs"');
		expect(content).toContain('apiGet("postgres.readLogs"');
	});

	it("number of apiPost/apiGet calls should match non-overlay endpoints", () => {
		const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
		const content = fs.readFileSync(generatedPath, "utf8");
		const overlayEndpoints = new Set(["deployment.readLogs"]);

		// Count only endpoints with group.action pattern not implemented by overlays
		let validEndpoints = 0;
		for (const p of Object.keys(spec.paths)) {
			const clean = p.replace(/^\//, "");
			const [group, ...rest] = clean.split(".");
			if (group && rest.length > 0 && !overlayEndpoints.has(clean))
				validEndpoints++;
		}

		const apiCalls = (content.match(/await api(Post|Get)\(/g) || []).length;
		expect(apiCalls).toBe(validEndpoints);
		expect(content).not.toContain('apiGet("deployment.readLogs"');
	});

	it("agent-safe builds should merge custom wildcard blacklists", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-cli-test-"));
		const blacklistPath = path.join(tempDir, "blacklist.json");
		const outPath = path.join(tempDir, "generated", "commands.ts");
		fs.writeFileSync(
			blacklistPath,
			JSON.stringify({
				version: 1,
				commands: [
					{
						endpoint: "libsql.*",
						reason: "service type unused in this account",
					},
				],
			}),
		);

		try {
			execFileSync(
				"pnpm",
				[
					"exec",
					"tsx",
					"scripts/generate.ts",
					"--agent-safe",
					"--out",
					outPath,
				],
				{
					cwd: ROOT,
					env: {
						...process.env,
						DOKPLOY_AGENT_BLACKLIST_PATH: blacklistPath,
					},
				},
			);
			const content = fs.readFileSync(outPath, "utf8");
			expect(content).not.toContain('apiGet("libsql.');
			expect(content).not.toContain('apiGet("settings.getLogCleanupStatus');
			expect(content).toContain("registerAgentSafetyCommands(program");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("agent-safe builds should read blacklist from dokploy config dir", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-cli-test-"));
		const configHome = path.join(tempDir, "config-home");
		const blacklistPath = path.join(
			configHome,
			"dokploy",
			"agent-command-blacklist.json",
		);
		const outPath = path.join(tempDir, "commands.ts");
		fs.mkdirSync(path.dirname(blacklistPath), { recursive: true });
		fs.writeFileSync(
			blacklistPath,
			JSON.stringify({
				version: 1,
				commands: [
					{
						endpoint: "domain.validateDomain",
						reason: "not needed in tests",
					},
				],
			}),
		);

		try {
			execFileSync(
				"pnpm",
				[
					"exec",
					"tsx",
					"scripts/generate.ts",
					"--agent-safe",
					"--out",
					outPath,
				],
				{
					cwd: ROOT,
					env: {
						...process.env,
						XDG_CONFIG_HOME: configHome,
					},
				},
			);
			const content = fs.readFileSync(outPath, "utf8");
			expect(content).not.toContain('apiPost("domain.validateDomain"');
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("agent-safe --out should not rewrite tracked generated commands", () => {
		const before = fs.readFileSync(generatedPath, "utf8");
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-cli-test-"));
		const outPath = path.join(tempDir, "commands.ts");

		try {
			execFileSync(
				"pnpm",
				[
					"exec",
					"tsx",
					"scripts/generate.ts",
					"--agent-safe",
					"--out",
					outPath,
				],
				{
					cwd: ROOT,
					env: process.env,
				},
			);

			const generatedContent = fs.readFileSync(outPath, "utf8");
			expect(generatedContent).toContain("const AGENT_SAFE_BUILD = true");
			expect(generatedContent).toContain('apiPost("application.create"');
			expect(generatedContent).toContain('apiPost("compose.create"');
			expect(generatedContent).toContain('apiPost("domain.create"');
			expect(generatedContent).not.toContain('apiPost("domain.update"');
			expect(generatedContent).toContain('apiPost("postgres.create"');
			expect(generatedContent).toContain('apiPost("postgres.deploy"');
			expect(generatedContent).toContain(
				'apiPost("application.saveDockerProvider"',
			);
			expect(generatedContent).toContain('apiPost("application.stop"');
			expect(generatedContent).toContain('apiPost("mounts.create"');
			expect(generatedContent).toContain('apiPost("port.create"');
			expect(generatedContent).toContain('apiPost("volumeBackups.create"');
			expect(generatedContent).toContain('apiPost("volumeBackups.runManually"');
			expect(generatedContent).not.toContain('apiPost("volumeBackups.delete"');
			expect(generatedContent).not.toContain('apiPost("volumeBackups.update"');
			expect(generatedContent).toContain(
				'apiPost("application.saveGitProvider"',
			);
			expect(generatedContent).toContain('apiPost("domain.delete"');
			expect(generatedContent).toContain(
				'await guardAgentSafePost("application.update", opts, reason);',
			);
			expect(generatedContent).toContain(
				'await guardAgentSafePost("application.create", opts);',
			);
			expect(generatedContent).toMatch(/from "[^"]*\/agent\/policy\.js"/);
			expect(generatedContent).toContain(
				"registerAgentSafetyCommands(program, AGENT_SAFETY_REPORT)",
			);
			expect(fs.readFileSync(generatedPath, "utf8")).toBe(before);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("parses array and object options as structured JSON", async () => {
		const program = new Command();
		const postSpy = vi
			.spyOn(client, "apiPost")
			.mockResolvedValue({ data: "ok" });

		await import("../src/generated/commands.js").then(
			({ registerGeneratedCommands }) => {
				registerGeneratedCommands(program);
			},
		);

		await program.parseAsync([
			"node",
			"cli",
			"application",
			"update",
			"--applicationId",
			"app-1",
			"--watchPaths",
			'["a", "b"]',
			"--healthCheckSwarm",
			'{"Test":["curl", "-f"], "Interval": 30}',
		]);

		expect(postSpy).toHaveBeenCalledTimes(1);
		const payload = postSpy.mock.calls[0]?.[1];
		expect(payload).toEqual(
			expect.objectContaining({
				watchPaths: ["a", "b"],
				healthCheckSwarm: {
					Test: ["curl", "-f"],
					Interval: 30,
				},
			}),
		);
	});

	it("parses boolean flags with an optional true or false value", async () => {
		const program = new Command();
		const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue(true);

		await import("../src/generated/commands.js").then(
			({ registerGeneratedCommands }) => {
				registerGeneratedCommands(program);
			},
		);
		const run = (...extra: string[]) =>
			program.parseAsync([
				"node",
				"cli",
				"application",
				"update",
				"--applicationId",
				"app-1",
				...extra,
			]);

		await run("--previewHttps", "false", "--isPreviewDeploymentsActive");
		expect(postSpy.mock.calls[0]?.[1]).toEqual(
			expect.objectContaining({
				previewHttps: false,
				isPreviewDeploymentsActive: true,
			}),
		);
		await expect(run("--previewHttps", "yes")).rejects.toThrow(
			"Invalid boolean for --previewHttps",
		);
		expect(postSpy).toHaveBeenCalledOnce();
	});

	it("rejects malformed JSON for complex options", async () => {
		const program = new Command();
		const postSpy = vi
			.spyOn(client, "apiPost")
			.mockResolvedValue({ data: "ok" });

		await import("../src/generated/commands.js").then(
			({ registerGeneratedCommands }) => {
				registerGeneratedCommands(program);
			},
		);

		await expect(
			program.parseAsync([
				"node",
				"cli",
				"application",
				"update",
				"--applicationId",
				"app-1",
				"--watchPaths",
				"[a,b",
			]),
		).rejects.toThrow("Invalid JSON for --watchPaths");
		expect(postSpy).not.toHaveBeenCalled();
	});

	it("accepts nullable complex options when JSON null is provided", async () => {
		const program = new Command();
		const postSpy = vi
			.spyOn(client, "apiPost")
			.mockResolvedValue({ data: "ok" });

		await import("../src/generated/commands.js").then(
			({ registerGeneratedCommands }) => {
				registerGeneratedCommands(program);
			},
		);

		await program.parseAsync([
			"node",
			"cli",
			"application",
			"update",
			"--applicationId",
			"app-1",
			"--healthCheckSwarm",
			"null",
		]);

		const payload = postSpy.mock.calls[0]?.[1];
		expect(payload?.healthCheckSwarm).toBe(null);
	});

	it("keeps current values for omitted required-but-nullable fields", async () => {
		const program = new Command();
		const getSpy = vi.spyOn(client, "apiGet").mockResolvedValue({
			applicationId: "app-1",
			buildType: "nixpacks",
			dockerfile: "Dockerfile",
			dockerContextPath: ".",
			dockerBuildStage: "",
			herokuVersion: "24",
			railpackVersion: null,
		});
		const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue(true);

		await import("../src/generated/commands.js").then(
			({ registerGeneratedCommands }) => {
				registerGeneratedCommands(program);
			},
		);

		await program.parseAsync([
			"node",
			"cli",
			"application",
			"save-build-type",
			"--applicationId",
			"app-1",
			"--buildType",
			"dockerfile",
			"--dockerfile",
			"Dockerfile.prod",
		]);

		expect(getSpy).toHaveBeenCalledWith("application.one", {
			applicationId: "app-1",
		});
		expect(postSpy).toHaveBeenCalledWith("application.saveBuildType", {
			applicationId: "app-1",
			buildType: "dockerfile",
			dockerfile: "Dockerfile.prod",
			dockerContextPath: ".",
			dockerBuildStage: "",
			herokuVersion: "24",
			railpackVersion: null,
		});
	});

	it("skips the record lookup when every required field is passed", async () => {
		const program = new Command();
		const getSpy = vi.spyOn(client, "apiGet");
		const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue(true);

		await import("../src/generated/commands.js").then(
			({ registerGeneratedCommands }) => {
				registerGeneratedCommands(program);
			},
		);

		await program.parseAsync([
			"node",
			"cli",
			"application",
			"save-docker-provider",
			"--applicationId",
			"app-1",
			"--dockerImage",
			"nginx:1",
			"--username",
			"u",
			"--password",
			"p",
			"--registryUrl",
			"r",
		]);

		expect(getSpy).not.toHaveBeenCalled();
		expect(postSpy).toHaveBeenCalledTimes(1);
	});

	it("fails before posting when the record has no value to keep", async () => {
		const program = new Command();
		vi.spyOn(client, "apiGet").mockResolvedValue({ applicationId: "app-1" });
		const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue(true);

		await import("../src/generated/commands.js").then(
			({ registerGeneratedCommands }) => {
				registerGeneratedCommands(program);
			},
		);

		await expect(
			program.parseAsync([
				"node",
				"cli",
				"application",
				"save-build-type",
				"--applicationId",
				"app-1",
				"--buildType",
				"static",
			]),
		).rejects.toMatchObject({
			code: "MISSING_OPTION",
			message: expect.stringContaining("--dockerfile"),
		});
		expect(postSpy).not.toHaveBeenCalled();
	});

	it("keeps nulls only where the spec allows them", async () => {
		const program = new Command();
		vi.spyOn(client, "apiGet").mockResolvedValue({
			repository: "repo",
			owner: "me",
			buildPath: "/",
			githubId: null,
			branch: null,
			triggerType: "push",
		});
		const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue(true);

		await import("../src/generated/commands.js").then(
			({ registerGeneratedCommands }) => {
				registerGeneratedCommands(program);
			},
		);
		const run = (...extra: string[]) =>
			program.parseAsync([
				"node",
				"cli",
				"application",
				"save-github-provider",
				"--applicationId",
				"app-1",
				...extra,
			]);

		await expect(run()).rejects.toMatchObject({
			code: "MISSING_OPTION",
			message: expect.stringMatching(/--branch;/),
		});
		expect(postSpy).not.toHaveBeenCalled();

		await run("--branch", "main");
		expect(postSpy).toHaveBeenCalledWith(
			"application.saveGithubProvider",
			expect.objectContaining({ githubId: null, branch: "main" }),
		);
	});

	it("keeps single-field updates required", async () => {
		const program = new Command();
		await import("../src/generated/commands.js").then(
			({ registerGeneratedCommands }) => {
				registerGeneratedCommands(program);
			},
		);
		const compose = program.commands.find(
			(command) => command.name() === "compose",
		);
		const saveEnvironment = compose?.commands.find(
			(command) => command.name() === "save-environment",
		);
		const env = saveEnvironment?.options.find(
			(option) => option.long === "--env",
		);
		expect(env?.mandatory).toBe(true);
	});

	it("checks agent policy before filling from the current record", async () => {
		const { registerGeneratedCommands, tempDir } =
			await loadAgentSafeGeneratedCommands();
		try {
			const program = new Command();
			registerGeneratedCommands(program);
			vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
				projects: [],
				servers: [{ serverId: "srv-allowed" }],
				domainSuffixes: [],
				expandedProjects: [{ projectName: "my-app" }],
				expandedApplicationIds: [],
				expandedApplicationNames: [],
			});
			const getSpy = vi
				.spyOn(client, "apiGet")
				.mockImplementation(async (_endpoint, opts) => ({
					name: "api",
					environment: {
						name: "production",
						project: {
							name: opts?.applicationId === "app-allowed" ? "my-app" : "other",
						},
					},
					serverId: "srv-allowed",
					repository: "repo",
					owner: "me",
					buildPath: "/",
					githubId: "gh-1",
					branch: "main",
					triggerType: "push",
				}));
			const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue(true);
			const args = (applicationId: string) => [
				"node",
				"cli",
				"application",
				"save-github-provider",
				"--applicationId",
				applicationId,
				"--branch",
				"release",
			];

			await expect(program.parseAsync(args("app-other"))).rejects.toMatchObject(
				{ code: "AGENT_POLICY_BLOCKED", exitCode: 2 },
			);
			expect(getSpy).toHaveBeenCalledTimes(1);
			expect(postSpy).not.toHaveBeenCalled();

			await program.parseAsync(args("app-allowed"));
			expect(postSpy).toHaveBeenCalledWith("application.saveGithubProvider", {
				applicationId: "app-allowed",
				repository: "repo",
				owner: "me",
				buildPath: "/",
				githubId: "gh-1",
				branch: "release",
				triggerType: "push",
			});
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("hides protected update fields from agent-safe commands", async () => {
		const { AGENT_SAFE_BUILD, registerGeneratedCommands, tempDir } =
			await loadAgentSafeGeneratedCommands();
		try {
			expect(AGENT_SAFE_BUILD).toBe(true);
			const program = new Command();
			registerGeneratedCommands(program);
			const application = program.commands.find(
				(command) => command.name() === "application",
			);
			const applicationUpdate = application?.commands.find(
				(command) => command.name() === "update",
			);
			const applicationOptions = applicationUpdate?.options.map(
				(option) => option.long,
			);
			expect(applicationOptions).not.toContain("--env");
			expect(applicationOptions).not.toContain("--buildSecrets");
			expect(applicationOptions).not.toContain("--password");

			const compose = program.commands.find(
				(command) => command.name() === "compose",
			);
			const composeUpdate = compose?.commands.find(
				(command) => command.name() === "update",
			);
			const composeOptions = composeUpdate?.options.map(
				(option) => option.long,
			);
			expect(composeOptions).not.toContain("--env");
			expect(composeOptions).not.toContain("--refreshToken");
			expect(composeOptions).toContain("--composeFile");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("guards expanded operations with the expanded projects allowlist", async () => {
		const { registerGeneratedCommands, tempDir } =
			await loadAgentSafeGeneratedCommands();
		try {
			const program = new Command();
			vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
				projects: [
					{
						projectName: "agent-project",
						environmentName: "production",
						environmentId: "env-1",
					},
				],
				servers: [{ serverId: "srv-allowed" }],
				domainSuffixes: [".example.com"],
				expandedProjects: [
					{ projectName: "my-app" },
					{ projectName: "storefront", applicationNames: ["catalog"] },
				],
				expandedApplicationIds: [],
				expandedApplicationNames: [],
			});
			const getSpy = vi
				.spyOn(client, "apiGet")
				.mockImplementation(async (_endpoint, opts) => {
					if (opts?.applicationId === "app-allowed") {
						return {
							name: "api",
							environment: { name: "production", project: { name: "my-app" } },
							serverId: "srv-allowed",
						};
					}
					if (opts?.applicationId === "app-catalog") {
						return {
							name: "catalog",
							environment: {
								name: "production",
								project: { name: "storefront" },
							},
							serverId: "srv-allowed",
						};
					}
					return {
						name: "web",
						environment: {
							name: "production",
							project: { name: "unrelated" },
						},
						serverId: "srv-allowed",
					};
				});
			const postSpy = vi
				.spyOn(client, "apiPost")
				.mockResolvedValue({ ok: true });

			registerGeneratedCommands(program);
			await expect(
				program.parseAsync([
					"node",
					"cli",
					"application",
					"mark-running",
					"--applicationId",
					"app-blocked",
				]),
			).rejects.toMatchObject({
				code: "AGENT_POLICY_BLOCKED",
				exitCode: 2,
				message: expect.stringContaining("expandedProjects"),
			});
			expect(postSpy).not.toHaveBeenCalled();

			await program.parseAsync([
				"node",
				"cli",
				"application",
				"mark-running",
				"--applicationId",
				"app-allowed",
			]);
			expect(postSpy).toHaveBeenCalledWith("application.markRunning", {
				applicationId: "app-allowed",
			});
			expect(getSpy).toHaveBeenCalledWith("application.one", {
				applicationId: "app-allowed",
			});

			await program.parseAsync([
				"node",
				"cli",
				"application",
				"mark-running",
				"--applicationId",
				"app-catalog",
			]);
			expect(postSpy).toHaveBeenCalledWith("application.markRunning", {
				applicationId: "app-catalog",
			});
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	describe("deploy-project application configuration", () => {
		const deployPolicy = {
			projects: [
				{
					projectName: "agent_sandbox",
					projectId: "proj-agent",
					environmentName: "production",
					environmentId: "env-agent",
				},
			],
			servers: [],
			allowAnyServer: true,
			domainSuffixes: [".example.com"],
			expandedProjects: [],
			expandedApplicationIds: [],
			expandedApplicationNames: [],
		};
		const records: Record<string, any> = {
			"app-new": {
				name: "sample-repo",
				environmentId: "env-agent",
				environment: {
					name: "production",
					project: { name: "agent_sandbox", projectId: "proj-agent" },
				},
			},
			// same name and description an agent would set, other project
			"app-other": {
				name: "sample-repo",
				description: "created by dokploy-agent",
				environmentId: "env-other",
				environment: {
					name: "production",
					project: { name: "storefront", projectId: "proj-other" },
				},
			},
			// renamed project lookalike: deploy project name, other ids
			"app-lookalike": {
				name: "sample-repo",
				environmentId: "env-lookalike",
				environment: {
					name: "production",
					project: { name: "agent_sandbox", projectId: "proj-lookalike" },
				},
			},
		};
		const githubArgs = (applicationId: string, githubId = "gh-1") => [
			"node",
			"cli",
			"application",
			"save-github-provider",
			"--applicationId",
			applicationId,
			"--githubId",
			githubId,
			"--owner",
			"hamidzr",
			"--repository",
			"sample-repo",
			"--branch",
			"main",
			"--buildPath",
			"/",
			"--triggerType",
			"push",
		];

		async function setup() {
			const loaded = await loadAgentSafeGeneratedCommands();
			const program = new Command();
			loaded.registerGeneratedCommands(program);
			vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue(
				deployPolicy,
			);
			vi.spyOn(client, "apiGet").mockImplementation(async (endpoint, opts) => {
				if (endpoint === "github.githubProviders")
					return [{ githubId: "gh-1" }];
				return records[opts?.applicationId as string];
			});
			const postSpy = vi
				.spyOn(client, "apiPost")
				.mockImplementation(async (endpoint) =>
					endpoint === "application.create"
						? { applicationId: "app-new", environmentId: "env-agent" }
						: true,
				);
			return { program, postSpy, tempDir: loaded.tempDir };
		}

		it("lets agents configure applications they created", async () => {
			const { program, postSpy, tempDir } = await setup();
			try {
				await program.parseAsync([
					"node",
					"cli",
					"application",
					"create",
					"--name",
					"sample-repo",
				]);
				expect(postSpy).toHaveBeenCalledWith(
					"application.create",
					expect.objectContaining({ environmentId: "env-agent" }),
				);

				await program.parseAsync(githubArgs("app-new"));
				expect(postSpy).toHaveBeenCalledWith(
					"application.saveGithubProvider",
					expect.objectContaining({
						applicationId: "app-new",
						githubId: "gh-1",
						owner: "hamidzr",
						repository: "sample-repo",
					}),
				);

				await program.parseAsync([
					"node",
					"cli",
					"application",
					"kill-build",
					"--applicationId",
					"app-new",
				]);
				expect(postSpy).toHaveBeenCalledWith("application.killBuild", {
					applicationId: "app-new",
				});
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		}, 15_000);

		it("keeps destructive and protected operations expanded-only", async () => {
			const { program, postSpy, tempDir } = await setup();
			try {
				for (const args of [
					["delete", "--applicationId", "app-new"],
					["move", "--applicationId", "app-new", "--targetEnvironmentId", "x"],
					["disconnect-git-provider", "--applicationId", "app-new"],
					[
						"save-docker-provider",
						"--applicationId",
						"app-new",
						"--dockerImage",
						"nginx",
						"--password",
						"pw",
					],
				]) {
					await expect(
						program.parseAsync(["node", "cli", "application", ...args]),
					).rejects.toMatchObject({
						code: "AGENT_POLICY_BLOCKED",
						exitCode: 2,
					});
				}
				expect(postSpy).not.toHaveBeenCalled();
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		}, 15_000);

		it("blocks apps outside deploy projects, lookalikes, and unknown providers", async () => {
			const { program, postSpy, tempDir } = await setup();
			try {
				await expect(
					program.parseAsync(githubArgs("app-other")),
				).rejects.toMatchObject({
					code: "AGENT_POLICY_BLOCKED",
					message: expect.stringContaining("rejects application app-other"),
				});
				await expect(
					program.parseAsync(githubArgs("app-lookalike")),
				).rejects.toMatchObject({
					code: "AGENT_POLICY_BLOCKED",
					message: expect.stringContaining("rejects application app-lookalike"),
				});
				await expect(
					program.parseAsync(githubArgs("app-new", "gh-unknown")),
				).rejects.toMatchObject({
					code: "AGENT_POLICY_BLOCKED",
					message: expect.stringContaining("githubId gh-unknown"),
				});
				await expect(
					program.parseAsync([
						"node",
						"cli",
						"application",
						"update",
						"--applicationId",
						"app-new",
						"--githubId",
						"gh-unknown",
					]),
				).rejects.toMatchObject({
					code: "AGENT_POLICY_BLOCKED",
					message: expect.stringContaining("githubId gh-unknown"),
				});
				expect(postSpy).not.toHaveBeenCalled();
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		}, 15_000);
	});

	describe("watchPaths-only writes outside the deploy perimeter", () => {
		const outside = {
			environmentId: "env-other",
			environment: {
				name: "production",
				project: { name: "storefront", projectId: "proj-other" },
			},
			serverId: "srv-other",
		};
		const records: Record<string, any> = {
			"app-github": {
				...outside,
				name: "backend",
				sourceType: "github",
				repository: "repo",
				owner: "me",
				buildPath: "/",
				githubId: "gh-1",
				branch: "main",
				triggerType: "push",
				enableSubmodules: false,
				watchPaths: ["old/**"],
			},
			"app-gitlab": {
				...outside,
				name: "gl",
				sourceType: "gitlab",
				repository: null,
				owner: null,
				buildPath: "/",
				githubId: null,
				branch: "main",
				triggerType: "push",
			},
			"compose-github": { ...outside, name: "stack", sourceType: "github" },
			"compose-raw": { ...outside, name: "raw", sourceType: "raw" },
		};

		async function setup() {
			const loaded = await loadAgentSafeGeneratedCommands();
			const program = new Command();
			loaded.registerGeneratedCommands(program);
			vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
				projects: [
					{
						projectName: "agent_sandbox",
						projectId: "proj-agent",
						environmentName: "production",
						environmentId: "env-agent",
					},
				],
				servers: [{ serverId: "srv-agent" }],
				domainSuffixes: [".example.com"],
				expandedProjects: [],
				expandedApplicationIds: [],
				expandedApplicationNames: [],
			});
			vi.spyOn(client, "apiGet").mockImplementation(
				async (_endpoint, opts) =>
					records[(opts?.applicationId ?? opts?.composeId) as string],
			);
			const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue(true);
			return { program, postSpy, tempDir: loaded.tempDir };
		}

		const run = (program: Command, ...args: string[]) =>
			program.parseAsync(["node", "cli", ...args]);

		it("allows watchPaths alone on any git-backed service", async () => {
			const { program, postSpy, tempDir } = await setup();
			try {
				await run(
					program,
					"application",
					"save-github-provider",
					"--applicationId",
					"app-github",
					"--watchPaths",
					'["backend/**","!backend/**/*.md"]',
				);
				// record fill keeps every other provider field at its stored value
				expect(postSpy).toHaveBeenLastCalledWith(
					"application.saveGithubProvider",
					{
						applicationId: "app-github",
						repository: "repo",
						owner: "me",
						buildPath: "/",
						githubId: "gh-1",
						branch: "main",
						triggerType: "push",
						watchPaths: ["backend/**", "!backend/**/*.md"],
					},
				);

				await run(
					program,
					"compose",
					"update",
					"--composeId",
					"compose-github",
					"--watchPaths",
					"[]",
				);
				expect(postSpy).toHaveBeenLastCalledWith("compose.update", {
					composeId: "compose-github",
					watchPaths: [],
				});
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		}, 15_000);

		it("falls back to the perimeter guards for any other field", async () => {
			const { program, postSpy, tempDir } = await setup();
			try {
				for (const args of [
					[
						"application",
						"save-github-provider",
						"--applicationId",
						"app-github",
						"--branch",
						"main",
					],
					[
						"application",
						"save-github-provider",
						"--applicationId",
						"app-github",
						"--watchPaths",
						'["src/**"]',
						"--branch",
						"release",
					],
					[
						"application",
						"save-github-provider",
						"--applicationId",
						"app-github",
						"--watchPaths",
						'["src/**"]',
						"--buildPath",
						"/other",
					],
					[
						"application",
						"save-github-provider",
						"--applicationId",
						"app-github",
						"--watchPaths",
						'["src/**"]',
						"--enableSubmodules",
					],
					[
						"compose",
						"update",
						"--composeId",
						"compose-github",
						"--watchPaths",
						'["src/**"]',
						"--composeFile",
						"services: {}",
					],
					[
						"application",
						"update",
						"--applicationId",
						"app-github",
						"--watchPaths",
						'["src/**"]',
					],
				]) {
					await expect(run(program, ...args)).rejects.toMatchObject({
						code: "AGENT_POLICY_BLOCKED",
						exitCode: 2,
					});
				}
				expect(postSpy).not.toHaveBeenCalled();
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		}, 15_000);

		it("rejects a provider endpoint that would switch the source", async () => {
			const { program, postSpy, tempDir } = await setup();
			try {
				await expect(
					run(
						program,
						"application",
						"save-github-provider",
						"--applicationId",
						"app-gitlab",
						"--watchPaths",
						'["src/**"]',
					),
				).rejects.toMatchObject({
					code: "AGENT_POLICY_BLOCKED",
					message: expect.stringContaining(
						"watchPaths-only exception does not apply: application app-gitlab has sourceType gitlab",
					),
				});
				await expect(
					run(
						program,
						"compose",
						"update",
						"--composeId",
						"compose-raw",
						"--watchPaths",
						'["src/**"]',
					),
				).rejects.toMatchObject({
					code: "AGENT_POLICY_BLOCKED",
					message: expect.stringContaining("has sourceType raw"),
				});
				expect(postSpy).not.toHaveBeenCalled();
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		}, 15_000);

		it("rejects watch paths Dokploy can never match", async () => {
			const { program, postSpy, tempDir } = await setup();
			try {
				for (const watchPaths of [
					'["/src/**"]',
					'["src/"]',
					'["!/x/**"]',
					'[""]',
				]) {
					await expect(
						run(
							program,
							"compose",
							"update",
							"--composeId",
							"compose-github",
							"--watchPaths",
							watchPaths,
						),
					).rejects.toMatchObject({ code: "INVALID_WATCH_PATHS" });
				}
				expect(postSpy).not.toHaveBeenCalled();
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		}, 15_000);
	});

	it("allows lifecycle operations on deploy-project services", async () => {
		const { registerGeneratedCommands, tempDir } =
			await loadAgentSafeGeneratedCommands();
		try {
			const program = new Command();
			vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
				projects: [
					{
						projectName: "agent-project",
						environmentName: "production",
						environmentId: "env-1",
					},
				],
				servers: [{ serverId: "srv-allowed" }],
				domainSuffixes: [".example.com"],
				expandedProjects: [],
				expandedApplicationIds: [],
				expandedApplicationNames: [],
			});
			vi.spyOn(client, "apiGet").mockImplementation(async (_endpoint, opts) => {
				const id = Object.values(opts ?? {})[0];
				return {
					appName: `${id}-name`,
					environmentId: id === "other" ? "env-2" : "env-1",
					environment: {
						name: "production",
						project: { name: "agent-project" },
					},
					serverId: "srv-allowed",
				};
			});
			const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue(true);
			registerGeneratedCommands(program);
			const run = (...args: string[]) =>
				program.parseAsync(["node", "cli", ...args]);

			await run("application", "start", "--applicationId", "app-1");
			await run("compose", "stop", "--composeId", "compose-1");
			await run(
				"postgres",
				"reload",
				"--postgresId",
				"pg-1",
				"--appName",
				"pg-1-name",
			);
			expect(postSpy.mock.calls.map((call) => call[0])).toEqual([
				"application.start",
				"compose.stop",
				"postgres.reload",
			]);

			await expect(
				run("compose", "start", "--composeId", "other"),
			).rejects.toMatchObject({
				code: "AGENT_POLICY_BLOCKED",
				message: expect.stringContaining("rejects compose other"),
			});
			await expect(
				run(
					"postgres",
					"reload",
					"--postgresId",
					"pg-1",
					"--appName",
					"someone-else",
				),
			).rejects.toMatchObject({
				code: "AGENT_POLICY_BLOCKED",
				message: expect.stringContaining("appName to match postgres pg-1"),
			});
			expect(postSpy).toHaveBeenCalledTimes(3);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("guards volume backup writes with the parent service policy", async () => {
		const { registerGeneratedCommands, tempDir } =
			await loadAgentSafeGeneratedCommands();
		try {
			const program = new Command();
			vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
				projects: [
					{
						projectName: "agent-project",
						environmentName: "production",
						environmentId: "env-1",
					},
				],
				servers: [{ serverId: "srv-allowed" }],
				domainSuffixes: [".example.com"],
				expandedProjects: [{ projectName: "my-app" }],
				expandedApplicationIds: [],
				expandedApplicationNames: [],
			});
			vi.spyOn(client, "apiGet").mockImplementation(async (endpoint, opts) => {
				if (endpoint === "application.one") {
					if (opts?.applicationId === "app-allowed") {
						return {
							environmentId: "env-1",
							environment: {
								name: "production",
								project: { name: "agent-project" },
							},
							serverId: "srv-allowed",
						};
					}
					if (opts?.applicationId === "app-expanded") {
						return {
							name: "api",
							environmentId: "env-other",
							environment: {
								name: "production",
								project: { name: "my-app" },
							},
							serverId: "srv-allowed",
						};
					}
					return {
						name: "web",
						environmentId: "env-other",
						environment: {
							name: "production",
							project: { name: "unrelated" },
						},
						serverId: "srv-allowed",
					};
				}
				if (endpoint === "postgres.one") {
					if (opts?.postgresId === "pg-allowed") {
						return {
							environmentId: "env-1",
							environment: {
								name: "production",
								project: { name: "agent-project" },
							},
							serverId: "srv-allowed",
						};
					}
					return {
						environmentId: "env-other",
						environment: {
							name: "production",
							project: { name: "unrelated" },
						},
						serverId: "srv-allowed",
					};
				}
				if (endpoint === "volumeBackups.one") {
					if (opts?.volumeBackupId === "vb-allowed") {
						return {
							applicationId: "app-allowed",
							serviceType: "application",
						};
					}
					return {
						applicationId: "app-blocked",
						serviceType: "application",
					};
				}
				throw new Error(`unexpected endpoint ${endpoint}`);
			});
			const postSpy = vi
				.spyOn(client, "apiPost")
				.mockResolvedValue({ ok: true });

			registerGeneratedCommands(program);

			await expect(
				program.parseAsync([
					"node",
					"cli",
					"volume-backups",
					"create",
					"--name",
					"sqlite",
					"--volumeName",
					"app-data",
					"--prefix",
					"sqlite",
					"--cronExpression",
					"0 3 * * *",
					"--destinationId",
					"dest-1",
				]),
			).rejects.toThrow("requires a parent service id");
			expect(postSpy).not.toHaveBeenCalled();

			await expect(
				program.parseAsync([
					"node",
					"cli",
					"volume-backups",
					"create",
					"--name",
					"sqlite",
					"--volumeName",
					"app-data",
					"--prefix",
					"sqlite",
					"--cronExpression",
					"0 3 * * *",
					"--destinationId",
					"dest-1",
					"--applicationId",
					"app-blocked",
				]),
			).rejects.toThrow("allowed projects");
			expect(postSpy).not.toHaveBeenCalled();

			await program.parseAsync([
				"node",
				"cli",
				"volume-backups",
				"create",
				"--name",
				"sqlite",
				"--volumeName",
				"app-data",
				"--prefix",
				"sqlite",
				"--cronExpression",
				"0 3 * * *",
				"--destinationId",
				"dest-1",
				"--applicationId",
				"app-allowed",
			]);
			expect(postSpy).toHaveBeenCalledWith("volumeBackups.create", {
				name: "sqlite",
				volumeName: "app-data",
				prefix: "sqlite",
				cronExpression: "0 3 * * *",
				destinationId: "dest-1",
				applicationId: "app-allowed",
			});

			await program.parseAsync([
				"node",
				"cli",
				"volume-backups",
				"create",
				"--name",
				"sqlite",
				"--volumeName",
				"app-data",
				"--prefix",
				"sqlite",
				"--cronExpression",
				"0 3 * * *",
				"--destinationId",
				"dest-1",
				"--applicationId",
				"app-expanded",
			]);
			expect(postSpy).toHaveBeenCalledWith("volumeBackups.create", {
				name: "sqlite",
				volumeName: "app-data",
				prefix: "sqlite",
				cronExpression: "0 3 * * *",
				destinationId: "dest-1",
				applicationId: "app-expanded",
			});

			await program.parseAsync([
				"node",
				"cli",
				"volume-backups",
				"create",
				"--name",
				"pg-data",
				"--volumeName",
				"pg-data",
				"--prefix",
				"pg",
				"--cronExpression",
				"0 3 * * *",
				"--destinationId",
				"dest-1",
				"--serviceType",
				"postgres",
				"--postgresId",
				"pg-allowed",
			]);
			expect(postSpy).toHaveBeenCalledWith("volumeBackups.create", {
				name: "pg-data",
				volumeName: "pg-data",
				prefix: "pg",
				cronExpression: "0 3 * * *",
				destinationId: "dest-1",
				serviceType: "postgres",
				postgresId: "pg-allowed",
			});

			await expect(
				program.parseAsync([
					"node",
					"cli",
					"volume-backups",
					"run-manually",
					"--volumeBackupId",
					"vb-blocked",
				]),
			).rejects.toThrow("allowed projects");

			await program.parseAsync([
				"node",
				"cli",
				"volume-backups",
				"run-manually",
				"--volumeBackupId",
				"vb-allowed",
			]);
			expect(postSpy).toHaveBeenCalledWith("volumeBackups.runManually", {
				volumeBackupId: "vb-allowed",
			});
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("allows only unused domain hosts from the configured wildcard", async () => {
		const { registerGeneratedCommands, tempDir } =
			await loadAgentSafeGeneratedCommands();
		try {
			const program = new Command();
			vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
				projects: [
					{
						projectName: "agent-project",
						environmentName: "production",
						environmentId: "env-1",
					},
				],
				servers: [{ serverId: "srv-allowed" }],
				domainSuffixes: [".apps.example.net"],
				expandedProjects: [],
				expandedApplicationIds: [],
				expandedApplicationNames: [],
			});
			vi.spyOn(client, "apiGet").mockImplementation(async (endpoint) => {
				if (endpoint === "application.one") {
					return {
						environmentId: "env-1",
						environment: {
							project: { name: "agent-project" },
						},
						serverId: "srv-allowed",
					};
				}
				if (endpoint === "project.all") {
					return [
						{
							environments: [
								{
									applications: [
										{
											domains: [{ host: "USED.apps.example.net." }],
										},
									],
								},
							],
						},
					];
				}
				throw new Error(`unexpected endpoint ${endpoint}`);
			});
			const postSpy = vi
				.spyOn(client, "apiPost")
				.mockResolvedValue({ ok: true });

			registerGeneratedCommands(program);
			await expect(
				program.parseAsync([
					"node",
					"cli",
					"domain",
					"create",
					"--applicationId",
					"app-1",
					"--host",
					"used.apps.example.net",
				]),
			).rejects.toThrow("domain is already in use in Dokploy");
			expect(postSpy).not.toHaveBeenCalled();

			await program.parseAsync([
				"node",
				"cli",
				"domain",
				"create",
				"--applicationId",
				"app-1",
				"--host",
				"new.apps.example.net",
			]);
			expect(postSpy).toHaveBeenCalledWith("domain.create", {
				applicationId: "app-1",
				host: "new.apps.example.net",
			});
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("deletes only agent-pattern domains on deploy-project services", async () => {
		const { registerGeneratedCommands, tempDir } =
			await loadAgentSafeGeneratedCommands();
		try {
			const program = new Command();
			vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
				projects: [
					{
						projectName: "agent-project",
						environmentName: "production",
						environmentId: "env-1",
					},
				],
				servers: [{ serverId: "srv-allowed" }],
				domainSuffixes: [".example.com"],
				expandedProjects: [{ projectName: "my-app" }],
				expandedApplicationIds: [],
				expandedApplicationNames: [],
			});
			const domains: Record<string, Record<string, string>> = {
				"dom-agent": { applicationId: "app-agent", host: "demo.example.com" },
				"dom-custom": { applicationId: "app-agent", host: "my-app.com" },
				"dom-expanded": {
					applicationId: "app-expanded",
					host: "my-app.example.com",
				},
				"dom-other": { composeId: "compose-other", host: "x.example.com" },
			};
			vi.spyOn(client, "apiGet").mockImplementation(async (endpoint, opts) => {
				if (endpoint === "domain.one") return domains[String(opts?.domainId)];
				const id = String(Object.values(opts ?? {})[0]);
				return {
					name: id,
					environmentId: id === "app-agent" ? "env-1" : "env-2",
					environment: {
						name: "production",
						project: {
							name: id === "app-expanded" ? "my-app" : "agent-project",
						},
					},
					serverId: "srv-allowed",
				};
			});
			const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue(true);
			registerGeneratedCommands(program);
			const run = (domainId: string) =>
				program.parseAsync([
					"node",
					"cli",
					"domain",
					"delete",
					"--domainId",
					domainId,
				]);

			await run("dom-agent");
			expect(postSpy).toHaveBeenCalledWith("domain.delete", {
				domainId: "dom-agent",
			});
			await expect(run("dom-custom")).rejects.toMatchObject({
				code: "AGENT_POLICY_BLOCKED",
				message: expect.stringContaining("rejects host my-app.com"),
			});
			await expect(run("dom-expanded")).rejects.toMatchObject({
				code: "AGENT_POLICY_BLOCKED",
				message: expect.stringContaining("rejects application app-expanded"),
			});
			await expect(run("dom-other")).rejects.toMatchObject({
				code: "AGENT_POLICY_BLOCKED",
				message: expect.stringContaining("rejects compose compose-other"),
			});
			expect(postSpy).toHaveBeenCalledOnce();
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("throws a typed error for blocked agent-safe commands", async () => {
		const { registerGeneratedCommands, tempDir } =
			await loadAgentSafeGeneratedCommands();
		try {
			const program = new Command();
			registerGeneratedCommands(program);

			await expect(
				program.parseAsync(["node", "cli", "domain", "update", "--json"]),
			).rejects.toMatchObject({
				code: "AGENT_POLICY_BLOCKED",
				exitCode: 2,
			});

			const getSpy = vi.spyOn(client, "apiGet");
			for (const [group, action] of [
				["docker", "read-container-file"],
				["docker-volume", "read-volume-file"],
			]) {
				await expect(
					program.parseAsync(["node", "cli", group, action, "--path", "/x"]),
				).rejects.toMatchObject({
					code: "AGENT_POLICY_BLOCKED",
					exitCode: 2,
					message: expect.stringContaining("raw file contents"),
				});
			}
			expect(getSpy).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("allows explicit or local servers with wildcard policy", async () => {
		const { registerGeneratedCommands, tempDir } =
			await loadAgentSafeGeneratedCommands();
		try {
			const program = new Command();
			vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
				projects: [
					{
						projectName: "agent-project",
						environmentName: "production",
						environmentId: "env-1",
					},
				],
				servers: [],
				allowAnyServer: true,
				domainSuffixes: [".example.com"],
				expandedProjects: [],
				expandedApplicationIds: [],
				expandedApplicationNames: [],
			});
			const postSpy = vi
				.spyOn(client, "apiPost")
				.mockResolvedValue({ ok: true });

			registerGeneratedCommands(program);
			await program.parseAsync([
				"node",
				"cli",
				"application",
				"create",
				"--name",
				"remote-app",
				"--serverId",
				"srv-any",
			]);
			expect(postSpy).toHaveBeenCalledWith("application.create", {
				name: "remote-app",
				environmentId: "env-1",
				serverId: "srv-any",
			});

			await program.parseAsync([
				"node",
				"cli",
				"application",
				"create",
				"--name",
				"local-app",
			]);
			expect(postSpy).toHaveBeenCalledWith("application.create", {
				name: "local-app",
				environmentId: "env-1",
			});
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("rejects disallowed buildServerId option in agent-safe application.update", async () => {
		const { registerGeneratedCommands, tempDir } =
			await loadAgentSafeGeneratedCommands();
		try {
			const program = new Command();
			const policy = {
				projects: [
					{
						projectName: "agent-project",
						environmentName: "production",
						environmentId: "env-1",
					},
				],
				servers: [{ serverId: "srv-allowed" }],
				domainSuffixes: [".example.com"],
				expandedProjects: [],
				expandedApplicationIds: [],
				expandedApplicationNames: [],
			};

			vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue(policy);
			const apiPostSpy = vi
				.spyOn(client, "apiPost")
				.mockResolvedValue({ ok: true });
			vi.spyOn(client, "apiGet").mockResolvedValue({
				environmentId: "env-1",
				environment: {
					project: { name: "agent-project", projectId: "proj-1" },
					name: "production",
				},
				serverId: "srv-allowed",
				buildServerId: "srv-forbidden",
			});

			registerGeneratedCommands(program);
			await expect(
				program.parseAsync([
					"node",
					"cli",
					"application",
					"update",
					"--applicationId",
					"app-1",
					"--buildServerId",
					"srv-forbidden",
				]),
			).rejects.toThrow("buildServerId");
			expect(apiPostSpy).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects resolved nested disallowed build server in existing service", async () => {
		const { registerGeneratedCommands, tempDir } =
			await loadAgentSafeGeneratedCommands();
		try {
			const program = new Command();
			const policy = {
				projects: [
					{
						projectName: "agent-project",
						environmentName: "production",
						environmentId: "env-1",
					},
				],
				servers: [{ serverId: "srv-allowed" }],
				domainSuffixes: [".example.com"],
				expandedProjects: [],
				expandedApplicationIds: [],
				expandedApplicationNames: [],
			};

			vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue(policy);
			const apiGetSpy = vi.spyOn(client, "apiGet").mockResolvedValue({
				environmentId: "env-1",
				environment: {
					project: { name: "agent-project" },
					name: "production",
				},
				serverId: "srv-allowed",
				buildServerId: "srv-forbidden",
			});
			const apiPostSpy = vi
				.spyOn(client, "apiPost")
				.mockResolvedValue({ ok: true });

			registerGeneratedCommands(program);
			await expect(
				program.parseAsync([
					"node",
					"cli",
					"application",
					"update",
					"--applicationId",
					"app-1",
				]),
			).rejects.toThrow("buildServerId");
			expect(apiGetSpy).toHaveBeenCalled();
			expect(apiPostSpy).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("approval for perimeter misses", () => {
	const outside = {
		environmentId: "env-other",
		environment: {
			name: "production",
			project: { name: "storefront", projectId: "proj-other" },
		},
		serverId: "srv-agent",
	};
	const kutt = {
		...outside,
		name: "kutt",
		appName: "kutt-a1b2c3",
		sourceType: "raw",
		composeType: "docker-compose",
		composeFile: [
			"services:",
			"  app:",
			"    image: kutt/kutt:v2",
			"    environment:",
			"      DB_PASSWORD=hunter2hunter2hunter2",
			"      SITE_NAME=kutt",
			"  redis:",
			"    image: redis:7",
			"volumes: {}",
		].join("\n"),
	};

	// records the dialog text and answers with the given result
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

	// reads return each queued record once, then the last one
	async function setup(
		records: Record<string, any>[],
		approval?: client.AgentApprovalConfig,
	) {
		const loaded = await loadAgentSafeGeneratedCommands();
		const program = new Command();
		loaded.registerGeneratedCommands(program);
		vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
			projects: [
				{
					projectName: "agent_sandbox",
					projectId: "proj-agent",
					environmentName: "production",
					environmentId: "env-agent",
				},
			],
			servers: [{ serverId: "srv-agent" }],
			domainSuffixes: [".example.com"],
			expandedProjects: [],
			expandedApplicationIds: [],
			expandedApplicationNames: [],
			approval,
		});
		const queue = [...records];
		const getSpy = vi
			.spyOn(client, "apiGet")
			.mockImplementation(async (endpoint) =>
				endpoint === "project.all"
					? []
					: queue.length > 1
						? queue.shift()
						: queue[0],
			);
		const postSpy = vi.spyOn(client, "apiPost").mockResolvedValue(true);
		vi.spyOn(console, "log").mockImplementation(() => {});
		return { program, postSpy, getSpy, tempDir: loaded.tempDir };
	}

	const run = (program: Command, ...args: string[]) =>
		program.parseAsync(["node", "cli", ...args]);

	afterEach(() => {
		vi.mocked(backends.detectApprovalBackend).mockReset();
		vi.mocked(backends.detectApprovalBackend).mockReturnValue(undefined);
	});

	it("writes a field change after the user approves its diff", async () => {
		const dialogs = answerDialog("approved");
		const { program, postSpy, tempDir } = await setup([kutt]);
		try {
			await run(
				program,
				"compose",
				"update",
				"--composeId",
				"compose-kutt",
				"--composeType",
				"stack",
				"--reason",
				"swarm overlay networks need a stack",
			);
			expect(postSpy).toHaveBeenCalledExactlyOnceWith("compose.update", {
				composeId: "compose-kutt",
				composeType: "stack",
			});
			expect(dialogs).toHaveLength(1);
			expect(dialogs[0]).toContain("Approve update on compose kutt?");
			expect(dialogs[0]).toContain(
				"compose: kutt / kutt-a1b2c3 (compose-kutt)",
			);
			expect(dialogs[0]).toContain("project: storefront/production");
			expect(dialogs[0]).toContain(
				"- composeType: docker-compose\n+ composeType: stack",
			);
			expect(dialogs[0]).toContain("swarm overlay networks need a stack");
			expect(dialogs[0]).toContain(
				"rejects compose compose-kutt in storefront",
			);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("shows multi-line fields as a line diff with stored secrets masked", async () => {
		const dialogs = answerDialog("approved");
		const { program, postSpy, tempDir } = await setup([kutt]);
		const nextFile = kutt.composeFile
			.replace("kutt/kutt:v2", "kutt/kutt:v3")
			.replace(
				"DB_PASSWORD=hunter2hunter2hunter2",
				"DB_PASSWORD=n3w-s3cret-value",
			);
		try {
			await run(
				program,
				"compose",
				"update",
				"--composeId",
				"compose-kutt",
				"--composeFile",
				nextFile,
			);
			expect(postSpy).toHaveBeenCalledOnce();
			const dialog = dialogs[0];
			expect(dialog).toContain(
				[
					"  composeFile:",
					"  ...",
					"    app:",
					"-     image: kutt/kutt:v2",
					"+     image: kutt/kutt:v3",
					"      environment:",
				].join("\n"),
			);
			expect(dialog).toContain("+       DB_PASSWORD=n3w-s3cret-value");
			expect(dialog).toMatch(/- {7}DB_PASSWORD=hunt\*\*\*/);
			expect(dialog).not.toContain("hunter2hunter2hunter2");
			expect(dialog).not.toContain("redis:7");
			const audit = fs.readFileSync(
				path.join(
					process.env.XDG_STATE_HOME as string,
					"dokploy-agent",
					"approvals.jsonl",
				),
				"utf8",
			);
			expect(audit).toContain('"fields":["composeFile"]');
			expect(audit).not.toContain("n3w-s3cret-value");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("names the router in titles for writes through another router", async () => {
		const dialogs = answerDialog("approved");
		const { program, postSpy, tempDir } = await setup([kutt]);
		try {
			await run(
				program,
				"domain",
				"create",
				"--composeId",
				"compose-kutt",
				"--host",
				"kutt.example.com",
			);
			expect(dialogs).toHaveLength(1);
			expect(dialogs[0]).toContain("Approve domain create on compose kutt?");
			expect(postSpy).toHaveBeenCalledOnce();
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("asks once for a deploy with no fields", async () => {
		const dialogs = answerDialog("approved");
		const { program, postSpy, tempDir } = await setup([kutt]);
		try {
			await run(program, "compose", "deploy", "--composeId", "compose-kutt");
			expect(dialogs).toHaveLength(1);
			expect(dialogs[0]).toContain("Approve deploy on compose kutt?");
			expect(dialogs[0]).toContain("  run compose.deploy");
			expect(postSpy).toHaveBeenCalledExactlyOnceWith("compose.deploy", {
				composeId: "compose-kutt",
			});
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("writes nothing when the user denies or the record changed", async () => {
		const { program, postSpy, tempDir } = await setup([
			kutt,
			kutt,
			{ ...kutt, composeType: "stack" },
		]);
		const args = [
			"compose",
			"update",
			"--composeId",
			"compose-kutt",
			"--composeType",
			"stack",
		];
		try {
			answerDialog("denied");
			await expect(run(program, ...args)).rejects.toMatchObject({
				code: "AGENT_APPROVAL_DENIED",
				exitCode: 2,
			});
			answerDialog("approved");
			await expect(run(program, ...args)).rejects.toMatchObject({
				code: "AGENT_APPROVAL_STALE",
			});
			expect(postSpy).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("keeps hard checks and non-approvable endpoints as plain denials", async () => {
		const dialogs = answerDialog("approved");
		const { program, postSpy, tempDir } = await setup([
			{ ...kutt, domains: [] },
		]);
		try {
			for (const [args, message] of [
				[
					[
						"compose",
						"update",
						"--composeId",
						"compose-kutt",
						"--githubId",
						"gh-unknown",
					],
					"not a git provider configured",
				],
				[
					[
						"domain",
						"create",
						"--composeId",
						"compose-kutt",
						"--host",
						"kutt.example.net",
					],
					"rejects host kutt.example.net",
				],
				[
					[
						"compose",
						"create",
						"--name",
						"kutt2",
						"--environmentId",
						"env-other",
					],
					"rejects environmentId env-other",
				],
			] as const) {
				await expect(run(program, ...args)).rejects.toMatchObject({
					code: "AGENT_POLICY_BLOCKED",
					message: expect.stringContaining(message),
				});
			}
			expect(dialogs).toHaveLength(0);
			expect(postSpy).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("keeps the denial when approval is disabled", async () => {
		const dialogs = answerDialog("approved");
		const { program, postSpy, tempDir } = await setup([kutt], {
			enabled: false,
			timeoutSeconds: 90,
		});
		try {
			await expect(
				run(program, "compose", "deploy", "--composeId", "compose-kutt"),
			).rejects.toMatchObject({
				code: "AGENT_POLICY_BLOCKED",
				message: expect.stringContaining("rejects compose compose-kutt"),
			});
			expect(dialogs).toHaveLength(0);
			expect(postSpy).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, 15_000);
});
