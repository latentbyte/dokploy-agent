import { describe, expect, it } from "vitest";
import { composeToolsInternals } from "../src/commands/compose-tools.js";

const composeObject = {
	services: {
		web: {
			image: "nginx",
			labels: { "traefik.enable": "true" },
			networks: ["dokploy-network"],
		},
	},
	networks: { "dokploy-network": { external: true } },
};

describe("compose tool helpers", () => {
	it("strips only requested object sections", () => {
		expect(
			composeToolsInternals.stripComposeNoise(composeObject, ["labels"]),
		).toEqual({
			services: {
				web: {
					image: "nginx",
					networks: ["dokploy-network"],
				},
			},
			networks: { "dokploy-network": { external: true } },
		});

		expect(
			composeToolsInternals.stripComposeNoise(composeObject, ["networks"]),
		).toEqual({
			services: {
				web: {
					image: "nginx",
					labels: { "traefik.enable": "true" },
				},
			},
		});
	});

	it("strips only requested yaml sections", () => {
		const yaml = [
			"services:",
			"  web:",
			"    image: nginx",
			"    labels:",
			"      traefik.enable: true",
			"    networks:",
			"      - dokploy-network",
			"networks:",
			"  dokploy-network:",
			"    external: true",
		].join("\n");

		const output = composeToolsInternals.stripComposeNoise(yaml, ["labels"]);

		expect(output).toContain("image: nginx");
		expect(output).toContain("networks:");
		expect(output).toContain("dokploy-network");
		expect(output).not.toContain("traefik.enable");
	});

	it("summarizes compose services", () => {
		expect(composeToolsInternals.summarizeComposeData(composeObject)).toEqual({
			services: [
				{
					name: "web",
					image: "nginx",
					envKeys: undefined,
					ports: undefined,
					build: undefined,
					volumes: undefined,
				},
			],
		});
	});

	it("summarizes missing compose data as an empty service list", () => {
		expect(composeToolsInternals.summarizeComposeData(undefined)).toEqual({
			services: [],
		});
	});
});
