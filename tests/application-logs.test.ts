import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../src/client.js";
import {
	applicationLogsInternals,
	registerApplicationLogCommands,
} from "../src/commands/application-logs.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("application logs --search", () => {
	const run = async (agentSafe: boolean) => {
		const program = new Command();
		program.exitOverride();
		program.command("application");
		registerApplicationLogCommands(program, { agentSafe });
		const get = vi
			.spyOn(client, "apiGet")
			.mockResolvedValue("boot ok\nAPI_TOKEN=hunter2\nready\n");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await program.parseAsync([
			"node",
			"cli",
			"application",
			"logs",
			"--applicationId",
			"app-1",
			"--search",
			"ready",
		]);
		return { get, printed: log.mock.calls.flat().join("\n") };
	};

	it("filters locally after redaction in agent-safe builds", async () => {
		const { get, printed } = await run(true);
		expect(get).toHaveBeenCalledWith("application.readLogs", {
			applicationId: "app-1",
		});
		expect(printed).toContain("ready");
		expect(printed).not.toContain("boot ok");
	});

	it("passes --search to the server in the full build", async () => {
		const { get } = await run(false);
		expect(get).toHaveBeenCalledWith("application.readLogs", {
			applicationId: "app-1",
			search: "ready",
		});
	});
});

describe("application log helpers", () => {
	it("collects application candidates from search output", () => {
		const candidates = applicationLogsInternals.collectApplications({
			items: [
				{
					applicationId: "app-1",
					name: "web",
					appName: "web-abc123",
					status: "running",
					environment: {
						name: "prod",
						project: { name: "SinkApp" },
					},
				},
			],
		});

		expect(candidates).toEqual([
			{
				applicationId: "app-1",
				name: "web",
				appName: "web-abc123",
				project: "SinkApp",
				env: "prod",
				status: "running",
			},
		]);
	});

	it("collects application context from project inventory", () => {
		const candidates = applicationLogsInternals.collectApplications([
			{
				name: "SinkApp",
				environments: [
					{
						name: "prod",
						applications: [
							{
								applicationId: "app-1",
								name: "web",
								appName: "web-abc123",
							},
						],
					},
				],
			},
		]);

		expect(candidates).toMatchObject([
			{
				applicationId: "app-1",
				project: "SinkApp",
				env: "prod",
			},
		]);
	});

	it("filters candidates by appName, project, and env", () => {
		expect(
			applicationLogsInternals.matchesSelector(
				{
					applicationId: "app-1",
					name: "web",
					appName: "sink-webserver-abc123",
					project: "SinkApp",
					env: "prod",
				},
				{ appName: "sink-webserver-abc123", project: "SinkApp", env: "prod" },
			),
		).toBe(true);

		expect(
			applicationLogsInternals.matchesSelector(
				{
					applicationId: "app-1",
					appName: "sink-webserver-abc123",
					project: "SinkApp",
					env: "prod",
				},
				{ appName: "sink-webserver-abc123", env: "preview" },
			),
		).toBe(false);
	});

	it("prefers exact appName or name matches", () => {
		const matches = applicationLogsInternals.pickExactMatches(
			[
				{
					applicationId: "app-1",
					name: "web-preview",
					appName: "web-preview-abc",
				},
				{
					applicationId: "app-2",
					name: "web",
					appName: "web-abc123",
				},
			],
			{ name: "web" },
		);

		expect(matches).toEqual([
			{
				applicationId: "app-2",
				name: "web",
				appName: "web-abc123",
			},
		]);
	});
});
