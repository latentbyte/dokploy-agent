import {
	type AgentDeployPolicyConfig,
	type AgentDeployProjectConfig,
	apiGet,
	applicationCandidateFromService,
	expandedApplicationAllowlistReason,
	isApplicationExpandedAllowed,
	readAgentDeployPolicyConfig,
} from "../client.js";
import { agentPolicyBlocked, CliError, cliErrorCode } from "./errors.js";

// classification tables shared by scripts/generate.ts and the runtime guards

// GET endpoints with side effects; agent-safe builds block them
export const MUTATING_GET_ENDPOINTS: ReadonlySet<string> = new Set([
	"cluster.addManager",
	"cluster.addWorker",
]);

// GET endpoints returning raw file contents that key-based redaction cannot vet
export const SECRET_READ_GET_ENDPOINTS: ReadonlySet<string> = new Set([
	"docker.readContainerFile",
	"dockerVolume.readVolumeFile",
]);

// update fields agents must change through constrained commands instead
export const AGENT_PROTECTED_UPDATE_FIELDS: ReadonlyMap<
	string,
	ReadonlySet<string>
> = new Map([
	[
		"application.update",
		new Set([
			"env",
			"previewEnv",
			"buildArgs",
			"previewBuildArgs",
			"buildSecrets",
			"previewBuildSecrets",
			"password",
			"refreshToken",
		]),
	],
	["compose.update", new Set(["env", "refreshToken"])],
]);

const AGENT_GIT_SOURCE_TYPES: ReadonlySet<string> = new Set([
	"bitbucket",
	"git",
	"gitea",
	"github",
	"gitlab",
]);

// endpoints that take watchPaths alone on any readable git-backed service,
// outside the deploy perimeter: watch paths only pick which pushes auto-deploy.
// save-*-provider also forces sourceType, so the stored source must already
// match, and record fill sends stored values for the other fields
const AGENT_WATCH_PATH_ENDPOINTS: ReadonlyMap<
	string,
	{ kind: "application" | "compose"; sourceTypes: ReadonlySet<string> }
> = new Map([
	[
		"application.saveBitbucketProvider",
		{ kind: "application", sourceTypes: new Set(["bitbucket"]) },
	],
	[
		"application.saveGiteaProvider",
		{ kind: "application", sourceTypes: new Set(["gitea"]) },
	],
	[
		"application.saveGithubProvider",
		{ kind: "application", sourceTypes: new Set(["github"]) },
	],
	[
		"application.saveGitlabProvider",
		{ kind: "application", sourceTypes: new Set(["gitlab"]) },
	],
	[
		"application.saveGitProvider",
		{ kind: "application", sourceTypes: new Set(["git"]) },
	],
	["compose.update", { kind: "compose", sourceTypes: AGENT_GIT_SOURCE_TYPES }],
]);

export const AGENT_EXPANDED_APPLICATION_ENDPOINTS = [
	"application.cancelDeployment",
	"application.cleanQueues",
	"application.clearDeployments",
	"application.delete",
	"application.disconnectGitProvider",
	"application.killBuild",
	"application.markRunning",
	"application.move",
	"application.refreshToken",
	"application.saveBitbucketProvider",
	"application.saveBuildType",
	"application.saveDockerProvider",
	"application.saveEnvironment",
	"application.saveGiteaProvider",
	"application.saveGithubProvider",
	"application.saveGitProvider",
	"application.saveGitlabProvider",
	"application.updateTraefikConfig",
] as const;

// expanded endpoints that deploy-project applications get too: each is a
// narrower form of application.update, which those applications already have,
// so agents can configure apps they create without allowlist edits. delete,
// move, disconnect, env, token, and Traefik writes stay expanded-only
export const AGENT_DEPLOY_PROJECT_APPLICATION_ENDPOINTS = [
	"application.cancelDeployment",
	"application.cleanQueues",
	"application.killBuild",
	"application.saveBitbucketProvider",
	"application.saveBuildType",
	"application.saveDockerProvider",
	"application.saveGiteaProvider",
	"application.saveGithubProvider",
	"application.saveGitProvider",
	"application.saveGitlabProvider",
] as const satisfies readonly (typeof AGENT_EXPANDED_APPLICATION_ENDPOINTS)[number][];

// git provider id fields and the Dokploy endpoint listing configured providers
const AGENT_GIT_PROVIDER_LISTS = [
	["githubId", "github.githubProviders"],
	["gitlabId", "gitlab.gitlabProviders"],
	["giteaId", "gitea.giteaProviders"],
	["bitbucketId", "bitbucket.bitbucketProviders"],
] as const;

