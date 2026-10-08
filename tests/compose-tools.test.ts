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
	it.each([
		{
			name: "service named services",
			yaml: [
				"services:",
				"  services:",
				"    image: nginx",
				"  web:",
				"    image: redis",
				"volumes:",
				"  data:",
			],
			services: [
				{ name: "services", image: "nginx" },
				{ name: "web", image: "redis" },
			],
		},
		{
			name: "nested services mapping",
			yaml: [
				"services:",
				"  web:",
				"    image: nginx",
				"    build:",
				"      args:",
				"        services:",
				"          image: nested-argument",
				"    ports: [8080:80]",
				"  db:",
				"    image: postgres",
				"volumes:",
				"  data:",
			],
			services: [
				{ name: "web", image: "nginx", build: true, ports: "[8080:80]" },
				{ name: "db", image: "postgres" },
			],
		},
	])("preserves first service section with $name", ({ yaml, services }) => {
		expect(composeToolsInternals.summarizeComposeData(yaml.join("\n"))).toEqual(
			{
				services,
			},
		);
	});

	it("summarizes block-valued service properties", () => {
		const yaml = [
			"services:",
			"  web:",
			"    build:",
			"      context: .",
			"    ports:",
			"      - 8080:80",
			"    volumes:",
			"      - data:/data",
			"    env_file:",
			"      - .env",
			"    environment:",
			"      MODE: synthetic",
		].join("\n");

		expect(composeToolsInternals.summarizeComposeData(yaml)).toEqual({
			services: [
				{
					name: "web",
					build: true,
					ports: true,
					volumes: true,
					env_file: true,
					env: "present",
				},
			],
		});
	});

	it("does not treat nested keys as service properties", () => {
		const yaml = [
			"services:",
			"  web:",
			"      image: nginx",
			"      build:",
			"        context: .",
			"        args:",
			"          image: nested-argument",
			"          ports: nested-argument",
			"      ports: [8080:80]",
			"  db:",
			"    image: postgres",
			"    healthcheck:",
			"      environment: nested-command",
		].join("\n");

		expect(composeToolsInternals.summarizeComposeData(yaml)).toEqual({
			services: [
				{ name: "web", image: "nginx", build: true, ports: "[8080:80]" },
				{ name: "db", image: "postgres" },
			],
		});
	});

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

	it("summarizes yaml services with quoted names and ignores nested mapping keys", () => {
		const yaml = [
			"services:",
			"  # service definition",
			"  web:",
			"    image: nginx",
			"    build: .",
			"    ports:",
			"      - 80:80",
			"    environment:",
			"      NODE_ENV: production",
			'  "db":',
			"    image: postgres",
			"    healthcheck:",
			'      test: "curl http://localhost"',
			"    build: .",
			"networks:",
			"  dokploy-network:",
			"    external: true",
		].join("\n");

		const output = composeToolsInternals.summarizeComposeData(yaml);
		const names = output.services.map((service) => service.name);

		expect(names).toEqual(["web", "db"]);
		expect(output.services).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "web", image: "nginx", build: "." }),
				expect.objectContaining({ name: "db", image: "postgres", build: "." }),
			]),
		);
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
