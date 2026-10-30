import type { Command } from "commander";
import {
	type ApprovalLine,
	type ApprovalRequest,
	approvalTarget,
	MAX_APPROVAL_LINES,
	requireUserApproval,
} from "../agent/approval.js";
import { agentPolicyBlocked, CliError } from "../agent/errors.js";
import {
	AGENT_DATABASE_KINDS,
	type AgentServiceKind,
	servicePerimeterDenial,
} from "../agent/policy.js";
import { apiGet, apiPost, readAgentDeployPolicyConfig } from "../client.js";
import {
	type EnvLine,
	parseEnvDocument,
	unquoteEnvValue,
} from "../env-document.js";
import { isSensitiveEnvKey, maskSecret } from "../redact.js";

interface ServiceEnvCommandOptions {
	agentSafe: boolean;
}

interface EnvironmentEntry {
	name: string;
	preview: string;
}

type ServiceRecord = Record<string, any>;
type EnvServiceKind = AgentServiceKind;

interface EnvTarget {
	idKey: string;
	// fields the save resends; a change while the approval dialog is open aborts
	stateFields: string[];
	save(id: string, record: ServiceRecord, env: string): Promise<void>;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function nullableString(value: unknown, field: string): string | null {
	if (value === null) return null;
	if (typeof value === "string") return value;
	throw new Error(`Dokploy application response is missing ${field}.`);
}

function databaseTarget(kind: EnvServiceKind): EnvTarget {
	const idKey = `${kind}Id`;
	return {
		idKey,
		stateFields: ["env"],
		async save(id, _record, env) {
			await apiPost(`${kind}.saveEnvironment`, { [idKey]: id, env });
		},
	};
}

// Dokploy saveEnvironment replaces the document; companion fields are resent
// unchanged so env edits do not clobber them
const ENV_TARGETS: Record<EnvServiceKind, EnvTarget> = {
	application: {
		idKey: "applicationId",
		stateFields: ["env", "buildArgs", "buildSecrets", "createEnvFile"],
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
		stateFields: ["env"],
		async save(composeId, _compose, env) {
			await apiPost("compose.saveEnvironment", { composeId, env });
		},
	},
	...(Object.fromEntries(
		AGENT_DATABASE_KINDS.map((kind) => [kind, databaseTarget(kind)]),
	) as Record<(typeof AGENT_DATABASE_KINDS)[number], EnvTarget>),
};

function environmentDocument(kind: EnvServiceKind, record: ServiceRecord) {
	if (record.env === null) return "";
	if (typeof record.env === "string") return record.env;
	throw new Error(`Dokploy ${kind} response is missing env.`);
}

type Assignment = EnvLine & { assignment: NonNullable<EnvLine["assignment"]> };

function assignments(document: string): Assignment[] {
	return parseEnvDocument(document).filter(
		(line): line is Assignment => line.assignment !== undefined,
	);
}

function environmentEntries(document: string): EnvironmentEntry[] {
	return assignments(document).map(({ assignment }) => ({
		name: assignment.name,
		preview: maskSecret(unquoteEnvValue(assignment.value)),
	}));
}

function matchingAssignments(document: string, name: string): Assignment[] {
	return assignments(document).filter((line) => line.assignment.name === name);
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

	const index = matches[0]?.index ?? 0;
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

	const [line] = matches as [Assignment];
	const { prefix, separator } = line.assignment;
	const assignment = `${prefix}${name}${separator}${JSON.stringify(value)}`;
	return `${document.slice(0, line.index)}${assignment}${document.slice(line.index + line.length)}`;
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
	for (const line of matches.reverse()) {
		const end = line.index + line.length + line.eol.length;
		next = `${next.slice(0, line.index)}${next.slice(end)}`;
	}
	return next;
}

export function renameEnvironmentVariable(
	document: string,
	name: string,
	newName: string,
): string {
	for (const candidate of [name, newName]) {
		if (!ENV_NAME_PATTERN.test(candidate)) {
			throw new Error(`Invalid environment variable name: ${candidate}`);
		}
	}
	const matches = matchingAssignments(document, name);
	if (matches.length === 0) {
		throw new Error(`Environment variable ${name} does not exist.`);
	}
	if (matches.length > 1) {
		throw new Error(
			`Environment variable ${name} is duplicated; refusing ambiguous rename.`,
		);
	}
	if (matchingAssignments(document, newName).length > 0) {
		throw new Error(`Environment variable ${newName} already exists.`);
	}

	// only the name changes; prefix, separator, and raw value bytes stay
	const [line] = matches as [Assignment];
	const { prefix, separator, value } = line.assignment;
	return `${document.slice(0, line.index)}${prefix}${newName}${separator}${value}${document.slice(line.index + line.length)}`;
}

// names to copy, in source order and without repeats
export function environmentCopyNames(
	source: string,
	opts: { names?: unknown; all?: unknown },
): string[] {
	if ((opts.names === undefined) === (opts.all === undefined)) {
		throw new Error("Pass exactly one of --names or --all.");
	}
	const present = [
		...new Set(assignments(source).map((line) => line.assignment.name)),
	];
	if (opts.all !== undefined) {
		if (present.length === 0) {
			throw new Error("Source service has no environment variables.");
		}
		return present;
	}
	const requested = String(opts.names)
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	if (requested.length === 0) throw new Error("--names lists no variables.");
	for (const name of requested) {
		if (!ENV_NAME_PATTERN.test(name)) {
			throw new Error(`Invalid environment variable name: ${name}`);
		}
		if (!present.includes(name)) {
			throw new Error(`Environment variable ${name} does not exist.`);
		}
	}
	return present.filter((name) => requested.includes(name));
}

// raw bytes, so quoting and ${{project.X}} references keep their meaning
export function copyEnvironmentVariables(
	source: string,
	target: string,
	names: string[],
): string {
	const eol = lineEnding(target);
	let next = target;
	for (const name of names) {
		const matches = matchingAssignments(source, name);
		if (matches.length > 1) {
			throw new Error(
				`Environment variable ${name} is duplicated; refusing ambiguous copy.`,
			);
		}
		if (matchingAssignments(target, name).length > 0) {
			throw new Error(`Environment variable ${name} already exists.`);
		}
		const [line] = matches as [Assignment];
		const { prefix, separator, value } = line.assignment;
		const lead = next.length > 0 && !next.endsWith("\n") ? eol : "";
		next = `${next}${lead}${prefix}${name}${separator}${value}${eol}`;
	}
	return next;
}

// frameworks inline these into client bundles served to anyone
const PUBLIC_ENV_PREFIXES = [
	"NEXT_PUBLIC_",
	"NUXT_PUBLIC_",
	"VITE_",
	"REACT_APP_",
	"EXPO_PUBLIC_",
	"GATSBY_",
	"VUE_APP_",
	"PUBLIC_",
];

function publicEnvPrefix(name: string): string | undefined {
	return PUBLIC_ENV_PREFIXES.find((prefix) => name.startsWith(prefix));
}

// a rename moves a value the agent never saw to a name it picked; names that
// publish the value or drop out of name-based log redaction need the user
export function environmentRenameRisk(
	name: string,
	newName: string,
): string | undefined {
	const prefix = publicEnvPrefix(newName);
	if (prefix && !publicEnvPrefix(name)) {
		return `renaming ${name} to ${newName} publishes its value through the ${prefix} client-bundle prefix`;
	}
	if (isSensitiveEnvKey(name) && !isSensitiveEnvKey(newName)) {
		return `renaming ${name} to ${newName} drops a secret-looking name, so logs printing it are no longer redacted`;
	}
	return undefined;
}

export interface EnvironmentUrlParts {
	scheme: string;
	host: string;
	port: string | null;
	database: string | null;
}

// only database URLs name a database in the path; other paths may hold tokens
const DATABASE_URL_SCHEMES = new Set([
	"postgres",
	"postgresql",
	"mysql",
	"mariadb",
	"mongodb",
	"mongodb+srv",
	"redis",
	"rediss",
]);

// non-secret parts of a URL value; credentials, query, and fragment stay hidden
export function environmentUrlParts(
	document: string,
	name: string,
): EnvironmentUrlParts {
	if (!ENV_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid environment variable name: ${name}`);
	}
	const matches = matchingAssignments(document, name);
	if (matches.length === 0) {
		throw new Error(`Environment variable ${name} does not exist.`);
	}
	if (matches.length > 1) {
		throw new Error(
			`Environment variable ${name} is duplicated; refusing ambiguous read.`,
		);
	}
	const [line] = matches as [Assignment];
	let url: URL | undefined;
	try {
		url = new URL(unquoteEnvValue(line.assignment.value));
	} catch {
		url = undefined;
	}
	if (!url?.hostname) {
		throw new CliError(
			"INVALID_ENV_URL",
			`Environment variable ${name} is not a URL with a host.`,
		);
	}
	const scheme = url.protocol.replace(/:$/, "");
	const database = DATABASE_URL_SCHEMES.has(scheme)
		? url.pathname.replace(/^\//, "") || null
		: null;
	return { scheme, host: url.hostname, port: url.port || null, database };
}

async function fetchService(
	kind: EnvServiceKind,
	id: string,
): Promise<ServiceRecord> {
	return (await apiGet(`${kind}.one`, {
		[ENV_TARGETS[kind].idKey]: id,
	})) as ServiceRecord;
}

function sameEnvState(
	kind: EnvServiceKind,
	before: ServiceRecord,
	after: ServiceRecord,
): boolean {
	return ENV_TARGETS[kind].stateFields.every(
		(field) => before[field] === after[field],
	);
}

// current assignments as masked diff lines; values never reach the dialog
function maskedAssignments(
	document: string,
	name: string,
	kind: ApprovalLine["kind"],
): ApprovalLine[] {
	return matchingAssignments(document, name).map(({ assignment }) => ({
		kind,
		text: `${name}=${maskSecret(unquoteEnvValue(assignment.value))}`,
	}));
}

function commentDiff(comment: string): ApprovalLine[] {
	return commentLines(comment, "\n")
		.split("\n")
		.map((text) => ({ kind: "add", text }));
}

function quotedAssignment(name: string, value: string): ApprovalLine {
	return { kind: "add", text: `${name}=${JSON.stringify(value)}` };
}

function envApprovalRequest(
	kind: EnvServiceKind,
	id: string,
	record: ServiceRecord,
	operation: string,
	names: string[],
	lines: ApprovalLine[],
	reason: unknown,
): ApprovalRequest {
	return {
		endpoint: `${kind}.saveEnvironment`,
		title: `env ${operation}`,
		target: approvalTarget(kind, id, record),
		lines,
		audit: { operation, names },
		reason: typeof reason === "string" ? reason : undefined,
	};
}

function printResult(data: unknown, jsonOutput: boolean): void {
	if (jsonOutput) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}
	console.log(JSON.stringify(data));
}

type EnvEdit = (document: string, opts: Record<string, unknown>) => string;
// dialog diff for the human; may show the value the agent supplied
type EnvDescribe = (
	document: string,
	opts: Record<string, unknown>,
) => ApprovalLine[];
// why an otherwise permitted write still needs the user
type EnvRisk = (opts: Record<string, unknown>) => string | undefined;

// masked lines only: dialog argv is readable by local processes
function envCopyLines(
	composeId: string,
	compose: ServiceRecord,
	document: string,
	names: string[],
): ApprovalLine[] {
	const label = [compose.name, compose.appName].filter(Boolean).join(" / ");
	return [
		{ kind: "text", text: `from compose ${label} (${composeId})` },
		{
			kind: "text",
			text: `${names.length} keys; anything this application runs can read the values`,
		},
		...names.flatMap((name) =>
			maskedAssignments(document, name, "add").map((line) => {
				const prefix = publicEnvPrefix(name);
				return prefix
					? { ...line, text: `${line.text}  [${prefix} client-bundle prefix]` }
					: line;
			}),
		),
	];
}

function registerEnvCopyCommand(
	env: Command,
	options: ServiceEnvCommandOptions,
): void {
	env
		.command("copy")
		.description(
			"copy environment variables from a compose service without exposing values",
		)
		.requiredOption("--from-compose <value>", "source composeId")
		.requiredOption("--applicationId <value>", "target applicationId")
		.option("--names <value>", "comma-separated variable names to copy")
		.option("--all", "copy every variable")
		.option(
			"--reason <text>",
			"why this copy is needed; always shown in the approval dialog",
		)
		.option("--json", "Output JSON")
		.action(async (opts: Record<string, unknown>) => {
			const composeId = String(opts.fromCompose);
			const applicationId = String(opts.applicationId);
			const source = await fetchService("compose", composeId);
			const target = await fetchService("application", applicationId);
			const document = environmentDocument("compose", source);
			const names = environmentCopyNames(document, opts);
			const nextEnv = copyEnvironmentVariables(
				document,
				environmentDocument("application", target),
				names,
			);
			if (options.agentSafe) {
				const policy = readAgentDeployPolicyConfig();
				if (
					!source.environmentId ||
					source.environmentId !== target.environmentId
				) {
					throw agentPolicyBlocked(
						`agent-safe env copy requires compose ${composeId} and application ${applicationId} in one environment, so \${{environment.X}} references keep their meaning`,
					);
				}
				const lines = envCopyLines(composeId, source, document, names);
				if (lines.length > MAX_APPROVAL_LINES) {
					throw agentPolicyBlocked(
						`agent-safe env copy of ${names.length} keys does not fit one approval dialog; copy fewer with --names`,
					);
				}
				const misses = [
					servicePerimeterDenial(policy, "application", applicationId, target),
					servicePerimeterDenial(policy, "compose", composeId, source),
				].flatMap((denial) => (denial ? [denial.message] : []));
				await requireUserApproval(
					policy.approval,
					{
						...envApprovalRequest(
							"application",
							applicationId,
							target,
							"copy",
							names,
							lines,
							opts.reason,
						),
						audit: { operation: "copy", names, fromComposeId: composeId },
					},
					agentPolicyBlocked(
						[
							"env copy always needs the user: a copied secret could reach a service the agent controls",
							...misses,
						].join("; "),
					),
				);
				const currentSource = await fetchService("compose", composeId);
				const currentTarget = await fetchService("application", applicationId);
				if (
					!sameEnvState("compose", source, currentSource) ||
					!sameEnvState("application", target, currentTarget)
				) {
					throw new CliError(
						"AGENT_APPROVAL_STALE",
						`compose ${composeId} or application ${applicationId} environment changed while the approval dialog was open; nothing was written, retry to review the new state`,
					);
				}
			}
			await ENV_TARGETS.application.save(applicationId, target, nextEnv);
			printResult(
				{ applicationId, fromComposeId: composeId, names, copied: true },
				opts.json === true,
			);
		});
}

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
			// masked previews only, so any service is readable
			const record = await fetchService(kind, id);
			printResult(
				{
					[idKey]: id,
					entries: environmentEntries(environmentDocument(kind, record)),
				},
				opts.json === true,
			);
		});

	env
		.command("url")
		.description(
			"show scheme, host, port, and database of a URL variable; credentials stay hidden",
		)
		.requiredOption(`--${idKey} <value>`, idKey)
		.requiredOption("--name <value>", "environment variable name")
		.option(
			"--reason <text>",
			"why this read is needed; shown in the approval dialog when the service is outside the agent policy",
		)
		.option("--json", "Output JSON")
		.action(async (opts: Record<string, unknown>) => {
			const id = String(opts[idKey]);
			const name = String(opts.name);
			const record = await fetchService(kind, id);
			const parts = environmentUrlParts(
				environmentDocument(kind, record),
				name,
			);
			const policy = options.agentSafe
				? readAgentDeployPolicyConfig()
				: undefined;
			const blocked =
				policy && servicePerimeterDenial(policy, kind, id, record);
			if (blocked) {
				await requireUserApproval(
					policy.approval,
					{
						...envApprovalRequest(
							kind,
							id,
							record,
							"url",
							[name],
							[
								{
									kind: "text",
									text: `read scheme, host, port, and database of ${name}`,
								},
								{
									kind: "text",
									text: "credentials and query string stay hidden",
								},
							],
							opts.reason,
						),
						endpoint: `${kind}.one`,
					},
					blocked,
				);
			}
			printResult({ [idKey]: id, name, ...parts }, opts.json === true);
		});

	if (kind === "application") registerEnvCopyCommand(env, options);

	const mutation = (
		name: string,
		description: string,
		flags: Array<[string, string]>,
		resultKey: string,
		edit: EnvEdit,
		describe: EnvDescribe,
		optional: Array<[string, string]> = [],
		risk?: EnvRisk,
	) => {
		const command = env
			.command(name)
			.description(description)
			.requiredOption(`--${idKey} <value>`, idKey);
		for (const [flag, help] of flags) command.requiredOption(flag, help);
		for (const [flag, help] of optional) command.option(flag, help);
		command
			.option(
				"--reason <text>",
				"why this change is needed; shown in the approval dialog when the service is outside the agent policy",
			)
			.option("--json", "Output JSON")
			.action(async (opts: Record<string, unknown>) => {
				const id = String(opts[idKey]);
				const record = await fetchService(kind, id);
				const policy = options.agentSafe
					? readAgentDeployPolicyConfig()
					: undefined;
				const outside =
					policy && servicePerimeterDenial(policy, kind, id, record);
				const document = environmentDocument(kind, record);
				const nextEnv = edit(document, opts);
				const blockedReasons = policy
					? [risk?.(opts), outside?.message].filter(
							(reason): reason is string => reason !== undefined,
						)
					: [];
				const names = [opts.name, opts.newName].filter(
					(value): value is string => typeof value === "string",
				);
				if (policy && blockedReasons.length > 0) {
					await requireUserApproval(
						policy.approval,
						envApprovalRequest(
							kind,
							id,
							record,
							name,
							names,
							describe(document, opts),
							opts.reason,
						),
						agentPolicyBlocked(blockedReasons.join("; ")),
					);
					const current = await fetchService(kind, id);
					if (!sameEnvState(kind, record, current)) {
						throw new CliError(
							"AGENT_APPROVAL_STALE",
							`${kind} ${id} environment changed while the approval dialog was open; nothing was written, retry to review the new state`,
						);
					}
				}
				await save(id, record, nextEnv);
				printResult(
					{
						[idKey]: id,
						name: opts.name,
						...(typeof opts.newName === "string"
							? { newName: opts.newName }
							: {}),
						[resultKey]: true,
					},
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
		(_document, opts) => [
			...(typeof opts.comment === "string" ? commentDiff(opts.comment) : []),
			quotedAssignment(String(opts.name), String(opts.value)),
		],
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
		(document, opts) => [
			...maskedAssignments(document, String(opts.name), "remove"),
			quotedAssignment(String(opts.name), String(opts.value)),
		],
	);
	mutation(
		"unset",
		"remove an environment variable without exposing other values",
		[["--name <value>", "environment variable name"]],
		"unset",
		(document, opts) => unsetEnvironmentVariable(document, String(opts.name)),
		(document, opts) =>
			maskedAssignments(document, String(opts.name), "remove"),
	);
	mutation(
		"rename",
		"rename an environment variable, keeping its value without exposing it",
		[
			["--name <value>", "existing environment variable name"],
			["--new-name <value>", "new environment variable name"],
		],
		"renamed",
		(document, opts) =>
			renameEnvironmentVariable(
				document,
				String(opts.name),
				String(opts.newName),
			),
		(document, opts) => {
			const removed = maskedAssignments(document, String(opts.name), "remove");
			return [
				...removed,
				...removed.map(({ text }) => ({
					kind: "add" as const,
					text: text.replace(String(opts.name), String(opts.newName)),
				})),
			];
		},
		[],
		(opts) => environmentRenameRisk(String(opts.name), String(opts.newName)),
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
		(document, opts) => [
			...commentDiff(String(opts.text)),
			...maskedAssignments(document, String(opts.name), "text"),
		],
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