export const AGENT_DATABASE_KINDS = [
	"libsql",
	"mariadb",
	"mongo",
	"mysql",
	"postgres",
	"redis",
] as const;

export type AgentDatabaseKind = (typeof AGENT_DATABASE_KINDS)[number];
export type AgentServiceKind = "application" | "compose" | AgentDatabaseKind;

const AGENT_DEPLOY_SERVICE_MUTATIONS = [
	"application.deploy",
	"application.redeploy",
	"application.update",
	"compose.deploy",
	"compose.isolatedDeployment",
	"compose.update",
] as const;

// start/stop/reload on any writable service; reload also takes appName, which
// must match the target so a permitted id cannot restart another service
const AGENT_SERVICE_LIFECYCLE_MUTATIONS = [
	"application.reload",
	"application.start",
	"application.stop",
	"compose.start",
	"compose.stop",
	...AGENT_DATABASE_KINDS.flatMap((kind) => [
		`${kind}.reload`,
		`${kind}.start`,
		`${kind}.stop`,
	]),
];

const AGENT_DEPLOY_DOMAIN_MUTATIONS = ["domain.create"] as const;
const AGENT_DOMAIN_DELETE = "domain.delete";

// POST endpoints agents may call; each is guarded by guardAgentSafePost
export const SAFE_POST_ENDPOINTS: ReadonlySet<string> = new Set([
	"application.create",
	...AGENT_DEPLOY_SERVICE_MUTATIONS,
	...AGENT_EXPANDED_APPLICATION_ENDPOINTS,
	...AGENT_SERVICE_LIFECYCLE_MUTATIONS,
	"compose.create",
	...AGENT_DEPLOY_DOMAIN_MUTATIONS,
	AGENT_DOMAIN_DELETE,
	"mounts.create",
	"port.create",
	"volumeBackups.create",
	"volumeBackups.runManually",
	...AGENT_DATABASE_KINDS.flatMap((kind) => [
		`${kind}.create`,
		`${kind}.deploy`,
	]),
]);

const AGENT_DEPLOY_SERVICE_MUTATION_SET: ReadonlySet<string> = new Set(
	AGENT_DEPLOY_SERVICE_MUTATIONS,
);
const AGENT_DEPLOY_DOMAIN_MUTATION_SET: ReadonlySet<string> = new Set(
	AGENT_DEPLOY_DOMAIN_MUTATIONS,
);
const AGENT_SERVICE_LIFECYCLE_MUTATION_SET: ReadonlySet<string> = new Set(
	AGENT_SERVICE_LIFECYCLE_MUTATIONS,
);
const AGENT_EXPANDED_APPLICATION_MUTATIONS: ReadonlySet<string> = new Set(
	AGENT_EXPANDED_APPLICATION_ENDPOINTS,
);
const AGENT_DEPLOY_PROJECT_APPLICATION_MUTATIONS: ReadonlySet<string> = new Set(
	AGENT_DEPLOY_PROJECT_APPLICATION_ENDPOINTS,
);
const AGENT_DATABASE_KIND_SET: ReadonlySet<string> = new Set(
	AGENT_DATABASE_KINDS,
);

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function agentDeployServerLabel(server: { serverId: string; name?: string }) {
	return `${server.name ? `${server.name} ` : ""}(${server.serverId})`;
}

function ensureAgentDeployServer(
	policy: AgentDeployPolicyConfig,
	serverId: string | undefined,
	label = "serverId",
) {
	if (!serverId || policy.allowAnyServer) return undefined;
	const server = policy.servers.find(
		(candidate) => candidate.serverId === serverId,
	);
	if (server) return server;
	throw agentPolicyBlocked(
		"agent-safe deploy policy rejects " +
			label +
			" " +
			serverId +
			"; allowed servers: " +
			policy.servers.map(agentDeployServerLabel).join(", "),
	);
}

function agentDeployProjectLabel(project: {
	projectName: string;
	environmentName: string;
	environmentId: string;
}) {
	return (
		project.projectName +
		"/" +
		project.environmentName +
		" (" +
		project.environmentId +
		")"
	);
}

function allowedAgentDeployProject(
	policy: AgentDeployPolicyConfig,
	environmentId: string | undefined,
) {
	if (!environmentId) return policy.projects[0];
	return policy.projects.find(
		(project) => project.environmentId === environmentId,
	);
}

function ensureAgentDeployEnvironment(
	policy: AgentDeployPolicyConfig,
	opts: Record<string, any>,
) {
	const project = allowedAgentDeployProject(policy, opts.environmentId);
	if (project) return project;
	throw agentPolicyBlocked(
		"agent-safe deploy policy rejects environmentId " +
			opts.environmentId +
			"; allowed projects: " +
			policy.projects.map(agentDeployProjectLabel).join(", "),
	);
}

