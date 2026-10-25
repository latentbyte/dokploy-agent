import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ApprovalRequest,
	formatApprovalMessage,
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

const dialog = {
	title: "dokploy-agent approval",
	message: 'value "; do shell script "rm -rf ~" --\nnext line $(id)',
	timeoutSeconds: 30,
};

const request: ApprovalRequest = {
	endpoint: "application.saveEnvironment",
	title: "env set on application",
	target: { kind: "application", id: "app-1", name: "web" },
	lines: ['new value: "s3cret-value"'],
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

	it("passes macOS text through argv, not script source", () => {
		const invocation = actual.macosBackend(hostileEnv).invocation(dialog);
		expect(invocation.command).toBe("/usr/bin/osascript");
		const scriptArgs = invocation.args.slice(0, -3);
		expect(scriptArgs.join("\n")).not.toContain("rm -rf");
		expect(invocation.args.slice(-3)).toEqual([
			dialog.message,
			dialog.title,
			"30",
		]);
		expect(invocation.env).toEqual({
			PATH: "/usr/bin:/bin",
			HOME: "/home/user",
		});
	});

	it("passes Windows text through env vars", () => {
		const invocation = actual.windowsBackend(hostileEnv).invocation(dialog);
		expect(invocation.args.join("\n")).not.toContain("rm -rf");
		expect(invocation.env.DOKPLOY_APPROVAL_MESSAGE).toContain(dialog.message);
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

describe("formatApprovalMessage", () => {
	it("shows target, change, and the original reason with bounded lines", () => {
		const message = formatApprovalMessage(
			{
				...request,
				target: {
					...request.target,
					project: "storefront",
					environment: "production",
				},
				lines: ["x".repeat(500), ...Array.from({ length: 25 }, () => "y")],
			},
			"agent-safe deploy policy rejects app-1",
		);
		expect(message.split("\n")[0]).toBe(
			"An agent asks to run a change outside its policy.",
		);
		expect(message).toContain("application: web (app-1)");
		expect(message).toContain("project: storefront/production");
		expect(message).toContain(`${"x".repeat(197)}...`);
		expect(message).toContain("(6 more lines not shown)");
		expect(message).toContain(
			"blocked because: agent-safe deploy policy rejects app-1",
		);
		expect(message).toContain("agent's reason (unverified):\n(none given)");
		expect(message).toContain(`requested from (unverified): ${process.cwd()}`);
	});

	it("shows the agent's reason clipped to bounded lines", () => {
		const message = formatApprovalMessage(
			{
				...request,
				reason: `rotate the key\r\n${Array.from({ length: 12 }, (_, i) => `step ${i}`).join("\n")}`,
			},
			"blocked",
			"/work/repo",
		);
		expect(message).toContain(
			"agent's reason (unverified):\nrotate the key\nstep 0\n",
		);
		expect(message).toContain("step 6\n...\n");
		expect(message).not.toContain("step 7");
		expect(message).not.toContain("\r");
		expect(message).toContain("requested from (unverified): /work/repo");
	});
});
