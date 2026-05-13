import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

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

	it("number of apiPost/apiGet calls should match valid endpoints", () => {
		const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
		const content = fs.readFileSync(generatedPath, "utf8");

		// Count only endpoints with group.action pattern
		let validEndpoints = 0;
		for (const p of Object.keys(spec.paths)) {
			const clean = p.replace(/^\//, "");
			const [group, ...rest] = clean.split(".");
			if (group && rest.length > 0) validEndpoints++;
		}

		const apiCalls = (content.match(/await api(Post|Get)\(/g) || []).length;
		expect(apiCalls).toBe(validEndpoints);
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
			expect(content).toContain("command('state')");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

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
	});

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
			expect(generatedContent).not.toContain(
				'apiPost("application.saveDockerProvider"',
			);
			expect(generatedContent).not.toContain(
				'apiPost("application.saveGitProvider"',
			);
			expect(generatedContent).not.toContain('apiPost("domain.delete"');
			expect(generatedContent).toContain("guardAgentSafePost");
			expect(generatedContent).toContain("command('deploy-policy')");
			expect(generatedContent).toContain("readAgentDeployPolicyConfig");
			expect(generatedContent).toContain("policy.projects");
			expect(generatedContent).toContain("policy.servers");
			expect(generatedContent).toContain("policy.domainSuffixes");
			expect(generatedContent).toContain("policy.domainNameSuffix");
			expect(generatedContent).toContain("requires domain names ending with");
			expect(fs.readFileSync(generatedPath, "utf8")).toBe(before);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
