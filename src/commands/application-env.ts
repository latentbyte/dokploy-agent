import type { Command } from "commander";
import { assertApplicationRecordWritable } from "../agent/policy.js";
import { apiGet, apiPost, readAgentDeployPolicyConfig } from "../client.js";
import { maskSecret } from "../redact.js";

interface ApplicationEnvCommandOptions {
	agentSafe: boolean;
}

interface EnvironmentEntry {
	name: string;
	preview: string;
}

interface ApplicationRecord {
	name?: unknown;
	appName?: unknown;
	env?: unknown;
	buildArgs?: unknown;
	buildSecrets?: unknown;
	createEnvFile?: unknown;
	environmentId?: unknown;
	environment?: {
		name?: unknown;
		project?: { name?: unknown; projectId?: unknown };
	};
	project?: { name?: unknown; projectId?: unknown };
	serverId?: unknown;
	buildServerId?: unknown;
	server?: { serverId?: unknown };
	buildServer?: { serverId?: unknown };
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ENV_ASSIGNMENT_PATTERN =
	/^([\t ]*(?:export[\t ]+)?)([A-Za-z_][A-Za-z0-9_.-]*)([\t ]*=[\t ]*)(.*)$/gm;

function nullableString(value: unknown, field: string): string | null {
	if (value === null) return null;
	if (typeof value === "string") return value;
	throw new Error(`Dokploy application response is missing ${field}.`);
}

function environmentDocument(application: ApplicationRecord): string {
	if (application.env === null) return "";
	if (typeof application.env === "string") return application.env;
	throw new Error("Dokploy application response is missing env.");
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

async function readApplication(
	applicationId: string,
	agentSafe: boolean,
): Promise<ApplicationRecord> {
	const application = (await apiGet("application.one", {
		applicationId,
	})) as ApplicationRecord;
	if (agentSafe) {
		assertApplicationRecordWritable(
			readAgentDeployPolicyConfig(),
			applicationId,
			application,
		);
	}
	return application;
}

async function saveEnvironment(
	applicationId: string,
	application: ApplicationRecord,
	env: string,
): Promise<void> {
	if (typeof application.createEnvFile !== "boolean") {
		throw new Error("Dokploy application response is missing createEnvFile.");
	}
	await apiPost("application.saveEnvironment", {
		applicationId,
		env,
		buildArgs: nullableString(application.buildArgs, "buildArgs"),
		buildSecrets: nullableString(application.buildSecrets, "buildSecrets"),
		createEnvFile: application.createEnvFile,
	});
}

function printResult(data: unknown, jsonOutput: boolean): void {
	if (jsonOutput) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}
	console.log(JSON.stringify(data));
}

export function registerApplicationEnvCommands(
	program: Command,
	options: ApplicationEnvCommandOptions,
): void {
	const application = program.commands.find(
		(command) => command.name() === "application",
	);
	if (!application) return;

	const env = application
		.command("env")
		.description(
			"inspect and mutate application environment without exposing values",
		);

	env
		.command("list")
		.description("list environment names with masked previews")
		.requiredOption("--applicationId <value>", "applicationId")
		.option("--json", "Output JSON")
		.action(async (opts: Record<string, unknown>) => {
			const applicationRecord = await readApplication(
				String(opts.applicationId),
				options.agentSafe,
			);
			printResult(
				{
					applicationId: opts.applicationId,
					entries: environmentEntries(environmentDocument(applicationRecord)),
				},
				opts.json === true,
			);
		});

	env
		.command("add")
		.description(
			"append a new environment variable without replacing existing values",
		)
		.requiredOption("--applicationId <value>", "applicationId")
		.requiredOption("--name <value>", "environment variable name")
		.requiredOption("--value <value>", "new environment variable value")
		.option("--comment <value>", "comment placed before the new variable")
		.option("--json", "Output JSON")
		.action(async (opts: Record<string, unknown>) => {
			const applicationId = String(opts.applicationId);
			const applicationRecord = await readApplication(
				applicationId,
				options.agentSafe,
			);
			const name = String(opts.name);
			const nextEnv = appendEnvironmentVariable(
				environmentDocument(applicationRecord),
				name,
				String(opts.value),
				typeof opts.comment === "string" ? opts.comment : undefined,
			);
			await saveEnvironment(applicationId, applicationRecord, nextEnv);
			printResult({ applicationId, name, added: true }, opts.json === true);
		});

	env
		.command("set")
		.description(
			"create or replace an environment variable without exposing other values",
		)
		.requiredOption("--applicationId <value>", "applicationId")
		.requiredOption("--name <value>", "environment variable name")
		.requiredOption("--value <value>", "environment variable value")
		.option("--json", "Output JSON")
		.action(async (opts: Record<string, unknown>) => {
			const applicationId = String(opts.applicationId);
			const applicationRecord = await readApplication(
				applicationId,
				options.agentSafe,
			);
			const name = String(opts.name);
			const nextEnv = setEnvironmentVariable(
				environmentDocument(applicationRecord),
				name,
				String(opts.value),
			);
			await saveEnvironment(applicationId, applicationRecord, nextEnv);
			printResult({ applicationId, name, set: true }, opts.json === true);
		});

	env
		.command("comment")
		.description("add a comment before an existing environment variable")
		.requiredOption("--applicationId <value>", "applicationId")
		.requiredOption("--name <value>", "existing environment variable name")
		.requiredOption("--text <value>", "comment text")
		.option("--json", "Output JSON")
		.action(async (opts: Record<string, unknown>) => {
			const applicationId = String(opts.applicationId);
			const applicationRecord = await readApplication(
				applicationId,
				options.agentSafe,
			);
			const name = String(opts.name);
			const nextEnv = annotateEnvironmentVariable(
				environmentDocument(applicationRecord),
				name,
				String(opts.text),
			);
			await saveEnvironment(applicationId, applicationRecord, nextEnv);
			printResult({ applicationId, name, commented: true }, opts.json === true);
		});
}