function normalizeAgentDeployCreate(
	policy: AgentDeployPolicyConfig,
	opts: Record<string, any>,
) {
	const project = ensureAgentDeployEnvironment(policy, opts);
	opts.environmentId = project.environmentId;
	ensureAgentDeployServer(policy, stringValue(opts.serverId), "serverId");
	if (!opts.serverId && !policy.allowAnyServer)
		opts.serverId = policy.servers[0]?.serverId;
}

function serviceProjectName(service: any): string | undefined {
	return (
		stringValue(service?.environment?.project?.name) ??
		stringValue(service?.project?.name)
	);
}

function serviceMatchesAgentDeployProject(
	project: AgentDeployProjectConfig,
	service: any,
) {
	const projectMatches = project.projectId
		? service?.environment?.project?.projectId === project.projectId
		: serviceProjectName(service) === project.projectName;
	return service?.environmentId === project.environmentId && projectMatches;
}

function serviceServerId(service: any): string | undefined {
	return (
		stringValue(service?.serverId) ??
		stringValue(service?.server?.serverId) ??
		stringValue(service?.buildServer?.serverId) ??
		stringValue(service?.buildServerId)
	);
}

function validateAgentDeployServerIds(
	policy: AgentDeployPolicyConfig,
	labelsToServerIds: Array<{ label: string; serverId: string | undefined }>,
) {
	const seen = new Set<string>();
	for (const { label, serverId } of labelsToServerIds) {
		if (!serverId || seen.has(serverId)) continue;
		seen.add(serverId);
		ensureAgentDeployServer(policy, serverId, label);
	}
}

function assertServiceServersAllowed(
	policy: AgentDeployPolicyConfig,
	service: any,
) {
	validateAgentDeployServerIds(policy, [
		{ label: "serverId", serverId: stringValue(service?.serverId) },
		{ label: "buildServerId", serverId: stringValue(service?.buildServerId) },
		{
			label: "server.serverId",
			serverId: stringValue(service?.server?.serverId),
		},
		{
			label: "buildServer.serverId",
			serverId: stringValue(service?.buildServer?.serverId),
		},
	]);
}

function assertServiceRecordInDeployProject(
	policy: AgentDeployPolicyConfig,
	kind: AgentServiceKind,
	id: string,
	service: any,
) {
	if (
		!policy.projects.some((project) =>
			serviceMatchesAgentDeployProject(project, service),
		)
	) {
		const serviceProject =
			service?.environment?.project?.name ??
			service?.project?.name ??
			"unknown";
		const serviceEnvironment =
			service?.environment?.name ?? service?.environmentId ?? "unknown";
		throw agentPolicyBlocked(
			`agent-safe deploy policy rejects ${kind} ${id} in ${serviceProject}/${serviceEnvironment}; allowed projects: ${policy.projects.map(agentDeployProjectLabel).join(", ")}`,
		);
	}
	assertServiceServersAllowed(policy, service);
}

async function assertAgentServiceInDeployProject(
	policy: AgentDeployPolicyConfig,
	kind: AgentServiceKind,
	id: string | undefined,
) {
	if (!id)
		throw agentPolicyBlocked(`agent-safe deploy policy requires ${kind} id`);
	const service = await apiGet(`${kind}.one`, { [`${kind}Id`]: id });
	assertServiceRecordInDeployProject(policy, kind, id, service);
	return service;
}

async function assertExpandedApplicationAllowed(
	policy: AgentDeployPolicyConfig,
	applicationId: string | undefined,
) {
	if (!applicationId) {
		throw agentPolicyBlocked(
			"agent-safe deploy policy requires applicationId for this operation",
		);
	}
	const application = await apiGet("application.one", { applicationId });
	if (
		isApplicationExpandedAllowed(
			policy,
			applicationCandidateFromService(application, applicationId),
		)
	) {
		assertServiceServersAllowed(policy, application);
		return application;
	}
	throw agentPolicyBlocked(
		`agent-safe deploy policy requires application in ${expandedApplicationAllowlistReason()} for this operation; deploy-project applications do not get it`,
	);
}

// applications are writable when expanded-allowlisted or inside a deploy project
export function assertApplicationRecordWritable(
	policy: AgentDeployPolicyConfig,
	applicationId: string,
	application: any,
) {
	if (
		isApplicationExpandedAllowed(
			policy,
			applicationCandidateFromService(application, applicationId),
		)
	) {
		assertServiceServersAllowed(policy, application);
		return;
	}
	assertServiceRecordInDeployProject(
		policy,
		"application",
		applicationId,
		application,
	);
}

