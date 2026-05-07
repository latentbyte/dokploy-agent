import { describe, expect, it } from "vitest";
import { deploymentLogsInternals } from "../src/commands/deployment-logs.js";

function textFrame(text: string): Buffer {
	const payload = Buffer.from(text, "utf8");
	return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
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
});
