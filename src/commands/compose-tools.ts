import type { Command } from "commander";
import { apiGet } from "../client.js";
import { sanitizeForAgent } from "../redact.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

function print(data: unknown, jsonOutput: boolean): void {
	const output = sanitizeForAgent(data);
	if (jsonOutput) {
		console.log(JSON.stringify(output, null, 2));
		return;
	}
	if (typeof output === "string") {
		console.log(output);
		return;
	}
	console.log(JSON.stringify(output, null, 2));
}

function stripYamlSection(input: string, sectionNames: string[]): string {
	const names = new Set(sectionNames);
	const lines = input.split(/\r?\n/);
	const output: string[] = [];
	let skipIndent: number | undefined;
	for (const line of lines) {
		const trimmed = line.trim();
		const indent = line.length - line.trimStart().length;
		if (skipIndent !== undefined) {
			if (trimmed === "" || indent > skipIndent) continue;
			skipIndent = undefined;
		}
		const key = trimmed.match(/^([A-Za-z0-9_.-]+):\s*$/)?.[1];
		if (key && names.has(key)) {
			skipIndent = indent;
			continue;
		}
		output.push(line);
	}
	return output
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function stripComposeNoise(
	data: unknown,
	sectionNames: string[] = ["labels", "networks"],
): unknown {
	if (typeof data === "string") return stripYamlSection(data, sectionNames);
	if (Array.isArray(data))
		return data.map((item) => stripComposeNoise(item, sectionNames));
	const obj = asObject(data);
	if (!obj) return data;
	const sections = new Set(sectionNames);
	const output: JsonObject = {};
	for (const [key, value] of Object.entries(obj)) {
		if (sections.has(key)) continue;
		output[key] = stripComposeNoise(value, sectionNames);
	}
	return output;
}

function parseServicesFromYaml(input: string): JsonObject[] {
	const lines = input.split(/\r?\n/);
	const services: JsonObject[] = [];
	let inServices = false;
	let current: JsonObject | undefined;
	let currentIndent = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const indent = line.length - line.trimStart().length;
		if (trimmed === "services:") {
			inServices = true;
			continue;
		}
		if (inServices && indent === 0 && trimmed.endsWith(":")) break;
		if (!inServices) continue;
		const serviceMatch = trimmed.match(/^([A-Za-z0-9_.-]+):\s*$/);
		if (serviceMatch && indent > 0) {
			current = { name: serviceMatch[1] };
			currentIndent = indent;
			services.push(current);
			continue;
		}
		if (!current || indent <= currentIndent) continue;
		for (const key of ["image", "build", "ports", "volumes", "env_file"]) {
			if (trimmed.startsWith(`${key}:`))
				current[key] = trimmed.slice(key.length + 1).trim() || true;
		}
		if (trimmed.startsWith("environment:")) current.env = "present";
	}
	return services;
}

function summarizeComposeData(data: unknown): JsonObject {
	const text = asText(data);
	const obj = asObject(data);
	const servicesObj = asObject(obj?.services);
	const services = servicesObj
		? Object.entries(servicesObj).map(([name, value]) => {
				const service = asObject(value) ?? {};
				return {
					name,
					image: service.image,
					build: service.build,
					ports: service.ports,
					envKeys: asObject(service.environment)
						? Object.keys(asObject(service.environment) ?? {}).sort()
						: Array.isArray(service.environment)
							? service.environment
									.map((entry) => String(entry).split("=")[0])
									.sort()
							: undefined,
					volumes: service.volumes,
				};
			})
		: parseServicesFromYaml(text);
	return { services };
}

export function registerComposeToolCommands(program: Command): void {
	const compose = program.commands.find((cmd) => cmd.name() === "compose");
	if (!compose) return;

	compose
		.command("effective")
		.description("clean effective compose from get-converted-compose")
		.requiredOption("--composeId <value>", "composeId")
		.option("--no-dokploy-labels", "strip Dokploy-generated labels")
		.option("--no-dokploy-networks", "strip Dokploy-generated networks")
		.option("--json", "Output JSON")
		.action(async (opts: Record<string, unknown>) => {
			const data = await apiGet("compose.getConvertedCompose", {
				composeId: opts.composeId,
			});
			const sectionNames: string[] = [];
			if (opts.dokployLabels === false) sectionNames.push("labels");
			if (opts.dokployNetworks === false) sectionNames.push("networks");
			print(
				sectionNames.length > 0 ? stripComposeNoise(data, sectionNames) : data,
				opts.json === true,
			);
		});

	compose
		.command("summary")
		.description(
			"compose summary with services, images, ports, env keys, and volumes",
		)
		.requiredOption("--composeId <value>", "composeId")
		.option("--json", "Output JSON")
		.action(async (opts: Record<string, unknown>) => {
			const [meta, converted, domains] = await Promise.all([
				apiGet("compose.one", { composeId: opts.composeId }),
				apiGet("compose.getConvertedCompose", { composeId: opts.composeId }),
				apiGet("domain.byComposeId", { composeId: opts.composeId }).catch(
					() => [],
				),
			]);
			const metaObj = asObject(meta) ?? {};
			print(
				{
					composeId: opts.composeId,
					name: metaObj.name,
					repository: metaObj.repository,
					branch: metaObj.branch,
					composePath: metaObj.composePath,
					domains: asArray(domains),
					...summarizeComposeData(stripComposeNoise(converted)),
				},
				opts.json === true,
			);
		});
}

export const composeToolsInternals = {
	stripComposeNoise,
	stripYamlSection,
	summarizeComposeData,
};
