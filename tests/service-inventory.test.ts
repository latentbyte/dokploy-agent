import { describe, expect, it } from "vitest";
import { serviceInventoryInternals } from "../src/commands/service-inventory.js";

describe("service inventory helpers", () => {
	it("collects domains from single and array values", () => {
		expect(serviceInventoryInternals.collectDomains("app.example.com")).toEqual(
			["app.example.com"],
		);
		expect(
			serviceInventoryInternals.collectDomains({ host: "api.example.com" }),
		).toEqual(["api.example.com"]);
		expect(
			serviceInventoryInternals.collectDomains([
				{ hostname: "web.example.com" },
				{ url: "https://web.example.com" },
				"worker.example.com",
			]),
		).toEqual([
			"https://web.example.com",
			"web.example.com",
			"worker.example.com",
		]);
	});

	it("flattens project services with single domain objects", () => {
		const rows = serviceInventoryInternals.flattenProjectAll([
			{
				name: "project-a",
				environments: [
					{
						name: "prod",
						applications: [
							{
								applicationId: "app-1",
								name: "web",
								domain: { host: "web.example.com" },
							},
						],
					},
				],
			},
		]);

		expect(rows).toMatchObject([
			{
				type: "application",
				project: "project-a",
				env: "prod",
				name: "web",
				id: "app-1",
				domains: ["web.example.com"],
			},
		]);
	});

	it("selects requested fields", () => {
		expect(
			serviceInventoryInternals.selectFields(
				[
					{
						type: "compose",
						name: "api",
						id: "compose-1",
					},
				],
				"type,id",
			),
		).toEqual([{ type: "compose", id: "compose-1" }]);
	});
});
