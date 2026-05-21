import { describe, expect, it } from "vitest";
import { applicationLogsInternals } from "../src/commands/application-logs.js";

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
