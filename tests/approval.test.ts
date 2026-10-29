import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ApprovalRequest,
	approvalTarget,
	buildApprovalDialog,
	requireUserApproval,
} from "../src/agent/approval.js";
import * as backends from "../src/agent/approval-backends.js";
import { agentPolicyBlocked } from "../src/agent/errors.js";

const actual = await vi.importActual<typeof backends>(
	"../src/agent/approval-backends.js",
);

afterEach(() => {
	vi.mocked(backends.detectApprovalBackend).mockReset();
	vi.mocked(backends.detectApprovalBackend).mockReturnValue(undefined);
});

const hostile = 'value "; do shell script "rm -rf ~" --\nnext line $(id)`';
const dialog: backends.ApprovalDialog = {
	title: "dokploy-agent approval",
	heading: "Approve env set on application?",
	intro: "An agent asks to run a change outside its policy.",
	lines: [
		{ kind: "remove", text: "- API_KEY=ab***" },
		{ kind: "add", text: `+ API_KEY=${JSON.stringify(hostile)}` },
	],
	timeoutSeconds: 30,
};

const request: ApprovalRequest = {
	endpoint: "application.saveEnvironment",
	title: "env set",
	target: { kind: "application", id: "app-1", name: "web" },
	lines: [{ kind: "add", text: 'API_KEY="s3cret-value"' }],
	audit: { operation: "set", names: ["API_KEY"] },
};

// stands in for an OS dialog: a node child that prints the given answer
function fakeBackend(answer: string): backends.ApprovalBackend {
	return {
		name: "macos",
		invocation: () => ({
			command: process.execPath,
			args: ["-e", `process.stdout.write(${JSON.stringify(answer)})`],
			env: {},
			parse: (status, stdout) =>
				status === 0 && stdout === "approved"
					? "approved"
					: stdout === "timeout"
						? "timeout"
						: "denied",
		}),
	};
}

// dialog that answers after delayMs; its reminder appends to markerPath
function slowBackend(
	answer: string,
	delayMs: number,
	markerPath: string,
): backends.ApprovalBackend {
	return {
		...fakeBackend(answer),
		invocation: (dialog) => ({
			...fakeBackend(answer).invocation(dialog),
			args: [
				"-e",
				`setTimeout(() => process.stdout.write(${JSON.stringify(answer)}), ${delayMs})`,
			],
		}),
		reminder: (dialog, remainingSeconds) => ({
			command: process.execPath,
			args: [
				"-e",
				`require("node:fs").appendFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(`${dialog.heading} ${remainingSeconds}s\n`)})`,
			],
			env: {},
		}),
	};
}

async function waitForFile(file: string, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fs.existsSync(file)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return fs.existsSync(file);
}