// env overlays check the record they already fetched; compose and databases
// have no expanded allowlist, so they must sit in a deploy project
export function assertServiceRecordWritable(
	policy: AgentDeployPolicyConfig,
	kind: AgentServiceKind,
	id: string,
	record: any,
) {
	if (kind === "application") {
		assertApplicationRecordWritable(policy, id, record);
		return;
	}
	assertServiceRecordInDeployProject(policy, kind, id, record);
}

async function assertApplicationWritable(
	policy: AgentDeployPolicyConfig,
	applicationId: string | undefined,
) {
	if (!applicationId) {
		throw agentPolicyBlocked("agent-safe deploy policy requires applicationId");
	}
	const application = await apiGet("application.one", { applicationId });
	assertApplicationRecordWritable(policy, applicationId, application);
	return application;
}

// configure endpoints for expanded or deploy-project applications; the latter
// keep application.update's protected fields so the shortcut grants nothing new
async function assertDeployProjectApplicationOperation(
	policy: AgentDeployPolicyConfig,
	endpoint: string,
	opts: Record<string, any>,
) {
	const applicationId = stringValue(opts.applicationId);
	if (!applicationId) {
		throw agentPolicyBlocked(`agent-safe ${endpoint} requires applicationId`);
	}
	const application = await apiGet("application.one", { applicationId });
	assertApplicationRecordWritable(policy, applicationId, application);
	if (
		!isApplicationExpandedAllowed(
			policy,
			applicationCandidateFromService(application, applicationId),
		)
	) {
		const protectedFields =
			AGENT_PROTECTED_UPDATE_FIELDS.get("application.update");
		const forbiddenFields = Object.keys(opts).filter((field) =>
			protectedFields?.has(field),
		);
		if (forbiddenFields.length > 0) {
			throw agentPolicyBlocked(
				`agent-safe ${endpoint} rejects protected fields for deploy-project applications: ${forbiddenFields.join(", ")}`,
			);
		}
	}
	await assertAgentGitProvidersConfigured(opts);
}

// provider ids must name a git provider configured in Dokploy, so a write
// cannot point a service at credentials the operator never set up
async function assertAgentGitProvidersConfigured(opts: Record<string, any>) {
	for (const [field, endpoint] of AGENT_GIT_PROVIDER_LISTS) {
		const providerId = stringValue(opts[field]);
		if (!providerId) continue;
		const providers = await apiGet(endpoint, {});
		const configured = Array.isArray(providers)
			? providers.some((provider) => provider?.[field] === providerId)
			: false;
		if (configured) continue;
		throw agentPolicyBlocked(
			`agent-safe deploy policy rejects ${field} ${providerId}; not a git provider configured in Dokploy (see ${endpoint})`,
		);
	}
}

async function assertAgentServiceLifecycleAllowed(
	policy: AgentDeployPolicyConfig,
	endpoint: string,
	opts: Record<string, any>,
) {
	const kind = endpoint.split(".")[0] as AgentServiceKind;
	const id = stringValue(opts[`${kind}Id`]);
	const service =
		kind === "application"
			? await assertApplicationWritable(policy, id)
			: await assertAgentServiceInDeployProject(policy, kind, id);
	if (endpoint.endsWith(".reload") && opts.appName !== service?.appName) {
		throw agentPolicyBlocked(
			`agent-safe ${endpoint} requires appName to match ${kind} ${id}`,
		);
	}
}

function databaseKindForEndpoint(endpoint: string) {
	const kind = endpoint.split(".")[0];
	return AGENT_DATABASE_KIND_SET.has(kind)
		? (kind as AgentDatabaseKind)
		: undefined;
}

function agentDeployDomainSuffixesForServer(
	policy: AgentDeployPolicyConfig,
	serverId: string | undefined,
) {
	if (!serverId) return policy.domainSuffixes;
	const server = ensureAgentDeployServer(policy, serverId, "serverId");
	return server?.domainSuffixes?.length
		? server.domainSuffixes
		: policy.domainSuffixes;
}

function normalizeAgentDomainHost(value: unknown): string | undefined {
	const host = stringValue(value);
	if (!host) return undefined;
	try {
		return new URL(host.includes("://") ? host : `https://${host}`).hostname
			.toLowerCase()
			.replace(/\.$/, "");
	} catch {
		return undefined;
	}
}

function matchingAgentDomainSuffix(host: string, suffixes: string[]) {
	return suffixes
		.filter((suffix) => host.endsWith(suffix))
		.filter((suffix) => {
			const domainName = host.slice(0, -suffix.length);
			return domainName.length > 0 && !domainName.includes(".");
		})
		.sort((a, b) => b.length - a.length)[0];
}

