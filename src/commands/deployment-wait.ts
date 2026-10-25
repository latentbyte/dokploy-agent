import type { Command } from "commander";
import { CliError } from "../agent/errors.js";
import { redactString } from "../redact.js";
import { type DeploymentRecord, fetchDeployments } from "./deployment-logs.js";

type ServiceType = "application" | "compose";
type WaitState = "not_started" | "running" | "done" | "error" | "cancelled";

interface WaitTarget {
	type: ServiceType;
	id: string;
}

interface WaitOptions {
	applicationId?: string[];
	composeId?: string[];
	commit?: string;
	since?: string;
	timeout?: string;
	json?: boolean;
}

export interface ServiceWaitResult {
	type: ServiceType;
	id: string;
	state: WaitState;
	deploymentId?: string;
	title?: string;
	commit?: string;
	startedAt?: string;
	finishedAt?: string;
	durationSeconds?: number;
	typicalSeconds?: number;
	errorMessage?: string;
	logsCommand?: string;
}

export interface WaitResult {
	ok: boolean;
	timedOut: boolean;
	elapsedSeconds: number;
	services: ServiceWaitResult[];
}

interface WaitDeps {
	fetch: (target: WaitTarget) => Promise<DeploymentRecord[]>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	log: (line: string) => void;
	bin: string;
}

interface WaitConfig {
	targets: WaitTarget[];
	commit?: string;
	sinceMs?: number;
	timeoutMs: number;
}

const DEFAULT_TIMEOUT = "20m";
// default lookback so a deploy triggered just before the wait still counts
const DEFAULT_LOOKBACK_MS = 60_000;
const HISTORY_SAMPLES = 10;
const TERMINAL_STATES = new Set<WaitState>(["done", "error", "cancelled"]);
export const WAIT_TIMEOUT_EXIT_CODE = 124;

function parseDurationMs(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2] ?? "s";
	const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit] ?? 1000;
	return amount * factor;
}

function parseSince(value: string, now: number): number {
	const duration = parseDurationMs(value);
	if (duration !== undefined) return now - duration;
	const time = Date.parse(value);
	if (Number.isFinite(time)) return time;
	throw new CliError(
		"INVALID_OPTION",
		`--since must be a duration like 90s or 10m, or an ISO time; got ${JSON.stringify(value)}.`,
	);
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : undefined;
}

function deploymentStart(deployment: DeploymentRecord): number {
	return (
		parseTimestamp(deployment.startedAt) ??
		parseTimestamp(deployment.createdAt) ??
		0
	);
}

function deploymentCommit(deployment: DeploymentRecord): string | undefined {
	const description =
		typeof deployment.description === "string" ? deployment.description : "";
	return /Commit: ([0-9a-f]{7,40})/i.exec(description)?.[1]?.toLowerCase();
}

function stateOf(deployment: DeploymentRecord | undefined): WaitState {
	if (!deployment) return "not_started";
	const status = String(deployment.status ?? "").toLowerCase();
	if (status === "done" || status === "error" || status === "cancelled") {
		return status;
	}
	return "running";
}

function ownDeployments(deployments: DeploymentRecord[]): DeploymentRecord[] {
	return deployments
		.filter((deployment) => deployment.isPreviewDeployment !== true)
		.sort((a, b) => deploymentStart(b) - deploymentStart(a));
}

// newest deployment for the commit, or newest one started in the window or still running
function matchDeployment(
	deployments: DeploymentRecord[],
	config: Pick<WaitConfig, "commit" | "sinceMs">,
): DeploymentRecord | undefined {
	return ownDeployments(deployments).find((deployment) => {
		if (config.commit) {
			const commit = deploymentCommit(deployment);
			if (!commit?.startsWith(config.commit)) return false;
		}
		if (config.sinceMs === undefined) return true;
		return (
			deploymentStart(deployment) >= config.sinceMs ||
			stateOf(deployment) === "running"
		);
	});
}

function typicalSeconds(
	deployments: DeploymentRecord[],
	exclude?: string,
): number | undefined {
	const durations = ownDeployments(deployments)
		.filter(
			(deployment) =>
				deployment.status === "done" && deployment.deploymentId !== exclude,
		)
		.map((deployment) => {
			const finished = parseTimestamp(deployment.finishedAt);
			return finished === undefined
				? undefined
				: (finished - deploymentStart(deployment)) / 1000;
		})
		.filter((value): value is number => value !== undefined && value > 0)
		.slice(0, HISTORY_SAMPLES)
		.sort((a, b) => a - b);
	if (durations.length === 0) return undefined;
	return Math.round(durations[Math.floor(durations.length / 2)]);
}

