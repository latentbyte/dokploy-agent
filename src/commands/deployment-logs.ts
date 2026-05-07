import * as crypto from "node:crypto";
import * as net from "node:net";
import * as tls from "node:tls";
import chalk from "chalk";
import type { Command } from "commander";
import { apiGet, formatCliError, readAuthConfig } from "../client.js";
import { filterLogString, limitLogString, redactString } from "../redact.js";

interface DeploymentRecord {
	deploymentId?: string;
	logPath?: string;
	createdAt?: string;
	startedAt?: string;
	finishedAt?: string;
	[key: string]: unknown;
}

interface DeploymentLogOptions {
	logPath?: string;
	deploymentId?: string;
	applicationId?: string;
	composeId?: string;
	serverId?: string;
	id?: string;
	type?: string;
	tail?: string | number;
	search?: string;
	context?: string | number;
	caseSensitive?: boolean | string;
	timeout?: string | number;
	idleTimeout?: string | number;
	maxChars?: string | number;
	json?: boolean;
}

interface ResolvedDeploymentLog {
	logPath: string;
	deploymentId?: string;
	deployment?: DeploymentRecord;
}

interface WebSocketReadOptions {
	timeoutMs: number;
	idleTimeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 2_000;
const DEFAULT_TAIL_LINES = 500;
const DEFAULT_MAX_CHARS = 50_000;

function asNumber(
	value: string | number | undefined,
	fallback: number,
): number {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(value: boolean | string | undefined): boolean {
	return value === true || value === "true";
}

function deploymentTimeValue(deployment: DeploymentRecord): number {
	const raw =
		deployment.startedAt ?? deployment.createdAt ?? deployment.finishedAt;
	if (!raw) return 0;
	const time = Date.parse(raw);
	return Number.isFinite(time) ? time : 0;
}

async function fetchDeployments(
	opts: DeploymentLogOptions,
): Promise<DeploymentRecord[]> {
	let data: unknown;
	if (opts.applicationId) {
		data = await apiGet("deployment.all", {
			applicationId: opts.applicationId,
		});
	} else if (opts.composeId) {
		data = await apiGet("deployment.allByCompose", {
			composeId: opts.composeId,
		});
	} else if (opts.serverId) {
		data = await apiGet("deployment.allByServer", { serverId: opts.serverId });
	} else if (opts.id && opts.type) {
		data = await apiGet("deployment.allByType", {
			id: opts.id,
			type: opts.type,
		});
	} else if (opts.deploymentId) {
		data = await apiGet("deployment.allCentralized");
	} else {
		throw new Error(
			"Provide --logPath, --deploymentId, or a source selector like --applicationId, --composeId, --serverId, or --id with --type.",
		);
	}

	if (!Array.isArray(data)) {
		throw new Error("Deployment list response was not an array.");
	}
	return data as DeploymentRecord[];
}

async function resolveDeploymentLogCandidates(
	opts: DeploymentLogOptions,
): Promise<ResolvedDeploymentLog[]> {
	if (opts.logPath) {
		return [
			{
				logPath: opts.logPath,
				deploymentId: opts.deploymentId,
			},
		];
	}

	const deployments = await fetchDeployments(opts);
	const candidates = opts.deploymentId
		? deployments.filter(
				(deployment) => deployment.deploymentId === opts.deploymentId,
			)
		: [...deployments].sort(
				(a, b) => deploymentTimeValue(b) - deploymentTimeValue(a),
			);

	if (candidates.length === 0) {
		throw new Error("No matching deployment found.");
	}

	const withLogs = candidates
		.filter((deployment) => deployment.logPath)
		.map((deployment) => ({
			logPath: deployment.logPath as string,
			deploymentId: deployment.deploymentId,
			deployment,
		}));

	if (withLogs.length === 0) {
		throw new Error("No matching deployment includes a logPath.");
	}

	return withLogs;
}

function buildWebSocketRequest(
	url: URL,
	origin: string,
	token: string,
	key: string,
): string {
	const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
	return [
		`GET ${url.pathname}${url.search} HTTP/1.1`,
		`Host: ${host}`,
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Key: ${key}`,
		"Sec-WebSocket-Version: 13",
		`Origin: ${origin}`,
		`x-api-key: ${token}`,
		"",
		"",
	].join("\r\n");
}

function decodeFramePayload(
	frame: Buffer<ArrayBufferLike>,
	masked: boolean,
): Buffer<ArrayBufferLike> {
	if (!masked) return frame;
	const mask = frame.subarray(0, 4);
	const payload = frame.subarray(4);
	const output = Buffer.alloc(payload.length);
	for (let index = 0; index < payload.length; index += 1) {
		output[index] = payload[index] ^ mask[index % 4];
	}
	return output;
}

function consumeFrames(
	buffer: Buffer<ArrayBufferLike>,
	onFrame: (opcode: number, payload: Buffer<ArrayBufferLike>) => void,
): Buffer<ArrayBufferLike> {
	let offset = 0;
	while (buffer.length - offset >= 2) {
		const first = buffer[offset];
		const second = buffer[offset + 1];
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		let length = second & 0x7f;
		let headerLength = 2;

		if (length === 126) {
			if (buffer.length - offset < 4) break;
			length = buffer.readUInt16BE(offset + 2);
			headerLength = 4;
		} else if (length === 127) {
			if (buffer.length - offset < 10) break;
			const bigLength = buffer.readBigUInt64BE(offset + 2);
			if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
				throw new Error("WebSocket frame too large.");
			}
			length = Number(bigLength);
			headerLength = 10;
		}

		const maskLength = masked ? 4 : 0;
		const frameLength = headerLength + maskLength + length;
		if (buffer.length - offset < frameLength) break;

		const frame = buffer.subarray(offset + headerLength, offset + frameLength);
		onFrame(opcode, decodeFramePayload(frame, masked));
		offset += frameLength;
	}

	return buffer.subarray(offset);
}

async function readDeploymentLogWebSocket(
	logPath: string,
	options: WebSocketReadOptions,
): Promise<string> {
	const auth = readAuthConfig();
	const baseUrl = new URL(auth.url);
	const secure = baseUrl.protocol === "https:";
	const port = baseUrl.port ? Number(baseUrl.port) : secure ? 443 : 80;
	const url = new URL(auth.url);
	url.pathname = "/listen-deployment";
	url.search = `?logPath=${encodeURIComponent(logPath)}`;

	return new Promise((resolve, reject) => {
		let settled = false;
		let upgraded = false;
		let receivedFrame = false;
		let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let requestSent = false;
		const chunks: string[] = [];
		const key = crypto.randomBytes(16).toString("base64");

		const socket = secure
			? tls.connect({ host: url.hostname, port, servername: url.hostname })
			: net.connect({ host: url.hostname, port });

		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(totalTimer);
			clearInterval(idleTimer);
			socket.destroy();
			if (err) {
				reject(err);
				return;
			}
			resolve(chunks.join(""));
		};

		const totalTimer = setTimeout(() => finish(), options.timeoutMs);
		const idleTimer = setInterval(() => {
			if (receivedFrame) finish();
		}, options.idleTimeoutMs);

		const sendRequest = () => {
			if (requestSent) return;
			requestSent = true;
			socket.write(buildWebSocketRequest(url, auth.url, auth.token, key));
		};

		if (secure) {
			socket.on("secureConnect", sendRequest);
		} else {
			socket.on("connect", sendRequest);
		}
		socket.on("error", (err) => finish(err));
		socket.on("end", () => finish());
		socket.on("data", (chunk: Buffer<ArrayBufferLike>) => {
			try {
				buffer = Buffer.concat([buffer, chunk]);

				if (!upgraded) {
					const headerEnd = buffer.indexOf("\r\n\r\n");
					if (headerEnd === -1) return;

					const header = buffer.subarray(0, headerEnd).toString("latin1");
					buffer = buffer.subarray(headerEnd + 4);
					const statusLine = header.split("\r\n")[0] ?? "";
					if (!statusLine.includes(" 101 ")) {
						finish(
							new Error(
								`Deployment log WebSocket upgrade failed: ${statusLine}`,
							),
						);
						return;
					}
					upgraded = true;
				}

				buffer = consumeFrames(buffer, (opcode, payload) => {
					if (opcode === 8) {
						finish();
						return;
					}
					if (opcode === 1 || opcode === 2 || opcode === 0) {
						receivedFrame = true;
						chunks.push(payload.toString("utf8"));
					}
				});
			} catch (err) {
				finish(err instanceof Error ? err : new Error(String(err)));
			}
		});
	});
}

function isMissingDeploymentLog(input: string): boolean {
	const lower = input.toLowerCase();
	return (
		lower.includes("tail: cannot open") &&
		lower.includes("no such file or directory")
	);
}

function formatDeploymentLogOutput(
	input: string,
	opts: DeploymentLogOptions,
): string {
	const context = asNumber(opts.context, 0);
	const tail = asNumber(opts.tail, DEFAULT_TAIL_LINES);
	const maxChars = asNumber(opts.maxChars, DEFAULT_MAX_CHARS);
	const redacted = redactString(input);
	const filtered = filterLogString(
		redacted,
		opts.search,
		context,
		asBool(opts.caseSensitive),
	);
	return limitLogString(filtered, tail, maxChars);
}

export function registerDeploymentLogsCommand(program: Command): void {
	const deployment =
		program.commands.find((command) => command.name() === "deployment") ??
		program.command("deployment").description("deployment commands");

	deployment
		.command("read-logs")
		.description("deployment readLogs")
		.option("--logPath <value>", "logPath from deployment metadata")
		.option("--deploymentId <value>", "deploymentId")
		.option("--applicationId <value>", "applicationId")
		.option("--composeId <value>", "composeId")
		.option("--serverId <value>", "serverId")
		.option("--id <value>", "entity id for deployment all-by-type")
		.option(
			"--type <value>",
			"entity type for deployment all-by-type (application, compose, server, schedule, previewDeployment, backup, volumeBackup)",
		)
		.option("--tail <value>", "Limit printed logs to last N lines")
		.option("--search <value>", "Filter logs locally after redaction")
		.option("--context <value>", "Include N lines around search matches")
		.option("--case-sensitive", "Use case-sensitive search")
		.option("--timeout <value>", "Max seconds to listen for logs")
		.option("--idle-timeout <value>", "Seconds to wait after last frame")
		.option("--max-chars <value>", "Limit printed logs to last N chars")
		.option("--json", "Output raw JSON")
		.action(async (opts: DeploymentLogOptions) => {
			try {
				const exactLog = Boolean(opts.logPath || opts.deploymentId);
				const candidates = await resolveDeploymentLogCandidates(opts);
				let resolved = candidates[0];
				let logs = "";
				let skippedMissingLogs = 0;
				let triedLogs = 0;

				for (const candidate of candidates) {
					resolved = candidate;
					triedLogs += 1;
					logs = await readDeploymentLogWebSocket(candidate.logPath, {
						timeoutMs: asNumber(opts.timeout, DEFAULT_TIMEOUT_MS / 1000) * 1000,
						idleTimeoutMs:
							asNumber(opts.idleTimeout, DEFAULT_IDLE_TIMEOUT_MS / 1000) * 1000,
					});

					if (exactLog || !isMissingDeploymentLog(logs)) break;
					skippedMissingLogs += 1;
				}

				if (isMissingDeploymentLog(logs)) {
					throw new Error(
						`Deployment log file not found for ${resolved.deploymentId ?? resolved.logPath}. Tried ${triedLogs} deployment log(s). Logs may have been cleaned up or stored on a build server.`,
					);
				}

				const output = formatDeploymentLogOutput(logs, opts);

				if (opts.json) {
					console.log(
						JSON.stringify(
							{
								deploymentId: resolved.deploymentId,
								logPath: resolved.logPath,
								skippedMissingLogs,
								logs: output,
							},
							null,
							2,
						),
					);
					return;
				}

				console.log(output || chalk.green("OK"));
			} catch (err) {
				console.error(chalk.red(formatCliError(err)));
				process.exitCode = 1;
			}
		});
}

export const deploymentLogsInternals = {
	buildWebSocketRequest,
	consumeFrames,
	formatDeploymentLogOutput,
	isMissingDeploymentLog,
};
