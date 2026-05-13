import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist", "index.js");

function run(...args: string[]): string {
	return execFileSync("node", [CLI, ...args], {
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
	});
}

interface FailedCommand {
	stdout: string;
	stderr: string;
	status: number;
}

function runFail(...args: string[]): FailedCommand {
	try {
		run(...args);
	} catch (err) {
		const error = err as {
			stdout?: string;
			stderr?: string;
			status?: number;
		};
		return {
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
			status: error.status ?? 1,
		};
	}
	throw new Error("command succeeded unexpectedly");
}

describe("CLI", () => {
	it("should show help with --help", () => {
		const output = run("--help");
		expect(output).toContain("Dokploy CLI");
		expect(output).toContain("auth");
		expect(output).toContain("application");
		expect(output).toContain("project");
	});

	it("should show version with build metadata", () => {
		const output = run("--version").trim();
		expect(output).toMatch(
			/^\d+\.\d+\.\d+ \(commit ([0-9a-f]{7,12}|unknown), built .+, mode full\)$/,
		);
	});

	it("should show subcommands for application", () => {
		const output = run("application", "--help");
		expect(output).toContain("create");
		expect(output).toContain("deploy");
		expect(output).toContain("delete");
		expect(output).toContain("stop");
	});

	it("should show subcommands for postgres", () => {
		const output = run("postgres", "--help");
		expect(output).toContain("create");
		expect(output).toContain("deploy");
		expect(output).toContain("remove");
	});

	it("should show options for a specific command", () => {
		const output = run("application", "create", "--help");
		expect(output).toContain("--name");
		expect(output).toContain("--environmentId");
	});

	it("should show deployment log command options", () => {
		const output = run("deployment", "read-logs", "--help");
		expect(output).toContain("--logPath");
		expect(output).toContain("--deploymentId");
		expect(output).toContain("--tail");
	});

	it("should show inventory aliases clearly", () => {
		const output = run("--help");
		expect(output).toContain("service");
		expect(output).toContain("alias for service list");

		const applicationOutput = run("application", "--help");
		expect(applicationOutput).toContain(
			"alias: flattened application inventory",
		);

		const composeOutput = run("compose", "--help");
		expect(composeOutput).toContain("alias: flattened compose inventory");
		expect(composeOutput).toContain("effective");
		expect(composeOutput).toContain("summary");
	});

	it("should show auth command options", () => {
		const output = run("auth", "--help");
		expect(output).toContain("--url");
		expect(output).toContain("--token");
	});

	it("should show all expected command groups", () => {
		const output = run("--help");
		const expectedGroups = [
			"application",
			"postgres",
			"mysql",
			"redis",
			"mongo",
			"mariadb",
			"compose",
			"docker",
			"project",
			"server",
			"domain",
			"backup",
			"settings",
			"user",
			"environment",
		];
		for (const group of expectedGroups) {
			expect(output).toContain(group);
		}
	});

	it("should exit with 0 when no args provided", () => {
		const output = run();
		expect(output).toContain("Usage:");
	});

	it("should report unknown commands clearly", () => {
		const result = runFail("not-a-command");
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("unknown command 'not-a-command'");
		expect(
			result.stderr.match(/unknown command 'not-a-command'/g),
		).toHaveLength(1);
		expect(result.stderr).not.toContain("too many arguments");
	});
});
