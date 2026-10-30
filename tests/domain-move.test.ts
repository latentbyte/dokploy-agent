import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as backends from "../src/agent/approval-backends.js";
import * as client from "../src/client.js";
import { registerDomainMoveCommand } from "../src/commands/domain-move.js";

const environment = {
	environmentId: "env-other",
	environment: { name: "production", project: { name: "storefront" } },
};
const domain = {
	domainId: "domain-1",
	composeId: "compose-1",
	applicationId: null,
	domainType: "compose",
	serviceName: "web",
	host: "api.example.net",
	path: "/",
	port: 3000,
	https: true,
	certificateType: "letsencrypt",
	customCertResolver: null,
	customEntrypoint: null,
	internalPath: "/",
	stripPath: false,
	middlewares: [],
	forwardAuthEnabled: false,
	enabled: true,
};
const compose = {
	...environment,
	name: "backend",
	appName: "backend-a1b2c3",
	serverId: "srv-1",
};
const application = {
	...environment,
	name: "backend-app",
	appName: "backend-app-d4e5f6",
	serverId: "srv-1",
	applicationStatus: "done",
};
const moveArgs = [
	"node",
	"cli",
	"domain",
	"move",
	"--domainId",
	"domain-1",
	"--applicationId",
	"app-1",
	"--reason",
	"move backend to an application",
	"--json",
];

function answerDialog(result: backends.ApprovalResult) {
	const dialogs: string[] = [];
	vi.mocked(backends.detectApprovalBackend).mockReturnValue({
		name: "macos",
		invocation: (dialog) => {
			dialogs.push(backends.plainDialogText(dialog));
			return {
				command: process.execPath,
				args: ["-e", `process.stdout.write(${JSON.stringify(result)})`],
				env: {},
				parse: (_status, stdout) => stdout as backends.ApprovalResult,
			};
		},
	});
	return dialogs;
}

// each endpoint reads its queued records in order, then keeps the last one
function setup(
	records: Partial<Record<string, Record<string, unknown>[]>> = {},
	approval?: client.AgentApprovalConfig,
	agentSafe = true,
) {
	const reads: Record<string, unknown[]> = {
		"domain.one": [domain],
		"compose.one": [compose],
		"application.one": [application],
		"domain.byApplicationId": [[]],
		...records,
	};
	const program = new Command();
	program.exitOverride();
	program.command("domain");
	vi.spyOn(client, "apiGet").mockImplementation(async (endpoint) => {
		const queue = reads[endpoint] ?? [];
		return queue.length > 1 ? queue.shift() : queue[0];
	});
	vi.spyOn(client, "readAgentDeployPolicyConfig").mockReturnValue({
		projects: [
			{
				projectName: "allowed-project",
				environmentName: "production",
				environmentId: "allowed-env",
			},
		],
		servers: [],
		allowAnyServer: true,
		domainSuffixes: [".example.com"],
		expandedProjects: [],
		expandedApplicationIds: [],
		expandedApplicationNames: [],
		approval,
	});
	const postSpy = vi
		.spyOn(client, "apiPost")
		.mockImplementation(async (endpoint) =>
			endpoint === "domain.create" ? { domainId: "domain-2" } : true,
		);
	vi.spyOn(console, "log").mockImplementation(() => {});
	registerDomainMoveCommand(program, { agentSafe });
	return { program, postSpy };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(backends.detectApprovalBackend).mockReset();
	vi.mocked(backends.detectApprovalBackend).mockReturnValue(undefined);
});