function assertAgentDomainHost(
	policy: AgentDeployPolicyConfig,
	host: string | undefined,
	serverId: string | undefined,
) {
	if (!host) return;
	const normalizedHost = normalizeAgentDomainHost(host);
	const allowedSuffixes = agentDeployDomainSuffixesForServer(policy, serverId);
	const domainSuffix = normalizedHost
		? matchingAgentDomainSuffix(normalizedHost, allowedSuffixes)
		: undefined;
	if (!normalizedHost || !domainSuffix) {
		throw agentPolicyBlocked(
			"agent-safe deploy policy rejects host " +
				host +
				"; allowed wildcard domains: *" +
				allowedSuffixes.join(", *"),
		);
	}
	if (!policy.domainNameSuffix) return;
	const domainName = normalizedHost.slice(0, -domainSuffix.length);
	if (domainName.endsWith(policy.domainNameSuffix)) return;
	throw agentPolicyBlocked(
		"agent-safe deploy policy rejects host " +
			host +
			"; domain name before " +
			domainSuffix +
			" must end with: " +
			policy.domainNameSuffix,
	);
}

function collectDokployDomainHosts(
	value: unknown,
	hosts = new Set<string>(),
): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) collectDokployDomainHosts(item, hosts);
		return hosts;
	}
	if (!value || typeof value !== "object") return hosts;
	for (const [key, item] of Object.entries(value)) {
		if (
			key === "host" ||
			key === "hostname" ||
			key === "domain" ||
			key === "url"
		) {
			const host = normalizeAgentDomainHost(item);
			if (host) hosts.add(host);
		}
		collectDokployDomainHosts(item, hosts);
	}
	return hosts;
}

async function assertAgentDomainHostUnused(host: string | undefined) {
	const normalizedHost = normalizeAgentDomainHost(host);
	if (!normalizedHost)
		throw agentPolicyBlocked("agent-safe domain.create requires a valid host");
	const inventory = await apiGet("project.all", {});
	if (collectDokployDomainHosts(inventory).has(normalizedHost)) {
		throw agentPolicyBlocked(
			"agent-safe domain.create rejects host " +
				normalizedHost +
				"; domain is already in use in Dokploy",
		);
	}
}

async function assertAgentDomainInDeployProject(
	policy: AgentDeployPolicyConfig,
	opts: Record<string, any>,
) {
	if (opts.applicationId) {
		return assertAgentServiceInDeployProject(
			policy,
			"application",
			opts.applicationId,
		);
	}
	if (opts.composeId) {
		return assertAgentServiceInDeployProject(policy, "compose", opts.composeId);
	}
	if (!opts.domainId)
		throw agentPolicyBlocked(
			"agent-safe deploy policy requires applicationId, composeId, or domainId for domain writes",
		);
	const domain = await apiGet("domain.one", { domainId: opts.domainId });
	if (domain?.applicationId) {
		return assertAgentServiceInDeployProject(
			policy,
			"application",
			domain.applicationId,
		);
	}
	if (domain?.composeId) {
		return assertAgentServiceInDeployProject(
			policy,
			"compose",
			domain.composeId,
		);
	}
	throw agentPolicyBlocked(
		"agent-safe deploy policy could not resolve domain parent service",
	);
}

// mirrors domain.create: parent must be in a deploy project (expanded rights do
// not apply) and the host must be one the agent could have created
async function assertAgentDomainDeletable(
	policy: AgentDeployPolicyConfig,
	domainId: string | undefined,
) {
	if (!domainId)
		throw agentPolicyBlocked(
			`agent-safe ${AGENT_DOMAIN_DELETE} requires domainId`,
		);
	const domain = await apiGet("domain.one", { domainId });
	const applicationId = stringValue(domain?.applicationId);
	const composeId = stringValue(domain?.composeId);
	if (!applicationId && !composeId) {
		throw agentPolicyBlocked(
			`agent-safe ${AGENT_DOMAIN_DELETE} allows only application or compose domains`,
		);
	}
	const service = applicationId
		? await assertAgentServiceInDeployProject(
				policy,
				"application",
				applicationId,
			)
		: await assertAgentServiceInDeployProject(policy, "compose", composeId);
	const host = stringValue(domain?.host);
	if (!host)
		throw agentPolicyBlocked(
			`agent-safe ${AGENT_DOMAIN_DELETE} requires a domain host`,
		);
	assertAgentDomainHost(policy, host, serviceServerId(service));
}

const AGENT_VOLUME_BACKUP_SERVICE_KINDS: ReadonlySet<string> = new Set([
	"application",
	"compose",
	...AGENT_DATABASE_KINDS,
]);

