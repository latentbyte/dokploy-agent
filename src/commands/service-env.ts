import type { Command } from "commander";
import { assertServiceRecordWritable } from "../agent/policy.js";
import { apiGet, apiPost, readAgentDeployPolicyConfig } from "../client.js";
import { maskSecret } from "../redact.js";

interface ServiceEnvCommandOptions {
	agentSafe: boolean;
}

interface EnvironmentEntry {
	name: string;
	preview: string;
}

type ServiceRecord = Record<string, unknown>;
type EnvServiceKind = "application" | "compose";

interface EnvTarget {
	idKey: string;
	save(id: string, record: ServiceRecord, env: string): Promise<void>;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ENV_ASSIGNMENT_PATTERN =
	/^([\t ]*(?:export[\t ]+)?)([A-Za-z_][A-Za-z0-9_.-]*)([\t ]*=[\t ]*)([^\r\n]*)$/gm;

function nullableString(value: unknown, field: string): string | null {
	if (value === null) return null;
	if (typeof value === "string") return value;
	throw new Error(`Dokploy application response is missing ${field}.`);
}

// Dokploy saveEnvironment replaces the document; companion fields are resent
// unchanged so env edits do not clobber them
const ENV_TARGETS: Record<EnvServiceKind, EnvTarget> = {
	application: {
		idKey: "applicationId",
		async save(applicationId, application, env) {
			if (typeof application.createEnvFile !== "boolean") {
				throw new Error(
					"Dokploy application response is missing createEnvFile.",
				);
			}
			await apiPost("application.saveEnvironment", {
				applicationId,
				env,
				buildArgs: nullableString(application.buildArgs, "buildArgs"),
				buildSecrets: nullableString(application.buildSecrets, "buildSecrets"),
				createEnvFile: application.createEnvFile,
			});
		},
	},
	compose: {
		idKey: "composeId",
		async save(composeId, _compose, env) {
			await apiPost("compose.saveEnvironment", { composeId, env });
		},
	},
};

function environmentDocument(kind: EnvServiceKind, record: ServiceRecord) {
	if (record.env === null) return "";
	if (typeof record.env === "string") return record.env;
	throw new Error(`Dokploy ${kind} response is missing env.`);
}

function environmentEntries(document: string): EnvironmentEntry[] {
	return [...document.matchAll(ENV_ASSIGNMENT_PATTERN)].map((match) => ({
		name: match[2] ?? "",
		preview: maskSecret(
			(match[4] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2"),
		),
	}));
}

function matchingAssignments(
	document: string,
	name: string,
): RegExpMatchArray[] {
	return [...document.matchAll(ENV_ASSIGNMENT_PATTERN)].filter(
		(match) => match[2] === name,
	);
}

function lineEnding(document: string): string {
	return document.includes("\r\n") ? "\r\n" : "\n";
}

function commentLines(comment: string, eol: string): string {
	const lines = comment.replaceAll("\r", "").split("\n");
	if (lines.every((line) => !line.trim())) {
		throw new Error("Comment must not be empty.");
	}
	return lines.map((line) => `# ${line.trim()}`).join(eol);
}

export function appendEnvironmentVariable(
	document: string,
	name: string,
	value: string,
	comment?: string,
): string {
	if (!ENV_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid environment variable name: ${name}`);
	}
	if (matchingAssignments(document, name).length > 0) {
		throw new Error(`Environment variable ${name} already exists.`);
	}

	const eol = lineEnding(document);
	const prefix = document.length > 0 && !document.endsWith("\n") ? eol : "";
	const commentBlock = comment ? `${commentLines(comment, eol)}${eol}` : "";
	return `${document}${prefix}${commentBlock}${name}=${JSON.stringify(value)}${eol}`;
}

export function annotateEnvironmentVariable(
	document: string,
	name: string,
	comment: string,
): string {
	if (!ENV_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid environment variable name: ${name}`);
	}
	const matches = matchingAssignments(document, name);
	if (matches.length === 0) {
		throw new Error(`Environment variable ${name} does not exist.`);
	}
	if (matches.length > 1) {
		throw new Error(
			`Environment variable ${name} is duplicated; refusing ambiguous comment.`,
		);
	}

	const match = matches[0];
	const index = match?.index;
	if (index === undefined)
		throw new Error(`Could not locate environment variable ${name}.`);
	const eol = lineEnding(document);
	return `${document.slice(0, index)}${commentLines(comment, eol)}${eol}${document.slice(index)}`;
}

export function setEnvironmentVariable(
	document: string,
	name: string,
	value: string,
): string {
	if (!ENV_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid environment variable name: ${name}`);
	}
	const matches = matchingAssignments(document, name);
	if (matches.length === 0) {
		return appendEnvironmentVariable(document, name, value);
	}
	if (matches.length > 1) {
		throw new Error(
			`Environment variable ${name} is duplicated; refusing ambiguous set.`,
		);
	}

	const match = matches[0];
	const index = match?.index;
	if (index === undefined || match === undefined) {
		throw new Error(`Could not locate environment variable ${name}.`);
	}
	const eol = lineEnding(document);
	const prefix = match[1] ?? "";
	const separator = match[3] ?? "=";
	const assignment = `${prefix}${name}${separator}${JSON.stringify(value)}`;
	return `${document.slice(0, index)}${assignment}${document.slice(index + match[0].length)}`;
}

export function unsetEnvironmentVariable(
	document: string,
	name: string,
): string {
	if (!ENV_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid environment variable name: ${name}`);
	}
	const matches = matchingAssignments(document, name);
	if (matches.length === 0) {
		throw new Error(`Environment variable ${name} does not exist.`);
	}

