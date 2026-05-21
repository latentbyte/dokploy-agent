import type { Command } from "commander";
import { apiGet } from "../client.js";
import { type SanitizeOptions, sanitizeForAgent } from "../redact.js";

type JsonObject = Record<string, unknown>;

interface ApplicationCandidate {
	applicationId: string;
	name?: string;
	appName?: string;
	project?: string;
	env?: string;
	status?: string;
}

interface ResolveOptions {
	applicationId?: string;
	appName?: string;
	name?: string;
	q?: string;
	project?: string;
	env?: string;
	projectId?: string;
	environmentId?: string;
	limit?: number;
}

interface ReadLogOptions extends ResolveOptions {
	tail?: number;
	since?: string;
	search?: string;
}

interface CollectContext {
	project?: string;
	env?: string;
}

function asObject(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

function getString(
	obj: JsonObject | undefined,
	...keys: string[]
): string | undefined {
	if (!obj) return undefined;
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function normalize(value: string | undefined): string | undefined {
	return value?.trim().toLowerCase();
}

function candidateFromObject(
	obj: JsonObject,
	context: CollectContext,
): ApplicationCandidate | undefined {
	const applicationId = getString(obj, "applicationId");
	if (!applicationId) return undefined;
	const environment = asObject(obj.environment);
	const project = asObject(obj.project) ?? asObject(environment?.project);
	return {
		applicationId,
		name: getString(obj, "name"),
		appName: getString(obj, "appName"),
		project: getString(project, "name", "projectName") ?? context.project,
		env: getString(environment, "name", "environmentName") ?? context.env,
		status: getString(obj, "status", "applicationStatus"),
	};
}

function childContext(
	obj: JsonObject,
	context: CollectContext,
): CollectContext {
	const nextContext = { ...context };
	if (Array.isArray(obj.environments) || Array.isArray(obj.environment)) {
		nextContext.project =
			getString(obj, "name", "projectName") ?? context.project;
	}
	if (Array.isArray(obj.applications)) {
		nextContext.env = getString(obj, "name", "environmentName") ?? context.env;
		const project = asObject(obj.project);
		nextContext.project =
			getString(project, "name", "projectName") ?? nextContext.project;
	}
	return nextContext;
}

function collectApplications(data: unknown): ApplicationCandidate[] {
	const candidates: ApplicationCandidate[] = [];
	const seenIds = new Set<string>();
	const seenObjects = new WeakSet<object>();

	const visit = (value: unknown, context: CollectContext) => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item, context);
			return;
		}

		const obj = asObject(value);
		if (!obj || seenObjects.has(obj)) return;
		seenObjects.add(obj);

		const nextContext = childContext(obj, context);
		const candidate = candidateFromObject(obj, nextContext);
		if (candidate && !seenIds.has(candidate.applicationId)) {
			seenIds.add(candidate.applicationId);
			candidates.push(candidate);
		}

		for (const nested of Object.values(obj)) {
			if (nested && typeof nested === "object") visit(nested, nextContext);
		}
	};

	visit(data, {});
	return candidates;
}

function selectorLabel(opts: ResolveOptions): string {
	if (opts.appName) return `appName ${opts.appName}`;
	if (opts.name) return `name ${opts.name}`;
	if (opts.q) return `query ${opts.q}`;
	return "application selector";
}

function searchTerm(opts: ResolveOptions): string | undefined {
	return opts.appName ?? opts.name ?? opts.q;
}

function matchesSelector(
	candidate: ApplicationCandidate,
	opts: ResolveOptions,
): boolean {
	const appName = normalize(opts.appName);
	const name = normalize(opts.name);
	const q = normalize(opts.q);
	const project = normalize(opts.project);
	const env = normalize(opts.env);

	if (appName && normalize(candidate.appName) !== appName) return false;
	if (name && normalize(candidate.name) !== name) return false;
	if (
		q &&
		!normalize(candidate.appName)?.includes(q) &&
		!normalize(candidate.name)?.includes(q)
	) {
		return false;
	}
	if (project && normalize(candidate.project) !== project) return false;
	if (env && normalize(candidate.env) !== env) return false;
	return true;
}

function pickExactMatches(
	candidates: ApplicationCandidate[],
	opts: ResolveOptions,
): ApplicationCandidate[] {
	const term = normalize(searchTerm(opts));
	if (!term) return candidates;
	return candidates.filter(
		(candidate) =>
			normalize(candidate.appName) === term ||
			normalize(candidate.name) === term,
	);
}

function formatCandidate(candidate: ApplicationCandidate): string {
	const name = candidate.name ?? candidate.appName ?? "unknown";
	const appName =
		candidate.appName && candidate.appName !== name
			? ` appName=${candidate.appName}`
			: "";
	const project = candidate.project ? ` project=${candidate.project}` : "";
	const env = candidate.env ? ` env=${candidate.env}` : "";
	const status = candidate.status ? ` status=${candidate.status}` : "";
	return `${name}${appName}${project}${env}${status}`;
}

function requireSelector(opts: ResolveOptions): void {
	if (opts.applicationId || opts.appName || opts.name || opts.q) return;
	throw new Error(
		"Provide --applicationId or a selector like --appName, --name, or --q.",
	);
}

