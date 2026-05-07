import * as crypto from "node:crypto";
import * as net from "node:net";
import * as tls from "node:tls";
import { apiGet, readAuthConfig } from "../src/client.js";

interface DeploymentRecord {
	logPath?: string;
	buildServerId?: string;
	serverId?: string;
	application?: {
		buildServer?: { serverId?: string };
		server?: { serverId?: string };
	};
	compose?: {
		server?: { serverId?: string };
	};
}

interface ProbeResult {
	upgraded: boolean;
	status?: string;
	bytes: number;
	closeCode?: number;
	closeReasonLen?: number;
	error?: string;
}

function getServerId(deployment: DeploymentRecord): string | undefined {
	return (
		deployment.buildServerId ??
		deployment.serverId ??
		deployment.application?.buildServer?.serverId ??
		deployment.application?.server?.serverId ??
		deployment.compose?.server?.serverId
	);
}

function buildRequest(
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

function readFrames(buffer: Buffer, result: ProbeResult): Buffer {
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
			length = Number(buffer.readBigUInt64BE(offset + 2));
			headerLength = 10;
		}

		const maskLength = masked ? 4 : 0;
		const frameLength = headerLength + maskLength + length;
		if (buffer.length - offset < frameLength) break;

		let payload = buffer.subarray(
			offset + headerLength + maskLength,
			offset + frameLength,
		);
		if (masked) {
			const mask = buffer.subarray(
				offset + headerLength,
				offset + headerLength + 4,
			);
			const output = Buffer.alloc(payload.length);
			for (let index = 0; index < payload.length; index += 1) {
				output[index] = payload[index] ^ mask[index % 4];
			}
			payload = output;
		}

		if (opcode === 1 || opcode === 2) {
			result.bytes += payload.length;
		} else if (opcode === 8) {
			result.closeCode =
				payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
			result.closeReasonLen = Math.max(0, payload.length - 2);
		}

		offset += frameLength;
	}
	return buffer.subarray(offset);
}

async function probeDeploymentLogs(
	logPath: string,
	serverId: string | undefined,
): Promise<ProbeResult> {
	const auth = readAuthConfig();
	const baseUrl = new URL(auth.url);
	const secure = baseUrl.protocol === "https:";
	const port = baseUrl.port ? Number(baseUrl.port) : secure ? 443 : 80;
	const url = new URL(auth.url);
	url.pathname = "/listen-deployment";
	url.searchParams.set("logPath", logPath);
	if (serverId) url.searchParams.set("serverId", serverId);

	return new Promise((resolve) => {
		const result: ProbeResult = { upgraded: false, bytes: 0 };
		let buffer = Buffer.alloc(0);
		let requestSent = false;
		const socket = secure
			? tls.connect({ host: url.hostname, port, servername: url.hostname })
			: net.connect({ host: url.hostname, port });

		const done = () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(done, 2500);
		const sendRequest = () => {
			if (requestSent) return;
			requestSent = true;
			socket.write(
				buildRequest(
					url,
					auth.url,
					auth.token,
					crypto.randomBytes(16).toString("base64"),
				),
			);
		};

		if (secure) socket.on("secureConnect", sendRequest);
		else socket.on("connect", sendRequest);
		socket.on("error", (err) => {
			result.error = err.message;
			done();
		});
		socket.on("close", done);
		socket.on("end", done);
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (!result.upgraded) {
				const headerEnd = buffer.indexOf("\r\n\r\n");
				if (headerEnd === -1) return;
				const header = buffer.subarray(0, headerEnd).toString("latin1");
				buffer = buffer.subarray(headerEnd + 4);
				result.status = header.split("\r\n")[0];
				result.upgraded = result.status?.includes(" 101 ") ?? false;
				if (!result.upgraded) done();
			}
			buffer = readFrames(buffer, result);
			if (result.closeCode) done();
		});
	});
}

const deployments = (await apiGet(
	"deployment.allCentralized",
)) as DeploymentRecord[];
const deployment = deployments.find(
	(item) => item.logPath && getServerId(item),
);
if (!deployment?.logPath) {
	throw new Error("No deployment with logPath and server metadata found.");
}

const serverId = getServerId(deployment);
const withoutServer = await probeDeploymentLogs(deployment.logPath, undefined);
const withServer = await probeDeploymentLogs(deployment.logPath, serverId);
console.log(
	JSON.stringify(
		{
			deploymentCount: deployments.length,
			selected: {
				hasLogPath: Boolean(deployment.logPath),
				hasServerId: Boolean(serverId),
			},
			withoutServer,
			withServer,
		},
		null,
		2,
	),
);