	// remove every assignment of the name, with its line ending
	let next = document;
	for (const match of matches.reverse()) {
		const index = match.index;
		if (index === undefined) {
			throw new Error(`Could not locate environment variable ${name}.`);
		}
		const end = index + match[0].length;
		const eolLength = next.startsWith("\r\n", end)
			? 2
			: next.startsWith("\n", end)
				? 1
				: 0;
		next = `${next.slice(0, index)}${next.slice(end + eolLength)}`;
	}
	return next;
}

async function readService(
	kind: EnvServiceKind,
	id: string,
	agentSafe: boolean,
): Promise<ServiceRecord> {
	const record = (await apiGet(`${kind}.one`, {
		[ENV_TARGETS[kind].idKey]: id,
	})) as ServiceRecord;
	if (agentSafe) {
		assertServiceRecordWritable(
			readAgentDeployPolicyConfig(),
			kind,
			id,
			record,
		);
	}
	return record;
}

function printResult(data: unknown, jsonOutput: boolean): void {
	if (jsonOutput) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}
	console.log(JSON.stringify(data));
}

type EnvEdit = (document: string, opts: Record<string, unknown>) => string;

function registerEnvCommands(
	group: Command,
	kind: EnvServiceKind,
	options: ServiceEnvCommandOptions,
): void {
	const { idKey, save } = ENV_TARGETS[kind];
	const env = group
		.command("env")
		.description(
			`inspect and mutate ${kind} environment without exposing values`,
		);

	env
		.command("list")
		.description("list environment names with masked previews")
		.requiredOption(`--${idKey} <value>`, idKey)
		.option("--json", "Output JSON")
		.action(async (opts: Record<string, unknown>) => {
			const id = String(opts[idKey]);
			const record = await readService(kind, id, options.agentSafe);
			printResult(
				{
					[idKey]: id,
					entries: environmentEntries(environmentDocument(kind, record)),
				},
				opts.json === true,
			);
		});

	const mutation = (
		name: string,
		description: string,
		flags: Array<[string, string]>,
		resultKey: string,
		edit: EnvEdit,
		optional: Array<[string, string]> = [],
	) => {
		const command = env
			.command(name)
			.description(description)
			.requiredOption(`--${idKey} <value>`, idKey);
		for (const [flag, help] of flags) command.requiredOption(flag, help);
		for (const [flag, help] of optional) command.option(flag, help);
		command
			.option("--json", "Output JSON")
			.action(async (opts: Record<string, unknown>) => {
				const id = String(opts[idKey]);
				const record = await readService(kind, id, options.agentSafe);
				const nextEnv = edit(environmentDocument(kind, record), opts);
				await save(id, record, nextEnv);
				printResult(
					{ [idKey]: id, name: opts.name, [resultKey]: true },
					opts.json === true,
				);
			});
	};

	mutation(
		"add",
		"append a new environment variable without replacing existing values",
		[
			["--name <value>", "environment variable name"],
			["--value <value>", "new environment variable value"],
		],
		"added",
		(document, opts) =>
			appendEnvironmentVariable(
				document,
				String(opts.name),
				String(opts.value),
				typeof opts.comment === "string" ? opts.comment : undefined,
			),
		[["--comment <value>", "comment placed before the new variable"]],
	);
	mutation(
		"set",
		"create or replace an environment variable without exposing other values",
		[
			["--name <value>", "environment variable name"],
			["--value <value>", "environment variable value"],
		],
		"set",
		(document, opts) =>
			setEnvironmentVariable(document, String(opts.name), String(opts.value)),
	);
	mutation(
		"unset",
		"remove an environment variable without exposing other values",
		[["--name <value>", "environment variable name"]],
		"unset",
		(document, opts) => unsetEnvironmentVariable(document, String(opts.name)),
	);
	mutation(
		"comment",
		"add a comment before an existing environment variable",
		[
			["--name <value>", "existing environment variable name"],
			["--text <value>", "comment text"],
		],
		"commented",
		(document, opts) =>
			annotateEnvironmentVariable(
				document,
				String(opts.name),
				String(opts.text),
			),
	);
}

export function registerServiceEnvCommands(
	program: Command,
	options: ServiceEnvCommandOptions,
): void {
	for (const kind of Object.keys(ENV_TARGETS) as EnvServiceKind[]) {
		const group = program.commands.find((command) => command.name() === kind);
		if (group) registerEnvCommands(group, kind, options);
	}
}
