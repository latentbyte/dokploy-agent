import * as path from "node:path";
import { parse } from "yaml";

// compose files an agent writes run as root-capable containers on a Dokploy
// server, so anything reaching the host (privileged mode, host namespaces,
// host paths, foreign volumes) or routing outside domain.create (Traefik
// router labels) is rejected. Relative paths may reach the service's own
// Dokploy directory, e.g. ../files/config.json, but nothing above it

// Dokploy checks raw compose files out to <base>/<appName>/code
const COMPOSE_CODE_DIR = "/compose/app/code";
const COMPOSE_SERVICE_DIR = "/compose/app/";

const HOST_NAMESPACE_KEYS = [
	"network_mode",
	"pid",
	"ipc",
	"uts",
	"userns_mode",
	"cgroup",
] as const;
const FORBIDDEN_LIST_KEYS = [
	"cap_add",
	"security_opt",
	"devices",
	"device_cgroup_rules",
] as const;
// labels that only tune routing Dokploy's own domains set up
const ALLOWED_TRAEFIK_LABEL =
	/^traefik\.(?:enable|docker\.network|swarm\.network|http\.services\.[^.]+\.loadbalancer\.server\.(?:port|scheme))$/;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: undefined;
}

function isEmpty(value: unknown): boolean {
	if (value == null || value === false) return true;
	if (Array.isArray(value)) return value.length === 0;
	const record = asRecord(value);
	return record ? Object.keys(record).length === 0 : false;
}

// a host path stays inside the service's own Dokploy directory
function hostPathProblem(source: string): string | undefined {
	if (source.includes("$")) return "uses variable interpolation";
	if (source.startsWith("/") || source.startsWith("~"))
		return "is an absolute host path";
	const resolved = path.posix.normalize(
		path.posix.join(COMPOSE_CODE_DIR, source),
	);
	if (!resolved.startsWith(COMPOSE_SERVICE_DIR))
		return "leaves the service directory";
	return undefined;
}

function looksLikePath(source: string): boolean {
	return (
		source.startsWith(".") ||
		source.startsWith("/") ||
		source.startsWith("~") ||
		source.includes("/") ||
		source.includes("$")
	);
}

function labelKeys(labels: unknown): string[] {
	if (Array.isArray(labels)) {
		return labels
			.filter((label): label is string => typeof label === "string")
			.map((label) => label.split("=")[0].trim());
	}
	return Object.keys(asRecord(labels) ?? {});
}

/** traefik label keys outside the service-port allowlist */
export function forbiddenTraefikLabels(labels: unknown): string[] {
	return labelKeys(labels).filter(
		(key) =>
			key.toLowerCase().startsWith("traefik.") &&
			!ALLOWED_TRAEFIK_LABEL.test(key),
	);
}

function volumeProblems(
	where: string,
	entry: unknown,
	declaredVolumes: Set<string>,
): string[] {
	let source: string | undefined;
	let type: string | undefined;
	if (typeof entry === "string") {
		const parts = entry.split(":");
		// "target" alone is an anonymous volume
		if (parts.length > 1) source = parts[0];
	} else {
		const record = asRecord(entry);
		if (!record) return [`${where} has an unreadable volume entry`];
		type = typeof record.type === "string" ? record.type : undefined;
		source = typeof record.source === "string" ? record.source : undefined;
		if (type === "npipe" || type === "cluster")
			return [`${where} mounts a ${type} volume`];
	}
	if (!source) return [];
	if (type === "bind" || looksLikePath(source)) {
		const problem = hostPathProblem(source);
		return problem ? [`${where} bind mount ${source} ${problem}`] : [];
	}
	if (!declaredVolumes.has(source))
		return [`${where} mounts volume ${source} not declared in this file`];
	return [];
}

function pathListProblems(
	where: string,
	value: unknown,
	key = "path",
): string[] {
	const entries = Array.isArray(value) ? value : value == null ? [] : [value];
	const problems: string[] = [];
	for (const entry of entries) {
		const source =
			typeof entry === "string" ? entry : (asRecord(entry)?.[key] as unknown);
		if (typeof source !== "string") continue;
		const problem = hostPathProblem(source);
		if (problem) problems.push(`${where} ${source} ${problem}`);
	}
	return problems;
}