function auditLog(): Array<Record<string, unknown>> {
	const logPath = path.join(
		process.env.XDG_STATE_HOME as string,
		"dokploy-agent",
		"approvals.jsonl",
	);
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

describe("approval backend detection", () => {
	const exists = (paths: string[]) => (file: string) => paths.includes(file);

	it("never offers a dialog over SSH", () => {
		expect(
			actual.detectApprovalBackend({
				platform: "darwin",
				env: { SSH_CONNECTION: "203.0.113.1 50000 203.0.113.2 22" },
				exists: () => true,
			}),
		).toBeUndefined();
	});

	it("uses osascript on macOS only from its system path", () => {
		expect(
			actual.detectApprovalBackend({
				platform: "darwin",
				env: {},
				exists: exists(["/usr/bin/osascript"]),
			})?.name,
		).toBe("macos");
		expect(
			actual.detectApprovalBackend({
				platform: "darwin",
				env: {},
				exists: () => false,
			}),
		).toBeUndefined();
	});

	it("uses PowerShell on Windows", () => {
		expect(
			actual.detectApprovalBackend({
				platform: "win32",
				env: {},
				exists: () => true,
			})?.name,
		).toBe("windows");
	});

	it("needs a display on Linux and ignores PATH", () => {
		const probed: string[] = [];
		const probe = (file: string) => {
			probed.push(file);
			return file === "/usr/bin/kdialog";
		};
		expect(
			actual.detectApprovalBackend({
				platform: "linux",
				env: { PATH: "/tmp/fake-bin" },
				exists: probe,
			}),
		).toBeUndefined();
		expect(
			actual.detectApprovalBackend({
				platform: "linux",
				env: { DISPLAY: ":0", PATH: "/tmp/fake-bin" },
				exists: probe,
			})?.name,
		).toBe("kdialog");
		expect(probed.every((file) => /^\/(usr\/)?bin\//.test(file))).toBe(true);
		expect(
			actual.detectApprovalBackend({
				platform: "linux",
				env: { WAYLAND_DISPLAY: "wayland-0" },
				exists: exists(["/usr/bin/zenity", "/usr/bin/kdialog"]),
			})?.name,
		).toBe("zenity");
	});
});

describe("approval backend invocations", () => {
	const hostileEnv = {
		HOME: "/home/user",
		PATH: "/tmp/fake-bin",
		LD_PRELOAD: "/tmp/fake.so",
		DYLD_INSERT_LIBRARIES: "/tmp/fake.dylib",
		DISPLAY: ":0",
	};

	it("passes macOS text as one JSON argv item, not script source", () => {
		const invocation = actual.macosBackend(hostileEnv).invocation(dialog);
		expect(invocation.command).toBe("/usr/bin/osascript");
		expect(invocation.args.slice(0, 2)).toEqual(["-l", "JavaScript"]);
		const scriptArgs = invocation.args.slice(0, -1);
		expect(scriptArgs.join("\n")).not.toContain("rm -rf");
		expect(JSON.parse(invocation.args.at(-1) as string)).toEqual(dialog);
		expect(invocation.env).toEqual({
			PATH: "/usr/bin:/bin",
			HOME: "/home/user",
		});
	});

	it("passes Windows text through env vars", () => {
		const invocation = actual.windowsBackend(hostileEnv).invocation(dialog);
		expect(invocation.args.join("\n")).not.toContain("rm -rf");
		expect(invocation.env.DOKPLOY_APPROVAL_MESSAGE).toContain(
			actual.plainDialogText(dialog),
		);
		expect(invocation.env.PATH).toBeUndefined();
		expect(invocation.parse(0, "unavailable\r\n")).toBe("unavailable");
		expect(invocation.parse(0, "approved\r\n")).toBe("approved");
	});

	it("disables zenity markup and strips loader overrides on Linux", () => {
		const invocation = actual
			.zenityBackend("/usr/bin/zenity", hostileEnv)
			.invocation(dialog);
		expect(invocation.args).toContain("--no-markup");
		expect(invocation.args).toContain("--default-cancel");
		expect(invocation.env).toEqual({
			PATH: "/usr/bin:/bin",
			HOME: "/home/user",
			DISPLAY: ":0",
		});
		expect(invocation.parse(0, "")).toBe("approved");
		expect(invocation.parse(1, "")).toBe("denied");
		expect(invocation.parse(5, "")).toBe("timeout");
	});

	it("treats anything but an explicit approval as denial", () => {
		const parse = actual.macosBackend({}).invocation(dialog).parse;
		expect(parse(0, "approved\n")).toBe("approved");
		expect(parse(0, "timeout\n")).toBe("timeout");
		expect(parse(1, "approved")).toBe("denied");
		expect(parse(0, "yes")).toBe("denied");
		expect(parse(null, "")).toBe("denied");
	});

	it("passes reminder text as data and keeps env minimal", () => {
		const macos = actual
			.macosBackend(hostileEnv)
			.reminder?.(dialog, 15) as backends.ReminderInvocation;
		expect(macos.command).toBe("/usr/bin/osascript");
		expect(macos.args.slice(0, -1).join("\n")).not.toContain("Approve env");
		expect(JSON.parse(macos.args.at(-1) as string)).toEqual({
			title: "dokploy-agent approval waiting",
			body: "Approve env set on application? Denied automatically in 15s.",
		});
		expect(macos.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/user" });
		const zenity = actual
			.zenityBackend("/usr/bin/zenity", hostileEnv)
			.reminder?.(dialog, 15) as backends.ReminderInvocation;
		expect(zenity.args.slice(0, 2)).toEqual(["--notification", "--no-markup"]);
		expect(zenity.env.LD_PRELOAD).toBeUndefined();
		const kdialog = actual
			.kdialogBackend("/usr/bin/kdialog", hostileEnv)
			.reminder?.(dialog, 15) as backends.ReminderInvocation;
		expect(kdialog.args).toContain("--passivepopup");
		expect(actual.windowsBackend(hostileEnv).reminder).toBeUndefined();
	});

	it("ignores a missing reminder binary", () => {
		expect(() =>
			actual.runReminderInvocation({
				command: "/nonexistent/notify",
				args: [],
				env: {},
			}),
		).not.toThrow();
	});

	it("reports a missing binary as unavailable", async () => {
		await expect(
			actual.runApprovalInvocation(
				{
					command: "/nonexistent/dialog",
					args: [],
					env: {},
					parse: () => "approved",
				},
				5,
			),
		).resolves.toBe("unavailable");
	});
});

describe("requireUserApproval", () => {
	const blocked = agentPolicyBlocked("agent-safe deploy policy rejects app-1");
	const config = { enabled: true, timeoutSeconds: 30 };

	it("keeps the original denial when approval is disabled", async () => {
		vi.mocked(backends.detectApprovalBackend).mockReturnValue(
			fakeBackend("approved"),
		);
		await expect(
			requireUserApproval({ ...config, enabled: false }, request, blocked),
		).rejects.toBe(blocked);
		expect(backends.detectApprovalBackend).not.toHaveBeenCalled();
	});

	it("stays blocked when no dialog backend exists", async () => {
		await expect(
			requireUserApproval(config, request, blocked),
		).rejects.toMatchObject({
			code: "AGENT_POLICY_BLOCKED",
			exitCode: 2,
			message: expect.stringContaining("no approval dialog available"),
		});
	});

	it("resolves on approval and logs names without values", async () => {
		vi.mocked(backends.detectApprovalBackend).mockReturnValue(
			fakeBackend("approved"),
		);
		await requireUserApproval(
			config,
			{ ...request, reason: "rotate the leaked key" },
			blocked,
		);
		const entry = auditLog().at(-1);
		expect(entry).toMatchObject({
			endpoint: "application.saveEnvironment",
			operation: "set",
			names: ["API_KEY"],
			reason: "rotate the leaked key",
			cwd: process.cwd(),
			result: "approved",
		});
		expect(JSON.stringify(auditLog())).not.toContain("s3cret-value");
	});

	it("maps denial and timeout to distinct exit-2 errors", async () => {
		vi.mocked(backends.detectApprovalBackend).mockReturnValue(
			fakeBackend("no"),
		);
		await expect(
			requireUserApproval(config, request, blocked),
		).rejects.toMatchObject({ code: "AGENT_APPROVAL_DENIED", exitCode: 2 });
		vi.mocked(backends.detectApprovalBackend).mockReturnValue(
			fakeBackend("timeout"),
		);
		await expect(
			requireUserApproval(config, request, blocked),
		).rejects.toMatchObject({ code: "AGENT_APPROVAL_TIMEOUT", exitCode: 2 });
	});
});

describe("approval reminder", () => {
	const blocked = agentPolicyBlocked("agent-safe deploy policy rejects app-1");
	const marker = () =>
		path.join(
			fs.mkdtempSync(path.join(process.env.XDG_STATE_HOME as string, "r-")),
			"reminded",
		);

	it("notifies halfway through an unanswered dialog", async () => {
		const file = marker();
		vi.mocked(backends.detectApprovalBackend).mockReturnValue(
			slowBackend("approved", 1500, file),
		);
		await requireUserApproval(
			{ enabled: true, timeoutSeconds: 2 },
			request,
			blocked,
		);
		expect(await waitForFile(file, 2000)).toBe(true);
		expect(fs.readFileSync(file, "utf8")).toBe(
			"Approve env set on application web? 1s\n",
		);
	});

	it("stays silent when the user answers first", async () => {
		const file = marker();
		vi.mocked(backends.detectApprovalBackend).mockReturnValue(
			slowBackend("approved", 0, file),
		);
		await requireUserApproval(
			{ enabled: true, timeoutSeconds: 4 },
			request,
			blocked,
		);
		await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(fs.existsSync(file)).toBe(false);
	});
});

describe("buildApprovalDialog", () => {
	const text = (built: backends.ApprovalDialog) =>
		actual.plainDialogText(built);

	it("shows target, diff, and the original reason with bounded lines", () => {
		const built = buildApprovalDialog(
			{
				...request,
				target: {
					...request.target,
					project: "storefront",
					environment: "production",
				},
				lines: [
					{ kind: "remove", text: "x".repeat(500) },
					...Array.from({ length: 25 }, () => ({
						kind: "add" as const,
						text: "y",
					})),
				],
			},
			"agent-safe deploy policy rejects app-1",
			45,
		);
		const message = text(built);
		expect(message.split("\n")[0]).toBe(
			"An agent asks for a change outside its policy. Nothing runs unless you approve. Denied automatically after 45s.",
		);
		expect(built.heading).toBe("Approve env set on application web?");
		expect(built.timeoutSeconds).toBe(45);
		expect(message).toContain("application: web (app-1)");
		expect(message).toContain("project: storefront/production");
		expect(message).toContain(`CHANGE\n- ${"x".repeat(195)}...\n+ y\n`);
		expect(message).toContain("(6 more lines not shown)");
		expect(message).toContain(
			"BLOCKED BECAUSE\nagent-safe deploy policy rejects app-1",
		);
		expect(message).toContain("AGENT'S REASON (unverified)\n(none given)");
		expect(message).toContain(`REQUESTED FROM (unverified)\n${process.cwd()}`);
		const kinds = built.lines.map((line) => line.kind);
		expect(kinds.filter((kind) => kind === "remove")).toHaveLength(1);
		expect(kinds.filter((kind) => kind === "add")).toHaveLength(19);
		expect(kinds.filter((kind) => kind === "heading")).toHaveLength(5);
	});

	it("shows the agent's reason clipped to bounded lines", () => {
		const message = text(
			buildApprovalDialog(
				{
					...request,
					reason: `rotate the key\r\n${Array.from({ length: 12 }, (_, i) => `step ${i}`).join("\n")}`,
				},
				"blocked",
				30,
				"/work/repo",
			),
		);
		expect(message).toContain(
			"AGENT'S REASON (unverified)\nrotate the key\nstep 0\n",
		);
		expect(message).toContain("step 6\n...\n");
		expect(message).not.toContain("step 7");
		expect(message).not.toContain("\r");
		expect(message).toContain("REQUESTED FROM (unverified)\n/work/repo");
	});

	it("names the service in the heading, falling back to appName and id", () => {
		const target = approvalTarget("compose", "c-1", {
			name: "kutt",
			appName: "kutt-a1b2c3",
			environment: { name: "production", project: { name: "storefront" } },
			serverId: "srv-1",
		});
		expect(target).toEqual({
			kind: "compose",
			id: "c-1",
			name: "kutt",
			appName: "kutt-a1b2c3",
			project: "storefront",
			environment: "production",
			server: "srv-1",
		});
		const heading = (t: ApprovalRequest["target"]) =>
			buildApprovalDialog({ ...request, target: t }, "blocked", 30).heading;
		expect(heading(target)).toBe("Approve env set on compose kutt?");
		expect(
			text(buildApprovalDialog({ ...request, target }, "blocked", 30)),
		).toContain("compose: kutt / kutt-a1b2c3 (c-1)");
		expect(
			heading(approvalTarget("compose", "c-1", { appName: "kutt-x" })),
		).toBe("Approve env set on compose kutt-x?");
		expect(heading(approvalTarget("compose", "c-1", {}))).toBe(
			"Approve env set on compose c-1?",
		);
		expect(heading({ kind: "compose", id: "c-1", name: "n".repeat(80) })).toBe(
			`Approve env set on compose ${"n".repeat(57)}...?`,
		);
	});
});
