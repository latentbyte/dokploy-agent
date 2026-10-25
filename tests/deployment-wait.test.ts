import { describe, expect, it } from "vitest";
import type { DeploymentRecord } from "../src/commands/deployment-logs.js";
import {
	deploymentWaitInternals,
	waitForDeployments,
} from "../src/commands/deployment-wait.js";

const T0 = Date.parse("2026-10-25T12:00:00.000Z");
const iso = (offsetSeconds: number) =>
	new Date(T0 + offsetSeconds * 1000).toISOString();
const SHA = "0123456789abcdef0123456789abcdef01234567";

function deployment(
	id: string,
	startOffset: number,
	status: string,
	extra: Partial<DeploymentRecord> = {},
): DeploymentRecord {
	return {
		deploymentId: id,
		status,
		createdAt: iso(startOffset),
		startedAt: iso(startOffset),
		finishedAt: status === "running" ? undefined : iso(startOffset + 60),
		title: "feat: thing",
		description: "",
		...extra,
	};
}

// replays one deployment list per poll, sticking on the last
function fakeDeps(lists: Record<string, DeploymentRecord[][]>) {
	let clock = T0;
	const calls: Record<string, number> = {};
	const lines: string[] = [];
	return {
		lines,
		deps: {
			fetch: async (target: { type: string; id: string }) => {
				const sequence = lists[target.id] ?? [[]];
				const index = calls[target.id] ?? 0;
				calls[target.id] = index + 1;
				return sequence[Math.min(index, sequence.length - 1)];
			},
			sleep: async (ms: number) => {
				clock += ms;
			},
			now: () => clock,
			log: (line: string) => lines.push(line),
			bin: "dokploy-agent",
		},
	};
}

describe("deployment wait helpers", () => {
	it("parses durations", () => {
		const { parseDurationMs } = deploymentWaitInternals;
		expect(parseDurationMs("90")).toBe(90_000);
		expect(parseDurationMs("90s")).toBe(90_000);
		expect(parseDurationMs("10m")).toBe(600_000);
		expect(parseDurationMs("1h")).toBe(3_600_000);
		expect(parseDurationMs("soon")).toBeUndefined();
	});

	it("matches the newest deployment for a commit prefix", () => {
		const list = [
			deployment("old", -600, "done", { description: `Commit: ${SHA}` }),
			deployment("other", -60, "done", { description: "Commit: ffffffff" }),
		];
		expect(
			deploymentWaitInternals.matchDeployment(list, {
				commit: SHA.slice(0, 7),
			})?.deploymentId,
		).toBe("old");
	});

	it("matches running deployments regardless of the since window", () => {
		const list = [deployment("long", -3600, "running")];
		expect(
			deploymentWaitInternals.matchDeployment(list, { sinceMs: T0 - 60_000 })
				?.deploymentId,
		).toBe("long");
		expect(
			deploymentWaitInternals.matchDeployment(
				[deployment("stale", -3600, "done")],
				{ sinceMs: T0 - 60_000 },
			),
		).toBeUndefined();
	});

	it("ignores preview deployments", () => {
		const list = [
			deployment("preview", 0, "running", { isPreviewDeployment: true }),
		];
		expect(
			deploymentWaitInternals.matchDeployment(list, { sinceMs: T0 - 60_000 }),
		).toBeUndefined();
	});

	it("estimates typical duration from past successful deployments", () => {
		const list = [
			deployment("a", -1000, "done", { finishedAt: iso(-1000 + 30) }),
			deployment("b", -2000, "done", { finishedAt: iso(-2000 + 90) }),
			deployment("c", -3000, "done", { finishedAt: iso(-3000 + 60) }),
			deployment("d", -4000, "error", { finishedAt: iso(-4000 + 5) }),
		];
		expect(deploymentWaitInternals.typicalSeconds(list)).toBe(60);
	});

	it("rejects bad options", () => {
		const { resolveConfig } = deploymentWaitInternals;
		expect(() => resolveConfig({}, T0)).toThrow(/applicationId/);
		expect(() =>
			resolveConfig({ applicationId: ["a"], commit: "HEAD" }, T0),
		).toThrow(/hex SHA/);
		expect(() =>
			resolveConfig({ applicationId: ["a"], since: "yesterday-ish" }, T0),
		).toThrow(/--since/);
	});
});

describe("waitForDeployments", () => {
	it("waits for a deployment to appear and finish for every service", async () => {
		const pushed = { description: `Commit: ${SHA}` };
		const { deps, lines } = fakeDeps({
			app: [
				[deployment("prev", -900, "done")],
				[
					deployment("prev", -900, "done"),
					deployment("new", 5, "running", pushed),
				],
				[
					deployment("prev", -900, "done"),
					deployment("new", 5, "done", pushed),
				],
			],
			web: [
				[deployment("w1", 2, "running", pushed)],
				[deployment("w1", 2, "done", pushed)],
			],
		});

		const result = await waitForDeployments(
			{
				targets: [
					{ type: "application", id: "app" },
					{ type: "compose", id: "web" },
				],
				commit: SHA,
				timeoutMs: 600_000,
			},
			deps,
		);

		expect(result.ok).toBe(true);
		expect(result.timedOut).toBe(false);
		expect(result.services.map((s) => [s.id, s.state, s.deploymentId])).toEqual(
			[
				["app", "done", "new"],
				["web", "done", "w1"],
			],
		);
		// only state transitions are logged
		expect(lines).toHaveLength(5);
		expect(lines[0]).toContain("application app: not_started");
	});

	it("reports failures with a log command", async () => {
		const { deps } = fakeDeps({
			app: [
				[
					deployment("bad", 0, "error", {
						errorMessage: "build failed token=supersecretvalue123",
					}),
				],
			],
		});

		const result = await waitForDeployments(
			{
				targets: [{ type: "application", id: "app" }],
				sinceMs: T0 - 60_000,
				timeoutMs: 600_000,
			},
			deps,
		);

		expect(result.ok).toBe(false);
		const [service] = result.services;
		expect(service.state).toBe("error");
		expect(service.errorMessage).not.toContain("supersecretvalue123");
		expect(service.logsCommand).toBe(
			"dokploy-agent deployment read-logs --applicationId app --deploymentId bad --tail 200 --json",
		);
	});

	it("times out when no deployment shows up", async () => {
		const { deps } = fakeDeps({ app: [[]] });

		const result = await waitForDeployments(
			{
				targets: [{ type: "application", id: "app" }],
				commit: SHA,
				timeoutMs: 30_000,
			},
			deps,
		);

		expect(result).toMatchObject({
			ok: false,
			timedOut: true,
			elapsedSeconds: 30,
		});
		expect(result.services[0].state).toBe("not_started");
	});
});