function buildSearchParams(opts: ResolveOptions): Record<string, unknown> {
	const params: Record<string, unknown> = {
		limit: opts.limit ?? 10,
	};
	if (opts.appName) params.appName = opts.appName;
	else if (opts.name) params.name = opts.name;
	else if (opts.q) params.q = opts.q;
	if (opts.projectId) params.projectId = opts.projectId;
	if (opts.environmentId) params.environmentId = opts.environmentId;
	return params;
}

async function searchApplications(
	opts: ResolveOptions,
): Promise<ApplicationCandidate[]> {
	const data = await apiGet("application.search", buildSearchParams(opts));
	return collectApplications(data).filter((candidate) =>
		matchesSelector(candidate, opts),
	);
}

async function listProjectApplications(
	opts: ResolveOptions,
): Promise<ApplicationCandidate[]> {
	const data = await apiGet("project.all", {});
	return collectApplications(data).filter((candidate) =>
		matchesSelector(candidate, opts),
	);
}

async function resolveApplicationId(opts: ResolveOptions): Promise<string> {
	if (opts.applicationId) return opts.applicationId;
	requireSelector(opts);

	let candidates = await searchApplications(opts);
	let exactMatches = pickExactMatches(candidates, opts);

	if (
		exactMatches.length !== 1 &&
		(opts.project ||
			opts.env ||
			exactMatches.length === 0 ||
			candidates.length > 1)
	) {
		const inventoryCandidates = await listProjectApplications(opts);
		if (inventoryCandidates.length > 0) {
			candidates = inventoryCandidates;
			exactMatches = pickExactMatches(candidates, opts);
		}
	}

	const matches = exactMatches.length > 0 ? exactMatches : candidates;
	if (matches.length === 1) return matches[0].applicationId;
	if (matches.length === 0) {
		throw new Error(`No application matched ${selectorLabel(opts)}.`);
	}

	throw new Error(
		`Multiple applications matched ${selectorLabel(opts)}. Refine with --project, --env, --projectId, or --environmentId. Matches: ${matches.map(formatCandidate).join("; ")}`,
	);
}

function extractLocalLogOptions(
	opts: Record<string, unknown>,
): SanitizeOptions {
	return {
		logOutput: true,
		logSearch: getString(opts, "localSearch"),
		logContext:
			opts.localContext == null ? undefined : Number(opts.localContext),
		logCaseSensitive:
			opts.localCaseSensitive === true || opts.localCaseSensitive === "true",
		maxLogLines: opts.localTail == null ? undefined : Number(opts.localTail),
		maxLogChars:
			opts.localMaxChars == null ? undefined : Number(opts.localMaxChars),
	};
}

function printOutput(
	data: unknown,
	jsonOutput: boolean,
	localLogOptions: SanitizeOptions,
): void {
	const output = sanitizeForAgent(data, localLogOptions);
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

function toNumber(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	return Number(value);
}

function toReadLogOptions(opts: Record<string, unknown>): ReadLogOptions {
	return {
		applicationId: getString(opts, "applicationId"),
		appName: getString(opts, "appName"),
		name: getString(opts, "name"),
		q: getString(opts, "q"),
		project: getString(opts, "project"),
		env: getString(opts, "env"),
		projectId: getString(opts, "projectId"),
		environmentId: getString(opts, "environmentId"),
		limit: toNumber(opts.limit),
		tail: toNumber(opts.tail),
		since: getString(opts, "since"),
		search: getString(opts, "search"),
	};
}

export function registerApplicationLogCommands(program: Command): void {
	const application = program.commands.find(
		(command) => command.name() === "application",
	);
	application
		?.command("logs")
		.description("read application runtime logs by id, appName, name, or query")
		.option("--applicationId <value>", "applicationId")
		.option("--appName <value>", "resolve by Dokploy appName")
		.option("--name <value>", "resolve by application name")
		.option("--q <value>", "resolve by search query")
		.option("--project <value>", "filter by project name after search")
		.option("--env <value>", "filter by environment name after search")
		.option("--projectId <value>", "filter by projectId during search")
		.option("--environmentId <value>", "filter by environmentId during search")
		.option("--limit <value>", "search result limit")
		.option("--tail <value>", "tail")
		.option("--since <value>", "since")
		.option("--search <value>", "server-side search")
		.option(
			"--local-search <value>",
			"filter returned logs locally after redaction",
		)
		.option("--local-context <value>", "include N lines around local matches")
		.option("--local-case-sensitive", "use case-sensitive local log search")
		.option("--local-tail <value>", "limit printed logs to last N lines")
		.option("--local-max-chars <value>", "limit printed logs to last N chars")
		.option("--json", "Output JSON")
		.action(async (rawOpts: Record<string, unknown>) => {
			const jsonOutput = rawOpts.json === true;
			const localLogOptions = extractLocalLogOptions(rawOpts);
			const opts = toReadLogOptions(rawOpts);
			const applicationId = await resolveApplicationId(opts);
			const readOpts: Record<string, unknown> = { applicationId };
			if (opts.tail !== undefined) readOpts.tail = opts.tail;
			if (opts.since) readOpts.since = opts.since;
			if (opts.search) readOpts.search = opts.search;
			const data = await apiGet("application.readLogs", readOpts);
			printOutput(data, jsonOutput, localLogOptions);
		});
}

export const applicationLogsInternals = {
	collectApplications,
	matchesSelector,
	pickExactMatches,
};