// poll faster as the slowest-known remaining build nears its typical duration
function pollIntervalMs(results: ServiceWaitResult[], now: number): number {
	let interval = 15_000;
	for (const result of results) {
		if (TERMINAL_STATES.has(result.state)) continue;
		if (result.state === "not_started") {
			interval = Math.min(interval, 5_000);
			continue;
		}
		const started = parseTimestamp(result.startedAt);
		if (result.typicalSeconds === undefined || started === undefined) {
			interval = Math.min(interval, 5_000);
			continue;
		}
		const remaining = result.typicalSeconds - (now - started) / 1000;
		interval = Math.min(interval, remaining > 60 ? 15_000 : 5_000);
	}
	return interval;
}

function formatSeconds(seconds: number): string {
	const rounded = Math.round(seconds);
	if (rounded < 60) return `${rounded}s`;
	const minutes = Math.floor(rounded / 60);
	const rest = rounded % 60;
	return rest ? `${minutes}m${rest}s` : `${minutes}m`;
}

function targetSelector(target: WaitTarget): string {
	return target.type === "application"
		? `--applicationId ${target.id}`
		: `--composeId ${target.id}`;
}

function describeResult(result: ServiceWaitResult): string {
	const parts: string[] = [result.state];
	if (result.deploymentId) parts.push(`deployment ${result.deploymentId}`);
	if (result.durationSeconds !== undefined) {
		parts.push(`took ${formatSeconds(result.durationSeconds)}`);
	} else if (result.state === "running" && result.typicalSeconds) {
		parts.push(`typical ${formatSeconds(result.typicalSeconds)}`);
	}
	if (result.errorMessage) parts.push(result.errorMessage);
	return `${result.type} ${result.id}: ${parts.join(", ")}`;
}

function buildResult(
	target: WaitTarget,
	deployments: DeploymentRecord[],
	config: WaitConfig,
	bin: string,
): ServiceWaitResult {
	const deployment = matchDeployment(deployments, config);
	const state = stateOf(deployment);
	const result: ServiceWaitResult = {
		type: target.type,
		id: target.id,
		state,
		typicalSeconds: typicalSeconds(deployments, deployment?.deploymentId),
	};
	if (!deployment) return result;

	result.deploymentId = deployment.deploymentId;
	if (typeof deployment.title === "string") {
		result.title = redactString(deployment.title.split("\n")[0] ?? "");
	}
	result.commit = deploymentCommit(deployment);
	result.startedAt = deployment.startedAt ?? deployment.createdAt;
	if (TERMINAL_STATES.has(state)) {
		result.finishedAt = deployment.finishedAt;
		const finished = parseTimestamp(deployment.finishedAt);
		if (finished !== undefined) {
			result.durationSeconds = Math.round(
				(finished - deploymentStart(deployment)) / 1000,
			);
		}
	}
	if (state === "error" || state === "cancelled") {
		if (typeof deployment.errorMessage === "string") {
			result.errorMessage = redactString(deployment.errorMessage);
		}
		result.logsCommand = `${bin} deployment read-logs ${targetSelector(target)} --deploymentId ${deployment.deploymentId} --tail 200 --json`;
	}
	return result;
}

export async function waitForDeployments(
	config: WaitConfig,
	deps: WaitDeps,
): Promise<WaitResult> {
	const start = deps.now();
	const deadline = start + config.timeoutMs;
	const results = new Map<string, ServiceWaitResult>();
	const key = (target: WaitTarget) => `${target.type}:${target.id}`;

	while (true) {
		for (const target of config.targets) {
			const previous = results.get(key(target));
			if (previous && TERMINAL_STATES.has(previous.state)) continue;
			const next = buildResult(
				target,
				await deps.fetch(target),
				config,
				deps.bin,
			);
			results.set(key(target), next);
			if (
				previous?.state !== next.state ||
				previous?.deploymentId !== next.deploymentId
			) {
				const elapsed = formatSeconds((deps.now() - start) / 1000);
				deps.log(`[${elapsed}] ${describeResult(next)}`);
			}
		}

		const current = config.targets.map(
			(target) => results.get(key(target)) as ServiceWaitResult,
		);
		const done = current.every((result) => TERMINAL_STATES.has(result.state));
		const now = deps.now();
		if (done || now >= deadline) {
			return {
				ok: done && current.every((result) => result.state === "done"),
				timedOut: !done,
				elapsedSeconds: Math.round((now - start) / 1000),
				services: current,
			};
		}
		await deps.sleep(Math.min(pollIntervalMs(current, now), deadline - now));
	}
}