function volumeBackupParentFromOpts(opts: Record<string, any>) {
	const serviceType = stringValue(opts.serviceType);
	if (serviceType && AGENT_VOLUME_BACKUP_SERVICE_KINDS.has(serviceType)) {
		return { kind: serviceType, id: stringValue(opts[`${serviceType}Id`]) };
	}
	for (const kind of AGENT_VOLUME_BACKUP_SERVICE_KINDS) {
		const id = stringValue(opts[`${kind}Id`]);
		if (id) return { kind, id };
	}
	return undefined;
}

async function assertAgentVolumeBackupParentWritable(
	policy: AgentDeployPolicyConfig,
	opts: Record<string, any>,
	endpoint: string,
) {
	const parent = volumeBackupParentFromOpts(opts);
	if (!parent?.id) {
		throw agentPolicyBlocked(
			`agent-safe ${endpoint} requires a parent service id`,
		);
	}
	const kind = parent.kind as AgentServiceKind;
	if (kind === "application") {
		return assertApplicationWritable(policy, parent.id);
	}
	return assertAgentServiceInDeployProject(policy, kind, parent.id);
}

async function assertAgentVolumeBackupWritable(
	policy: AgentDeployPolicyConfig,
	volumeBackupId: string | undefined,
	endpoint: string,
) {
	if (!volumeBackupId)
		throw agentPolicyBlocked(`agent-safe ${endpoint} requires volumeBackupId`);
	const backup = await apiGet("volumeBackups.one", { volumeBackupId });
	return assertAgentVolumeBackupParentWritable(policy, backup ?? {}, endpoint);
}

// Dokploy deploys when micromatch(changedFiles, watchPaths) matches, with no
// options: files are repo-relative, so "/src/**" or a bare "src/" never match,
// and an empty pattern makes micromatch throw
function assertAgentWatchPaths(watchPaths: unknown) {
	if (!Array.isArray(watchPaths)) return;
	const invalid = watchPaths.filter((path) => {
		if (typeof path !== "string") return false;
		const pattern = path.trim().replace(/^!/, "");
		return pattern === "" || pattern.startsWith("/") || pattern.endsWith("/");
	});
	if (invalid.length === 0) return;
	throw new CliError(
		"INVALID_WATCH_PATHS",
		`watchPaths entries never match in Dokploy: ${invalid.map((path) => JSON.stringify(path)).join(", ")}; use repo-relative globs without a leading slash, e.g. "src/**" (dotfiles need explicit patterns like ".github/**")`,
	);
}

// a body of only the service id and watchPaths skips the deploy perimeter;
// reason explains a watchPaths-only body the exception still rejects
async function agentWatchPathOnlyWrite(
	endpoint: string,
	opts: Record<string, any>,
): Promise<{ allowed: boolean; reason?: string }> {
	const target = AGENT_WATCH_PATH_ENDPOINTS.get(endpoint);
	if (!target || opts.watchPaths === undefined) return { allowed: false };
	const idKey = `${target.kind}Id`;
	const id = stringValue(opts[idKey]);
	const onlyWatchPaths = Object.keys(opts).every(
		(field) =>
			field === idKey || field === "watchPaths" || opts[field] === undefined,
	);
	if (!id || !onlyWatchPaths) return { allowed: false };
	const service = await apiGet(`${target.kind}.one`, { [idKey]: id });
	const sourceType = stringValue(service?.sourceType);
	if (sourceType && target.sourceTypes.has(sourceType))
		return { allowed: true };
	return {
		allowed: false,
		reason: `${target.kind} ${id} has sourceType ${sourceType ?? "unknown"}, ${endpoint} needs ${[...target.sourceTypes].join("|")}`,
	};
}

export async function guardAgentSafePost(
	endpoint: string,
	opts: Record<string, any>,
) {
	if (opts.watchPaths != null) assertAgentWatchPaths(opts.watchPaths);
	const watchPathWrite = await agentWatchPathOnlyWrite(endpoint, opts);
	if (watchPathWrite.allowed) return;
	try {
		await guardAgentPerimeterPost(endpoint, opts);
	} catch (error) {
		if (
			!watchPathWrite.reason ||
			cliErrorCode(error) !== "AGENT_POLICY_BLOCKED"
		)
			throw error;
		throw agentPolicyBlocked(
			`${(error as Error).message}; watchPaths-only exception does not apply: ${watchPathWrite.reason}`,
		);
	}
}

