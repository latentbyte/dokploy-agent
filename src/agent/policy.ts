import {
	type AgentDeployPolicyConfig,
	type AgentDeployProjectConfig,
	apiGet,
	applicationCandidateFromService,
	expandedApplicationAllowlistReason,
	hasExpandedApplicationAllowlist,
	isApplicationExpandedAllowed,
	readAgentDeployPolicyConfig,
} from "../client.js";
import { agentPolicyBlocked } from "./errors.js";

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

export const AGENT_DATABASE_KINDS = [
	"libsql",
	"mariadb",
	"mongo",
	"mysql",
	"postgres",
	"redis",
] as const;

type AgentDatabaseKind = (typeof AGENT_DATABASE_KINDS)[number];
type AgentServiceKind = "application" | "compose" | AgentDatabaseKind;

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

// POST endpoints agents may call; each is guarded by guardAgentSafePost
export const SAFE_POST_ENDPOINTS: ReadonlySet<string> = new Set([
	"application.create",
	...AGENT_DEPLOY_SERVICE_MUTATIONS,
	...AGENT_EXPANDED_APPLICATION_ENDPOINTS,
	...AGENT_SERVICE_LIFECYCLE_MUTATIONS,
	"compose.create",
	...AGENT_DEPLOY_DOMAIN_MUTATIONS,
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
		`agent-safe deploy policy requires application in ${expandedApplicationAllowlistReason()} for this operation`,
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

// env overlays check the record they already fetched; compose has no expanded
// allowlist, so it must sit in a deploy project
export function assertServiceRecordWritable(
	policy: AgentDeployPolicyConfig,
	kind: "application" | "compose",
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

export async function guardAgentSafePost(
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
		return;
	}
	if (AGENT_DEPLOY_DOMAIN_MUTATION_SET.has(endpoint)) {
		const service = await assertAgentDomainInDeployProject(policy, opts);
		assertAgentDomainHost(policy, opts.host, serviceServerId(service));
		await assertAgentDomainHostUnused(opts.host);
		return;
	}
	throw agentPolicyBlocked(
		`agent-safe deploy policy does not allow write endpoint ${endpoint}`,
	);
}

async function resolveExpandedApplications(policy: AgentDeployPolicyConfig) {
	if (!hasExpandedApplicationAllowlist(policy)) return [];
	const data = await apiGet("project.all", {});
	const projects = Array.isArray(data)
		? data
		: Array.isArray(data?.projects)
			? data.projects
			: [];
	const matches: Array<Record<string, string | undefined>> = [];
	const seen = new Set<string>();
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
				if (!isApplicationExpandedAllowed(policy, candidate)) continue;
				const key =
					applicationId ??
					[
						candidate.projectName,
						candidate.environmentName,
						candidate.name,
					].join("/");
				if (seen.has(key)) continue;
				seen.add(key);
				matches.push({
					name: candidate.name,
					appName: candidate.appName,
					applicationId: candidate.applicationId,
					projectName: candidate.projectName,
					environmentName: candidate.environmentName,
				});
			}
		}
	}
	return matches;
}

async function agentDeployPolicy() {
	const policy = readAgentDeployPolicyConfig();
	return {
		...policy,
		expandedApplications: await resolveExpandedApplications(policy),
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
		],
	};
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
	console.log("resolved expanded applications:");
	for (const application of policy.expandedApplications) {
		console.log(
			"- " +
				application.name +
				" (" +
				application.applicationId +
				") in " +
				application.projectName +
				"/" +
				application.environmentName,
		);
	}
	console.log("examples:");
	for (const example of policy.examples) console.log(example);
}