function collectIds(value: string, previous: string[] = []): string[] {
	return [
		...previous,
		...value
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean),
	];
}

function resolveConfig(opts: WaitOptions, now: number): WaitConfig {
	const targets: WaitTarget[] = [
		...(opts.applicationId ?? []).map((id) => ({
			type: "application" as const,
			id,
		})),
		...(opts.composeId ?? []).map((id) => ({ type: "compose" as const, id })),
	];
	if (targets.length === 0) {
		throw new CliError(
			"MISSING_OPTION",
			"Provide at least one --applicationId or --composeId.",
		);
	}

	const commit = opts.commit?.trim().toLowerCase();
	if (commit !== undefined && !/^[0-9a-f]{7,40}$/.test(commit)) {
		throw new CliError(
			"INVALID_OPTION",
			"--commit must be a 7-40 character hex SHA, e.g. $(git rev-parse HEAD).",
		);
	}

	const timeoutMs = parseDurationMs(opts.timeout ?? DEFAULT_TIMEOUT);
	if (timeoutMs === undefined || timeoutMs <= 0) {
		throw new CliError(
			"INVALID_OPTION",
			`--timeout must be a duration like 300s or 20m; got ${JSON.stringify(opts.timeout)}.`,
		);
	}

	let sinceMs: number | undefined;
	if (opts.since) sinceMs = parseSince(opts.since, now);
	else if (!commit) sinceMs = now - DEFAULT_LOOKBACK_MS;

	return { targets, commit, sinceMs, timeoutMs };
}

export function registerDeploymentWaitCommand(program: Command): void {
	const deployment =
		program.commands.find((command) => command.name() === "deployment") ??
		program.command("deployment").description("deployment commands");

	deployment
		.command("wait")
		.description(
			"Block until the matching deployment of each service finishes. Exit 0 when all are done, 1 if any failed, 124 on timeout",
		)
		.option(
			"--applicationId <id>",
			"application to watch; repeat or comma-separate for several",
			collectIds,
		)
		.option(
			"--composeId <id>",
			"compose service to watch; repeat or comma-separate for several",
			collectIds,
		)
		.option(
			"--commit <sha>",
			"wait for the deployment of this git commit (full SHA or 7+ char prefix)",
		)
		.option(
			"--since <when>",
			"match deployments started after this duration ago (90s, 10m) or ISO time. Default 60s, or any time with --commit",
		)
		.option("--timeout <duration>", "give up after this long", DEFAULT_TIMEOUT)
		.option("--json", "Output JSON result")
		.action(async (opts: WaitOptions) => {
			const config = resolveConfig(opts, Date.now());
			const bin = program.name();
			const result = await waitForDeployments(config, {
				fetch: (target) =>
					fetchDeployments(
						target.type === "application"
							? { applicationId: target.id }
							: { composeId: target.id },
					),
				sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
				now: Date.now,
				log: (line) => console.error(line),
				bin,
			});

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				const summary = result.timedOut
					? `timed out after ${formatSeconds(result.elapsedSeconds)}`
					: result.ok
						? `all deployments done in ${formatSeconds(result.elapsedSeconds)}`
						: `deployment failed after ${formatSeconds(result.elapsedSeconds)}`;
				console.log(summary);
				for (const service of result.services) {
					if (service.state === "done") continue;
					console.log(`  ${describeResult(service)}`);
					if (service.logsCommand)
						console.log(`  logs: ${service.logsCommand}`);
				}
			}

			if (result.timedOut) process.exitCode = WAIT_TIMEOUT_EXIT_CODE;
			else if (!result.ok) process.exitCode = 1;
		});
}

export const deploymentWaitInternals = {
	matchDeployment,
	parseDurationMs,
	pollIntervalMs,
	resolveConfig,
	typicalSeconds,
};