async function guardAgentPerimeterPost(
	endpoint: string,
	opts: Record<string, any>,
) {
	const forbiddenUpdateFields = AGENT_PROTECTED_UPDATE_FIELDS.get(endpoint);
	const forbiddenFields = Object.keys(opts).filter((field) =>
		forbiddenUpdateFields?.has(field),
	);
	if (forbiddenFields.length > 0) {
		throw agentPolicyBlocked(
			"agent-safe " +
				endpoint +
				" rejects protected fields: " +
				forbiddenFields.join(", ") +
				"; use constrained commands",
		);
	}
	const policy = readAgentDeployPolicyConfig();
	const databaseKind = databaseKindForEndpoint(endpoint);
	if (
		endpoint === "application.create" ||
		endpoint === "compose.create" ||
		(databaseKind && endpoint.endsWith(".create"))
	) {
		normalizeAgentDeployCreate(policy, opts);
		return;
	}
	if (databaseKind && endpoint.endsWith(".deploy")) {
		await assertAgentServiceInDeployProject(
			policy,
			databaseKind,
			opts[`${databaseKind}Id`],
		);
		return;
	}
	if (AGENT_SERVICE_LIFECYCLE_MUTATION_SET.has(endpoint)) {
		await assertAgentServiceLifecycleAllowed(policy, endpoint, opts);
		return;
	}
	if (AGENT_DEPLOY_PROJECT_APPLICATION_MUTATIONS.has(endpoint)) {
		await assertDeployProjectApplicationOperation(policy, endpoint, opts);
		return;
	}
	if (AGENT_EXPANDED_APPLICATION_MUTATIONS.has(endpoint)) {
		await assertExpandedApplicationAllowed(policy, opts.applicationId);
		return;
	}
	if (endpoint === "mounts.create") {
		if (opts.serviceType !== "application") {
			throw agentPolicyBlocked(
				"agent-safe mounts.create allows only allowlisted applications",
			);
		}
		await assertExpandedApplicationAllowed(policy, opts.serviceId);
		return;
	}
	if (endpoint === "port.create") {
		await assertExpandedApplicationAllowed(policy, opts.applicationId);
		return;
	}
	if (endpoint === "volumeBackups.create") {
		await assertAgentVolumeBackupParentWritable(policy, opts, endpoint);
		return;
	}
	if (endpoint === "volumeBackups.runManually") {
		await assertAgentVolumeBackupWritable(
			policy,
			opts.volumeBackupId,
			endpoint,
		);
		return;
	}
	if (AGENT_DEPLOY_SERVICE_MUTATION_SET.has(endpoint)) {
		ensureAgentDeployEnvironment(policy, opts);
		ensureAgentDeployServer(policy, stringValue(opts.serverId), "serverId");
		ensureAgentDeployServer(
			policy,
			stringValue(opts.buildServerId),
			"buildServerId",
		);
		if (endpoint.startsWith("application.")) {
			await assertApplicationWritable(policy, opts.applicationId);
		} else {
			await assertAgentServiceInDeployProject(
				policy,
				"compose",
				opts.composeId,
			);
		}
		await assertAgentGitProvidersConfigured(opts);
		return;
	}
	if (AGENT_DEPLOY_DOMAIN_MUTATION_SET.has(endpoint)) {
		const service = await assertAgentDomainInDeployProject(policy, opts);
		assertAgentDomainHost(policy, opts.host, serviceServerId(service));
		await assertAgentDomainHostUnused(opts.host);
		return;
	}
	if (endpoint === AGENT_DOMAIN_DELETE) {
		await assertAgentDomainDeletable(policy, opts.domainId);
		return;
	}
	throw agentPolicyBlocked(
		`agent-safe deploy policy does not allow write endpoint ${endpoint}`,
	);
}

type ResolvedApplication = Record<string, string | undefined>;

// one project.all pass: expanded-allowlisted apps plus deploy-project apps,
// which agents may create, configure, and deploy but not delete or move
async function resolvePolicyApplications(policy: AgentDeployPolicyConfig) {
	const data = await apiGet("project.all", {});
	const projects = Array.isArray(data)
		? data
		: Array.isArray(data?.projects)
			? data.projects
			: [];
	const expandedApplications: ResolvedApplication[] = [];
	const managedApplications: ResolvedApplication[] = [];
	const seenExpanded = new Set<string>();
	const seenManaged = new Set<string>();
	for (const project of projects) {
		const environments = Array.isArray(project?.environments)
			? project.environments
			: [];
		for (const environment of environments) {
			const applications = Array.isArray(environment?.applications)
				? environment.applications
				: [];
			for (const application of applications) {
				const applicationId = stringValue(application?.applicationId);
				const candidate = {
					applicationId,
					name: stringValue(application?.name),
					appName: stringValue(application?.appName),
					projectName: stringValue(project?.name),
					projectId: stringValue(project?.projectId),
					environmentName: stringValue(environment?.name),
					environmentId:
						stringValue(environment?.environmentId) ??
						stringValue(application?.environmentId),
				};
				const key =
					applicationId ??
					[
						candidate.projectName,
						candidate.environmentName,
						candidate.name,
					].join("/");
				const summary = {
					name: candidate.name,
					appName: candidate.appName,
					applicationId: candidate.applicationId,
					projectName: candidate.projectName,
					environmentName: candidate.environmentName,
				};
				if (
					!seenManaged.has(key) &&
					policy.projects.some((deployProject) =>
						candidateInDeployProject(deployProject, candidate),
					)
				) {
					seenManaged.add(key);
					managedApplications.push(summary);
				}
				if (
					!seenExpanded.has(key) &&
					isApplicationExpandedAllowed(policy, candidate)
				) {
					seenExpanded.add(key);
					expandedApplications.push(summary);
				}
			}
		}
	}
	return { expandedApplications, managedApplications };
}