describe("domain move", () => {
	it("creates on the target, then deletes the old record", async () => {
		const dialogs = answerDialog("approved");
		const { program, postSpy } = setup();
		await program.parseAsync(moveArgs);
		expect(postSpy.mock.calls).toEqual([
			[
				"domain.create",
				{
					applicationId: "app-1",
					domainType: "application",
					host: "api.example.net",
					path: "/",
					port: 3000,
					https: true,
					certificateType: "letsencrypt",
					internalPath: "/",
					stripPath: false,
					middlewares: [],
					forwardAuthEnabled: false,
				},
			],
			["domain.delete", { domainId: "domain-1" }],
		]);
		expect(dialogs).toHaveLength(1);
		const dialog = dialogs[0];
		expect(dialog).toContain("Approve domain move on application backend-app?");
		expect(dialog).toContain(
			"- https://api.example.net/ on compose backend / backend-a1b2c3 (compose-1)",
		);
		expect(dialog).toContain(
			"+ https://api.example.net/ on application backend-app / backend-app-d4e5f6 (app-1)",
		);
		expect(dialog).toContain("until it is stopped or redeployed");
		expect(dialog).toContain("stopping the compose is the real cutover");
		expect(dialog).toContain("domain move always needs the user");
		expect(dialog).not.toContain("target status");
		const output = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(JSON.parse(output)).toEqual({
			domainId: "domain-2",
			previousDomainId: "domain-1",
			applicationId: "app-1",
			host: "api.example.net",
			moved: true,
		});
	});

	it("asks inside the deploy project and for hosts outside the suffix policy", async () => {
		const inside = {
			environmentId: "allowed-env",
			environment: { name: "production", project: { name: "allowed-project" } },
		};
		const dialogs = answerDialog("approved");
		const { program, postSpy } = setup({
			"compose.one": [{ ...compose, ...inside }],
			"application.one": [{ ...application, ...inside }],
		});
		await program.parseAsync(moveArgs);
		expect(dialogs).toHaveLength(1);
		expect(postSpy).toHaveBeenCalledTimes(2);
	});

	it("carries --port and warns about an undeployed target", async () => {
		const dialogs = answerDialog("approved");
		const { program, postSpy } = setup({
			"application.one": [{ ...application, applicationStatus: "idle" }],
		});
		await program.parseAsync([...moveArgs, "--port", "8080"]);
		expect(postSpy.mock.calls[0]?.[1]).toMatchObject({ port: 8080 });
		expect(dialogs[0]).toContain("port 3000 changes to 8080");
		expect(dialogs[0]).toContain("target status is idle");
	});

	it("drops the old route at once when the parent is an application", async () => {
		const dialogs = answerDialog("approved");
		const { program } = setup({
			"domain.one": [{ ...domain, composeId: null, applicationId: "app-old" }],
			"application.one": [
				{ ...application, name: "old" },
				application,
				application,
			],
		});
		await program.parseAsync(moveArgs);
		expect(dialogs[0]).toContain("old application route is removed");
	});

	it("writes the move to the audit log", async () => {
		answerDialog("approved");
		const { program } = setup();
		await program.parseAsync(moveArgs);
		const log = fs
			.readFileSync(
				path.join(
					process.env.XDG_STATE_HOME ?? "",
					"dokploy-agent",
					"approvals.jsonl",
				),
				"utf8",
			)
			.trim()
			.split("\n");
		expect(JSON.parse(log.at(-1) ?? "")).toMatchObject({
			endpoint: "domain.move",
			operation: "move",
			domainId: "domain-1",
			host: "api.example.net",
			fromKind: "compose",
			fromId: "compose-1",
			result: "approved",
		});
	});

	it.each([
		["denied", "AGENT_APPROVAL_DENIED"],
		["timeout", "AGENT_APPROVAL_TIMEOUT"],
	] as const)("writes nothing on %s", async (result, code) => {
		answerDialog(result);
		const { program, postSpy } = setup();
		await expect(program.parseAsync(moveArgs)).rejects.toMatchObject({ code });
		expect(postSpy).not.toHaveBeenCalled();
	});

	it("stays blocked on hosts without a dialog and when disabled", async () => {
		const { program, postSpy } = setup();
		await expect(program.parseAsync(moveArgs)).rejects.toMatchObject({
			code: "AGENT_POLICY_BLOCKED",
			message: expect.stringContaining("no approval dialog available"),
		});
		const dialogs = answerDialog("approved");
		const disabled = setup({}, { enabled: false });
		await expect(disabled.program.parseAsync(moveArgs)).rejects.toMatchObject({
			code: "AGENT_POLICY_BLOCKED",
		});
		expect(dialogs).toHaveLength(0);
		expect(postSpy).not.toHaveBeenCalled();
		expect(disabled.postSpy).not.toHaveBeenCalled();
	});

	it.each([
		["domain settings", { "domain.one": [domain, { ...domain, port: 4000 }] }],
		["parent", { "domain.one": [domain, { ...domain, composeId: "other" }] }],
		[
			"target server",
			{ "application.one": [application, { ...application, serverId: "x" }] },
		],
		[
			"target status",
			{
				"application.one": [
					application,
					{ ...application, applicationStatus: "error" },
				],
			},
		],
	])(
		"aborts when the %s changed while the dialog was open",
		async (_, reads) => {
			answerDialog("approved");
			const { program, postSpy } = setup(reads);
			await expect(program.parseAsync(moveArgs)).rejects.toMatchObject({
				code: "AGENT_APPROVAL_STALE",
			});
			expect(postSpy).not.toHaveBeenCalled();
		},
	);

	it.each([
		[
			"another environment",
			{ "application.one": [{ ...application, environmentId: "third" }] },
			"in one environment",
		],
		[
			"another server",
			{ "application.one": [{ ...application, serverId: "srv-2" }] },
			"on one server",
		],
		[
			"a local target for a remote compose",
			{ "application.one": [{ ...application, serverId: null }] },
			"on one server",
		],
	])("denies a move to %s before any prompt", async (_, reads, message) => {
		const dialogs = answerDialog("approved");
		const { program, postSpy } = setup(reads);
		await expect(program.parseAsync(moveArgs)).rejects.toMatchObject({
			code: "AGENT_POLICY_BLOCKED",
			message: expect.stringContaining(message),
		});
		expect(dialogs).toHaveLength(0);
		expect(postSpy).not.toHaveBeenCalled();
	});

	it.each([
		[
			"preview domains",
			{ "domain.one": [{ ...domain, composeId: null }] },
			"preview domains stay",
		],
		[
			"disabled domains",
			{ "domain.one": [{ ...domain, enabled: false }] },
			"is disabled",
		],
		[
			"its current application",
			{
				"domain.one": [{ ...domain, composeId: null, applicationId: "app-1" }],
			},
			"already routes",
		],
		[
			"a target that has the route",
			{ "domain.byApplicationId": [[{ host: "API.example.net", path: "/" }]] },
			"already has api.example.net",
		],
	])("refuses %s", async (_, reads, message) => {
		const dialogs = answerDialog("approved");
		const { program, postSpy } = setup(
			reads as unknown as Record<string, Record<string, unknown>[]>,
		);
		await expect(program.parseAsync(moveArgs)).rejects.toThrow(message);
		expect(dialogs).toHaveLength(0);
		expect(postSpy).not.toHaveBeenCalled();
	});

	it("rejects an invalid port", async () => {
		const { program } = setup();
		await expect(
			program.parseAsync([...moveArgs, "--port", "70000"]),
		).rejects.toThrow("Invalid port: 70000");
	});

	it("leaves the old record alone when the create fails", async () => {
		answerDialog("approved");
		const { program, postSpy } = setup();
		postSpy.mockRejectedValueOnce(new Error("create failed"));
		await expect(program.parseAsync(moveArgs)).rejects.toThrow("create failed");
		expect(postSpy).toHaveBeenCalledOnce();
	});

	it("names both records when the delete fails", async () => {
		answerDialog("approved");
		const { program, postSpy } = setup();
		postSpy.mockImplementation(async (endpoint) => {
			if (endpoint === "domain.delete") throw new Error("delete failed");
			return { domainId: "domain-2" };
		});
		await expect(program.parseAsync(moveArgs)).rejects.toMatchObject({
			code: "DOMAIN_MOVE_INCOMPLETE",
			message: expect.stringMatching(/domain-2.*domain-1.*delete failed/s),
		});
	});

	it("skips policy and prompt in the full build", async () => {
		const dialogs = answerDialog("approved");
		const { program, postSpy } = setup(
			{ "application.one": [{ ...application, environmentId: "third" }] },
			undefined,
			false,
		);
		await program.parseAsync(moveArgs);
		expect(dialogs).toHaveLength(0);
		expect(postSpy).toHaveBeenCalledTimes(2);
	});
});
