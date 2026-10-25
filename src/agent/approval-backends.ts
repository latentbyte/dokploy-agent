import { spawn } from "node:child_process";
import * as fs from "node:fs";

// OS dialogs the agent cannot answer through stdin or a pty. Binaries come
// from fixed system paths and run with a minimal env, so PATH, LD_PRELOAD,
// or similar overrides cannot swap in a fake approver

export type ApprovalResult = "approved" | "denied" | "timeout" | "unavailable";

export interface ApprovalDialog {
	title: string;
	message: string;
	timeoutSeconds: number;
}

export interface ApprovalInvocation {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	// backends with a native timeout exit on their own; the runner kills the
	// rest after timeoutSeconds
	parse(status: number | null, stdout: string): ApprovalResult;
}

export interface ApprovalBackend {
	name: "macos" | "windows" | "zenity" | "kdialog";
	invocation(dialog: ApprovalDialog): ApprovalInvocation;
}

export interface DetectOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	exists?: (filePath: string) => boolean;
}

const OSASCRIPT = "/usr/bin/osascript";
const POWERSHELL =
	"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const LINUX_BIN_DIRS = ["/usr/bin", "/bin"];
const LINUX_PASSTHROUGH_ENV = [
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
	"XDG_RUNTIME_DIR",
	"DBUS_SESSION_BUS_ADDRESS",
];

function pick(env: NodeJS.ProcessEnv, keys: string[]): NodeJS.ProcessEnv {
	const picked: NodeJS.ProcessEnv = {};
	for (const key of keys) {
		if (env[key] !== undefined) picked[key] = env[key];
	}
	return picked;
}

function baseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { PATH: "/usr/bin:/bin", ...pick(env, ["HOME", "USER", "LANG"]) };
}

// argv carries the text, so names and values never become AppleScript source
const MACOS_SCRIPT = [
	"on run argv",
	'set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Deny", "Approve"} default button "Deny" cancel button "Deny" with icon caution giving up after ((item 3 of argv) as integer)',
	'if gave up of r then return "timeout"',
	'if button returned of r is "Approve" then return "approved"',
	'return "denied"',
	"end run",
];

export function macosBackend(env: NodeJS.ProcessEnv): ApprovalBackend {
	return {
		name: "macos",
		invocation: (dialog) => ({
			command: OSASCRIPT,
			args: [
				...MACOS_SCRIPT.flatMap((line) => ["-e", line]),
				dialog.message,
				dialog.title,
				String(dialog.timeoutSeconds),
			],
			env: baseEnv(env),
			parse: (status, stdout) => {
				const out = stdout.trim();
				if (status === 0 && out === "approved") return "approved";
				if (status === 0 && out === "timeout") return "timeout";
				return "denied";
			},
		}),
	};
}

// env vars carry the text into PowerShell, so it is never parsed as script.
// service sessions (CI runners, session 0) report unavailable instead of
// blocking on an invisible MessageBox
const WINDOWS_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"if (-not [Environment]::UserInteractive -or [System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { 'unavailable'; exit 0 }",
	"Add-Type -AssemblyName System.Windows.Forms",
	"$r = [System.Windows.Forms.MessageBox]::Show($env:DOKPLOY_APPROVAL_MESSAGE, $env:DOKPLOY_APPROVAL_TITLE, 'YesNo', 'Warning', 'Button2', 'DefaultDesktopOnly')",
	"if ($r -eq 'Yes') { 'approved' } else { 'denied' }",
].join("\n");

export function windowsBackend(env: NodeJS.ProcessEnv): ApprovalBackend {
	return {
		name: "windows",
		invocation: (dialog) => ({
			command: POWERSHELL,
			args: [
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				WINDOWS_SCRIPT,
			],
			env: {
				...pick(env, [
					"SystemRoot",
					"windir",
					"TEMP",
					"TMP",
					"USERPROFILE",
					"APPDATA",
					"LOCALAPPDATA",
				]),
				DOKPLOY_APPROVAL_TITLE: dialog.title,
				DOKPLOY_APPROVAL_MESSAGE: `${dialog.message}\n\nYes approves, No denies.`,
			},
			parse: (status, stdout) => {
				const out = stdout.trim();
				if (status === 0 && out === "approved") return "approved";
				if (status === 0 && out === "unavailable") return "unavailable";
				return "denied";
			},
		}),
	};
}

export function zenityBackend(
	command: string,
	env: NodeJS.ProcessEnv,
): ApprovalBackend {
	return {
		name: "zenity",
		invocation: (dialog) => ({
			command,
			args: [
				"--question",
				"--no-markup",
				"--default-cancel",
				"--title",
				dialog.title,
				"--text",
				dialog.message,
				"--ok-label",
				"Approve",
				"--cancel-label",
				"Deny",
				"--timeout",
				String(dialog.timeoutSeconds),
			],
			env: { ...baseEnv(env), ...pick(env, LINUX_PASSTHROUGH_ENV) },
			parse: (status) =>
				status === 0 ? "approved" : status === 5 ? "timeout" : "denied",
		}),
	};
}

export function kdialogBackend(
	command: string,
	env: NodeJS.ProcessEnv,
): ApprovalBackend {
	return {
		name: "kdialog",
		invocation: (dialog) => ({
			command,
			args: [
				"--title",
				dialog.title,
				"--yes-label",
				"Approve",
				"--no-label",
				"Deny",
				"--warningyesno",
				dialog.message,
			],
			env: { ...baseEnv(env), ...pick(env, LINUX_PASSTHROUGH_ENV) },
			parse: (status) => (status === 0 ? "approved" : "denied"),
		}),
	};
}

export function detectApprovalBackend(
	options: DetectOptions = {},
): ApprovalBackend | undefined {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const exists = options.exists ?? fs.existsSync;
	// nobody watches the console of a host the agent reached over SSH
	if (env.SSH_CONNECTION || env.SSH_TTY) return undefined;
	if (platform === "darwin") {
		return exists(OSASCRIPT) ? macosBackend(env) : undefined;
	}
	if (platform === "win32") {
		return exists(POWERSHELL) ? windowsBackend(env) : undefined;
	}
	if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return undefined;
	for (const dir of LINUX_BIN_DIRS) {
		if (exists(`${dir}/zenity`)) return zenityBackend(`${dir}/zenity`, env);
	}
	for (const dir of LINUX_BIN_DIRS) {
		if (exists(`${dir}/kdialog`)) return kdialogBackend(`${dir}/kdialog`, env);
	}
	return undefined;
}

export function runApprovalInvocation(
	invocation: ApprovalInvocation,
	timeoutSeconds: number,
): Promise<ApprovalResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let timedOut = false;
		const child = spawn(invocation.command, invocation.args, {
			env: invocation.env,
			stdio: ["ignore", "pipe", "ignore"],
		});
		// grace period lets native timeouts report themselves first
		const timer = setTimeout(
			() => {
				timedOut = true;
				child.kill();
			},
			(timeoutSeconds + 5) * 1000,
		);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve("unavailable");
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve(timedOut ? "timeout" : invocation.parse(status, stdout));
		});
	});
}