// same match as serviceMatchesAgentDeployProject, on a project.all entry
function candidateInDeployProject(
	project: AgentDeployProjectConfig,
	candidate: {
		projectId?: string;
		projectName?: string;
		environmentId?: string;
	},
) {
	const projectMatches = project.projectId
		? candidate.projectId === project.projectId
		: candidate.projectName === project.projectName;
	return candidate.environmentId === project.environmentId && projectMatches;
}

async function agentDeployPolicy() {
	const policy = readAgentDeployPolicyConfig();
	return {
		...policy,
		...(await resolvePolicyApplications(policy)),
		examples: [
			"dokploy-agent compose create --name demo --composeType docker-compose --composeFile <compose.yaml>",
			"dokploy-agent application create --name demo" +
				(policy.allowAnyServer
					? ""
					: ` --serverId ${policy.servers[0]?.serverId}`),
			"dokploy-agent domain create --composeId <id> --host demo" +
				(policy.domainNameSuffix ?? "") +
				policy.domainSuffixes[0] +
				" --https --certificateType letsencrypt --domainType compose",
			"dokploy-agent application save-github-provider --applicationId <id from create> --githubId <id from github github-providers> --owner <owner> --repository <repo> --branch main",
		],
	};
}

function printResolvedApplications(applications: ResolvedApplication[]) {
	if (applications.length === 0) console.log("- (none)");
	for (const application of applications) {
		console.log(
			`- ${application.name} (${application.applicationId}) in ${application.projectName}/${application.environmentName}`,
		);
	}
}

export async function printAgentDeployPolicy(jsonOutput: boolean) {
	const policy = await agentDeployPolicy();
	if (jsonOutput) {
		console.log(JSON.stringify(policy, null, 2));
		return;
	}
	console.log("agent-safe deploy policy");
	console.log("projects:");
	for (const project of policy.projects)
		console.log(`- ${agentDeployProjectLabel(project)}`);
	console.log("servers:");
	if (policy.allowAnyServer)
		console.log("- * (all servers, including the local Dokploy server)");
	for (const server of policy.servers)
		console.log(
			"- " +
				agentDeployServerLabel(server) +
				(server.hint ? ` ${server.hint}` : ""),
		);
	console.log(`domain suffixes: ${policy.domainSuffixes.join(", ")}`);
	for (const server of policy.servers) {
		if (server.domainSuffixes?.length)
			console.log(
				"domain suffixes for " +
					agentDeployServerLabel(server) +
					": " +
					server.domainSuffixes.join(", "),
			);
	}
	console.log(`domain name suffix: ${policy.domainNameSuffix ?? "(none)"}`);
	console.log(
		"expanded application IDs: " +
			(policy.expandedApplicationIds.join(", ") || "(none)"),
	);
	console.log("expanded projects:");
	if (policy.expandedProjects.length === 0) console.log("- (none)");
	for (const project of policy.expandedProjects) {
		const parts = [project.projectName];
		if (project.projectId) parts.push(`id=${project.projectId}`);
		if (project.environmentNames)
			parts.push(`envs=${project.environmentNames.join("|") || "(none)"}`);
		parts.push(
			project.applicationNames === undefined
				? "apps=*"
				: project.applicationNames.length === 0
					? "apps=(none)"
					: `apps=${project.applicationNames.join("|")}`,
		);
		console.log(`- ${parts.join(" ")}`);
	}
	if (policy.expandedApplicationNames.length > 0) {
		console.log(
			"legacy expanded application names (prefer expandedProjects): " +
				policy.expandedApplicationNames.join(", "),
		);
	}
	console.log(
		"managed applications (deploy projects: create, configure, deploy; no delete/move):",
	);
	printResolvedApplications(policy.managedApplications);
	console.log("resolved expanded applications:");
	printResolvedApplications(policy.expandedApplications);
	console.log("examples:");
	for (const example of policy.examples) console.log(example);
}