function buildContextProblem(where: string, context: unknown) {
	if (typeof context !== "string") return [];
	// remote git or http contexts never read the host
	if (/^(?:[a-z]+:\/\/|git@)/i.test(context)) return [];
	return pathListProblems(where, context);
}

function serviceProblems(
	name: string,
	service: Json,
	declaredVolumes: Set<string>,
): string[] {
	const where = `service ${name}`;
	const problems: string[] = [];
	if (service.privileged !== undefined && service.privileged !== false)
		problems.push(`${where} sets privileged`);
	for (const key of FORBIDDEN_LIST_KEYS) {
		if (!isEmpty(service[key])) problems.push(`${where} sets ${key}`);
	}
	if (service.cgroup_parent !== undefined)
		problems.push(`${where} sets cgroup_parent`);
	for (const key of HOST_NAMESPACE_KEYS) {
		const value = service[key];
		if (value === undefined) continue;
		const text = String(value);
		if (text === "host" || text.startsWith("container:") || text.includes("$"))
			problems.push(`${where} sets ${key}: ${text}`);
	}
	for (const entry of Array.isArray(service.volumes) ? service.volumes : []) {
		problems.push(...volumeProblems(where, entry, declaredVolumes));
	}
	for (const entry of Array.isArray(service.volumes_from)
		? service.volumes_from
		: []) {
		if (typeof entry === "string" && entry.startsWith("container:"))
			problems.push(`${where} takes volumes_from ${entry}`);
	}
	problems.push(...pathListProblems(`${where} env_file`, service.env_file));
	const build = service.build;
	if (typeof build === "string") {
		problems.push(...buildContextProblem(`${where} build context`, build));
	} else if (asRecord(build)) {
		const record = asRecord(build) as Json;
		problems.push(
			...buildContextProblem(`${where} build context`, record.context),
		);
		for (const [key, context] of Object.entries(
			asRecord(record.additional_contexts) ?? {},
		)) {
			problems.push(
				...buildContextProblem(`${where} build context ${key}`, context),
			);
		}
		if (
			typeof record.dockerfile === "string" &&
			record.dockerfile.startsWith("/")
		)
			problems.push(`${where} dockerfile is an absolute host path`);
	}
	const extendsFile = asRecord(service.extends)?.file;
	if (extendsFile !== undefined)
		problems.push(...pathListProblems(`${where} extends`, extendsFile));
	const labels = [
		...forbiddenTraefikLabels(service.labels),
		...forbiddenTraefikLabels(asRecord(service.deploy)?.labels),
	];
	if (labels.length > 0)
		problems.push(
			`${where} sets Traefik labels ${labels.join(", ")}; route through domain create`,
		);
	return problems;
}

/** reasons the compose file is unsafe for an agent to deploy; empty if fine */
export function composeFileProblems(text: string): string[] {
	let document: unknown;
	try {
		document = parse(text, { merge: true, maxAliasCount: 100 });
	} catch (error) {
		return [`compose file is not valid YAML: ${(error as Error).message}`];
	}
	const root = asRecord(document);
	if (!root) return ["compose file must be a YAML mapping"];
	const problems: string[] = [];
	if (root.include !== undefined)
		problems.push("compose file uses include; inline the services instead");

	const declaredVolumes = new Set<string>();
	for (const [name, volume] of Object.entries(asRecord(root.volumes) ?? {})) {
		declaredVolumes.add(name);
		const record = asRecord(volume);
		if (!record) continue;
		for (const key of ["external", "name", "driver", "driver_opts"]) {
			if (record[key] !== undefined && record[key] !== false)
				problems.push(`volume ${name} sets ${key}`);
		}
	}
	for (const section of ["configs", "secrets"]) {
		for (const [name, entry] of Object.entries(asRecord(root[section]) ?? {})) {
			const record = asRecord(entry);
			if (record?.file !== undefined)
				problems.push(
					...pathListProblems(`${section} ${name} file`, record.file),
				);
		}
	}
	for (const [name, service] of Object.entries(asRecord(root.services) ?? {})) {
		const record = asRecord(service);
		if (record)
			problems.push(...serviceProblems(name, record, declaredVolumes));
	}
	return problems;
}
