import type { Command } from "commander";
import { apiGet } from "../client.js";
import { sanitizeForAgent } from "../redact.js";

type JsonObject = Record<string, unknown>;

interface InventoryRow {
	type: string;
	project?: string;
	env?: string;
	name?: string;
	id?: string;
	status?: string;
	domains?: string[];
	repo?: string;
	branch?: string;
	path?: string;
	serverId?: string;
}

function asObject(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function getString(
	obj: JsonObject | undefined,
	...keys: string[]
): string | undefined {
	if (!obj) return undefined;
	return firstString(...keys.map((key) => obj[key]));
}

function collectDomains(value: unknown): string[] {
	const domains = new Set<string>();
	const visit = (item: unknown) => {
		if (typeof item === "string") {
			if (item.includes(".")) domains.add(item);
			return;
		}
		const obj = asObject(item);
		if (!obj) return;
		for (const key of ["host", "domain", "hostname", "url"]) {
			const text = getString(obj, key);
			if (text) domains.add(text);
		}
	};
	for (const item of asArray(value)) visit(item);
	return [...domains].sort();
}

function pickId(type: string, service: JsonObject): string | undefined {
	return getString(
		service,
		"id",
		`${type}Id`,
		"applicationId",
		"composeId",
		"postgresId",
		"mysqlId",
		"mariadbId",
		"mongoId",
		"redisId",
		"libsqlId",
	);
}

function toRow(
	type: string,
	project: JsonObject,
	env: JsonObject,
	service: JsonObject,
): InventoryRow {
	const domains = collectDomains(service.domains ?? service.domain);
	return {
		type,
		project: getString(project, "name", "projectName"),
		env: getString(env, "name", "environmentName"),
		name: getString(service, "name", "appName"),
		id: pickId(type, service),
		status: getString(service, "status", "applicationStatus", "composeStatus"),
		domains: domains.length > 0 ? domains : undefined,
		repo: getString(service, "repository", "repo", "gitRepository"),
		branch: getString(service, "branch", "gitBranch"),
		path: getString(service, "appPath", "composePath", "dockerfilePath"),
		serverId: getString(service, "serverId"),
	};
}

function flattenProjectAll(data: unknown): InventoryRow[] {
	const projects = Array.isArray(data)
		? data
		: asArray(asObject(data)?.projects);
	const rows: InventoryRow[] = [];
	for (const projectValue of projects) {
		const project = asObject(projectValue);
		if (!project) continue;
		const envs = asArray(project.environments ?? project.environment);
		for (const envValue of envs) {
			const env = asObject(envValue);
			if (!env) continue;
			const groups: Array<[string, unknown]> = [
				["application", env.applications],
				["compose", env.compose ?? env.composes],
				["postgres", env.postgres],
				["mysql", env.mysql],
				["mariadb", env.mariadb],
				["mongo", env.mongo],
				["redis", env.redis],
				["libsql", env.libsql],
			];
			for (const [type, values] of groups) {
				for (const serviceValue of asArray(values)) {
					const service = asObject(serviceValue);
					if (service) rows.push(toRow(type, project, env, service));
				}
			}
		}
	}
	return rows;
}

function selectFields(
	rows: InventoryRow[],
	fields?: string,
): InventoryRow[] | JsonObject[] {
	if (!fields) return rows;
	const names = fields
		.split(",")
		.map((field) => field.trim())
		.filter(Boolean);
	return rows.map((row) => {
		const selected: JsonObject = {};
		for (const name of names)
			selected[name] = (row as unknown as JsonObject)[name];
		return selected;
	});
}

function print(data: unknown, jsonOutput: boolean): void {
	const output = sanitizeForAgent(data);
	if (jsonOutput) {
		console.log(JSON.stringify(output, null, 2));
		return;
	}
	console.log(JSON.stringify(output, null, 2));
}

async function listServices(
	opts: Record<string, unknown>,
	type?: string,
): Promise<void> {
	const data = await apiGet("project.all", {});
	let rows = flattenProjectAll(data);
	if (type) rows = rows.filter((row) => row.type === type);
	print(
		selectFields(
			rows,
			typeof opts.fields === "string" ? opts.fields : undefined,
		),
		opts.json === true,
	);
}

export function registerServiceInventoryCommands(program: Command): void {
	program
		.command("service")
		.description("service inventory commands")
		.command("list")
		.description("flattened inventory across projects")
		.option("--fields <value>", "comma-separated output fields")
		.option("--json", "Output JSON")
		.action((opts: Record<string, unknown>) => listServices(opts));

	program
		.command("inventory", { hidden: false })
		.description("alias for service list")
		.option("--fields <value>", "comma-separated output fields")
		.option("--json", "Output JSON")
		.action((opts: Record<string, unknown>) => listServices(opts));

	const application = program.commands.find(
		(cmd) => cmd.name() === "application",
	);
	application
		?.command("list")
		.description("alias: flattened application inventory from project all")
		.option("--fields <value>", "comma-separated output fields")
		.option("--json", "Output JSON")
		.action((opts: Record<string, unknown>) =>
			listServices(opts, "application"),
		);

	const compose = program.commands.find((cmd) => cmd.name() === "compose");
	compose
		?.command("list")
		.description("alias: flattened compose inventory from project all")
		.option("--fields <value>", "comma-separated output fields")
		.option("--json", "Output JSON")
		.action((opts: Record<string, unknown>) => listServices(opts, "compose"));
}
