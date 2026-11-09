import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../src/client.js";
import { deploymentLogsInternals } from "../src/commands/deployment-logs.js";

const makeSocketFactory = (): FakeSocket => new FakeSocket();

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function textFrame(text: string): Buffer {
	const payload = Buffer.from(text, "utf8");
	return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

class FakeSocket extends EventEmitter {
	public destroyed = false;
	public writes: string[] = [];
	write(chunk: string): void {
		this.writes.push(chunk);
	}
	destroy(): void {
		super.emit("close");
		this.destroyed = true;
	}
}

describe("deployment log helpers", () => {
	it("should build a websocket request with auth header", () => {
		const request = deploymentLogsInternals.buildWebSocketRequest(
			new URL(
				"https://dokploy.example.com/listen-deployment?logPath=%2Ftmp%2Fdeploy.log",
			),
			"https://dokploy.example.com",
			"secret-token",
			"ws-key",
		);

		expect(request).toContain(
			"GET /listen-deployment?logPath=%2Ftmp%2Fdeploy.log HTTP/1.1",
		);
		expect(request).toContain("Host: dokploy.example.com");
		expect(request).toContain("Upgrade: websocket");
		expect(request).toContain("x-api-key: secret-token");
	});

	it("should consume text websocket frames", () => {
		const frames: string[] = [];
		const remaining = deploymentLogsInternals.consumeFrames(
			textFrame("deploy ok"),
			(_opcode, payload) => frames.push(payload.toString("utf8")),
		);

		expect(remaining.length).toBe(0);
		expect(frames).toEqual(["deploy ok"]);
	});

	it("should resolve deployment log server ids from deployment metadata", () => {
		expect(
			deploymentLogsInternals.deploymentServerId({
				buildServerId: "build-server",
				serverId: "runtime-server",
			}),
		).toBe("build-server");

		expect(
			deploymentLogsInternals.deploymentServerId({
				application: {
					buildServer: { serverId: "nested-build-server" },
					server: { serverId: "nested-runtime-server" },
				},
			}),
		).toBe("nested-build-server");

		expect(deploymentLogsInternals.deploymentServerId({}, "fallback")).toBe(
			"fallback",
		);

		expect(
			deploymentLogsInternals.deploymentServerId(
				{
					buildServerId: "",
					serverId: "",
				},
				"compose-parent-server",
			),
		).toBe("compose-parent-server");
	});

	it("should detect missing deployment log responses", () => {
		expect(
			deploymentLogsInternals.isMissingDeploymentLog(
				"tail: cannot open '/x.log' for reading: No such file or directory",
			),
		).toBe(true);
		expect(deploymentLogsInternals.isMissingDeploymentLog("build failed")).toBe(
			false,
		);
	});

	it("should redact, search, and tail deployment log output", () => {
		const output = deploymentLogsInternals.formatDeploymentLogOutput(
			[
				"first line",
				"TOKEN=super-secret-value",
				"deploy error happened",
				"last line",
			].join("\n"),
			{ search: "error", context: 1, tail: 3 },
		);

		expect(output).toContain("TOKEN=supe***");
		expect(output).toContain("deploy error happened");
		expect(output).not.toContain("first line");
		expect(output).not.toContain("super-secret-value");
	});

	describe("agent-safe log paths", () => {
		const deployments = [
			{
				deploymentId: "dep-1",
				logPath: "/etc/dokploy/logs/web/web-1.log",
				serverId: "srv-a",
				startedAt: "2026-01-01T00:00:00Z",
			},
			{
				deploymentId: "dep-2",
				logPath: "/etc/dokploy/logs/web/web-2.log",
				startedAt: "2026-01-02T00:00:00Z",
			},
		];
		const resolve = (opts: Record<string, string>, agentSafe = true) =>
			deploymentLogsInternals.resolveDeploymentLogCandidates(opts, agentSafe);

		it("accepts a log path only when a deployment record names it", async () => {
			const get = vi
				.spyOn(client, "apiGet")
				.mockResolvedValueOnce(deployments)
				.mockResolvedValueOnce({ serverId: "srv-app" });
			const [candidate] = await resolve({
				applicationId: "app-1",
				logPath: "/etc/dokploy/logs/web/web-1.log",
				serverId: "srv-agent",
			});
			expect(candidate).toMatchObject({
				deploymentId: "dep-1",
				logPath: "/etc/dokploy/logs/web/web-1.log",
				serverId: "srv-a",
			});
			expect(get).toHaveBeenCalledWith("deployment.all", {
				applicationId: "app-1",
			});
		});

		it("uses the service's server, not --serverId, for records without one", async () => {
			vi.spyOn(client, "apiGet")
				.mockResolvedValueOnce(deployments)
				.mockResolvedValueOnce({ serverId: "srv-app" });
			const [candidate] = await resolve({
				applicationId: "app-1",
				deploymentId: "dep-2",
				serverId: "srv-agent",
			});
			expect(candidate.serverId).toBe("srv-app");
		});

		it("refuses a log path no deployment record names", async () => {
			vi.spyOn(client, "apiGet").mockResolvedValue(deployments);
			for (const logPath of [
				"/etc/dokploy/.env",
				"/etc/dokploy/logs/web/../../.env",
			]) {
				await expect(resolve({ logPath })).rejects.toMatchObject({
					code: "AGENT_POLICY_BLOCKED",
				});
			}
			expect(client.apiGet).toHaveBeenCalledWith("deployment.allCentralized");
		});

		it("passes raw log paths through in the full build", async () => {
			const get = vi.spyOn(client, "apiGet");
			await expect(
				resolve({ logPath: "/tmp/x.log", serverId: "srv-1" }, false),
			).resolves.toEqual([
				{ logPath: "/tmp/x.log", deploymentId: undefined, serverId: "srv-1" },
			]);
			expect(get).not.toHaveBeenCalled();
		});
	});

	describe("readDeploymentLogWebSocket idle timeout", () => {
		it("keeps stream open while frames arrive before idle timeout", async () => {
			const fakeSocket = makeSocketFactory();
			const originalConnect = deploymentLogsInternals.socketFactory.connect;
			deploymentLogsInternals.socketFactory.connect = vi.fn(() => {
				return fakeSocket as unknown as ReturnType<
					typeof deploymentLogsInternals.socketFactory.connect
				>;
			});
			vi.spyOn(client, "readAuthConfig").mockReturnValue({
				url: "http://localhost",
				token: "token",
			});
			let settled = false;
			let payload = "";

			vi.useFakeTimers();
			const promise = deploymentLogsInternals.readDeploymentLogWebSocket(
				"/tmp/log",
				undefined,
				{ timeoutMs: 1_000, idleTimeoutMs: 200 },
			);

			const resultPromise = promise.then((value) => {
				settled = true;
				payload = value;
				return value;
			});

			fakeSocket.emit("connect");
			fakeSocket.emit(
				"data",
				Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n"),
			);
			fakeSocket.emit("data", textFrame("first"));
			await vi.advanceTimersByTimeAsync(150);
			expect(settled).toBe(false);
			fakeSocket.emit("data", textFrame("second"));
			await vi.advanceTimersByTimeAsync(150);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(50);
			expect(settled).toBe(true);
			expect(payload).toBe("firstsecond");
			await resultPromise;
			deploymentLogsInternals.socketFactory.connect = originalConnect;
		});

		it("ends stream by total timeout even with recent activity", async () => {
			const fakeSocket = makeSocketFactory();
			const originalConnect = deploymentLogsInternals.socketFactory.connect;
			deploymentLogsInternals.socketFactory.connect = vi.fn(() => {
				return fakeSocket as unknown as ReturnType<
					typeof deploymentLogsInternals.socketFactory.connect
				>;
			});
			vi.spyOn(client, "readAuthConfig").mockReturnValue({
				url: "http://localhost",
				token: "token",
			});

			let settled = false;
			let payload = "";
			vi.useFakeTimers();
			const promise = deploymentLogsInternals.readDeploymentLogWebSocket(
				"/tmp/log",
				undefined,
				{ timeoutMs: 300, idleTimeoutMs: 1_000 },
			);
			const resultPromise = promise.then((value) => {
				settled = true;
				payload = value;
				return value;
			});

			fakeSocket.emit("connect");
			fakeSocket.emit(
				"data",
				Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n"),
			);
			fakeSocket.emit("data", textFrame("alive"));
			await vi.advanceTimersByTimeAsync(200);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(200);
			expect(settled).toBe(true);
			expect(payload).toBe("alive");
			await resultPromise;
			deploymentLogsInternals.socketFactory.connect = originalConnect;
		});
	});
});
