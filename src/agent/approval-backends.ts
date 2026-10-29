import { spawn } from "node:child_process";
import * as fs from "node:fs";

// OS dialogs the agent cannot answer through stdin or a pty. Binaries come
// from fixed system paths and run with a minimal env, so PATH, LD_PRELOAD,
// or similar overrides cannot swap in a fake approver

export type ApprovalResult = "approved" | "denied" | "timeout" | "unavailable";

// styling hint only; the text itself carries any +/- markers so plain-text
// backends lose nothing
export type DialogLineKind = "heading" | "text" | "note" | "add" | "remove";

export interface DialogLine {
	kind: DialogLineKind;
	text: string;
}

export interface ApprovalDialog {
	title: string;
	heading: string;
	intro: string;
	lines: DialogLine[];
	timeoutSeconds: number;
}

// first line stays plain text so kdialog does not switch to rich text
export function plainDialogText(dialog: ApprovalDialog): string {
	return [
		dialog.intro,
		"",
		dialog.heading,
		...dialog.lines.map((line) => line.text),
	].join("\n");
}

export interface ApprovalInvocation {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	// backends with a native timeout exit on their own; the runner kills the
	// rest after timeoutSeconds
	parse(status: number | null, stdout: string): ApprovalResult;
}

// fire-and-forget desktop notification; output and exit status are ignored
export type ReminderInvocation = Omit<ApprovalInvocation, "parse">;

export interface ApprovalBackend {
	name: "macos" | "windows" | "zenity" | "kdialog";
	invocation(dialog: ApprovalDialog): ApprovalInvocation;
	// nudges a user who has not answered yet; backends without one stay silent
	reminder?(
		dialog: ApprovalDialog,
		remainingSeconds: number,
	): ReminderInvocation;
}

function reminderText(dialog: ApprovalDialog, remainingSeconds: number) {
	return {
		title: "dokploy-agent approval waiting",
		body: `${dialog.heading} Denied automatically in ${remainingSeconds}s.`,
	};
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

// JXA builds a native NSAlert with a styled, scrollable text view. The dialog
// arrives as one JSON argv item and is only ever parsed as data, so names and
// values never become script source. Return answers Deny, which counts down
// to the native timeout (abortModal); Approve arms after a short delay so a
// click meant for another window cannot land on it
const MACOS_SCRIPT = String.raw`ObjC.import("Cocoa");
function run(argv) {
	const spec = JSON.parse(argv[0]);
	const app = $.NSApplication.sharedApplication;
	app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
	const alert = $.NSAlert.alloc.init;
	alert.icon = $.NSImage.imageNamed("NSCaution");
	alert.messageText = spec.heading;
	alert.informativeText = spec.intro;
	const deny = alert.addButtonWithTitle("Deny (" + spec.timeoutSeconds + "s)");
	const approve = alert.addButtonWithTitle("Approve");
	approve.hasDestructiveAction = true;
	approve.enabled = false;
	const width = 560;
	const view = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, width, 80));
	view.editable = false;
	view.textContainerInset = $.NSMakeSize(6, 8);
	view.string = spec.lines.map((line) => line.text).join("\n");
	const store = view.textStorage;
	const mono = $.NSFont.monospacedSystemFontOfSizeWeight(12, 0);
	const fonts = {
		heading: $.NSFont.boldSystemFontOfSize(11),
		note: $.NSFont.systemFontOfSize(12),
	};
	const colors = {
		heading: $.NSColor.secondaryLabelColor,
		note: $.NSColor.secondaryLabelColor,
		add: $.NSColor.systemGreenColor,
		remove: $.NSColor.systemRedColor,
	};
	// one block per kind, so adjacent rows of a kind share a full-width band
	const rows = {};
	for (const kind of ["add", "remove"]) {
		const block = $.NSTextBlock.alloc.init;
		block.backgroundColor = colors[kind].colorWithAlphaComponent(0.14);
		block.setValueTypeForDimension(100, $.NSTextBlockPercentageValueType, $.NSTextBlockWidth);
		const style = $.NSMutableParagraphStyle.alloc.init;
		style.textBlocks = $([block]);
		rows[kind] = style;
	}
	const total = view.string.length;
	let at = 0;
	for (const line of spec.lines) {
		// include the newline so paragraph styles cover the whole row
		const range = $.NSMakeRange(at, Math.min(line.text.length + 1, total - at));
		store.addAttributeValueRange($.NSFontAttributeName, fonts[line.kind] || mono, range);
		store.addAttributeValueRange($.NSForegroundColorAttributeName, colors[line.kind] || $.NSColor.labelColor, range);
		if (rows[line.kind]) store.addAttributeValueRange($.NSParagraphStyleAttributeName, rows[line.kind], range);
		at += line.text.length + 1;
	}
	// fit the text, leaving room on screen for the alert chrome around it
	view.layoutManager.ensureLayoutForTextContainer(view.textContainer);
	const used = view.layoutManager.usedRectForTextContainer(view.textContainer).size.height + 16;
	const screen = $.NSScreen.mainScreen;
	const room = screen.isNil() ? 360 : screen.visibleFrame.size.height - 300;
	const height = Math.min(Math.max(used, 80), Math.max(room, 200));
	const scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(0, 0, width, height));
	scroll.hasVerticalScroller = true;
	scroll.borderType = $.NSBezelBorder;
	scroll.documentView = view;
	alert.accessoryView = scroll;
	alert.layout;
	alert.window.title = spec.title;
	app.activateIgnoringOtherApps(true);
	const opened = Date.now();
	const tick = $.NSTimer.timerWithTimeIntervalRepeatsBlock(0.25, true, () => {
		const elapsed = (Date.now() - opened) / 1000;
		deny.title = "Deny (" + Math.max(0, Math.ceil(spec.timeoutSeconds - elapsed)) + "s)";
		if (elapsed >= 1) approve.enabled = true;
	});
	$.NSRunLoop.currentRunLoop.addTimerForMode(tick, "NSModalPanelRunLoopMode");
	app.performSelectorWithObjectAfterDelayInModes("abortModal", $(), spec.timeoutSeconds, $(["NSModalPanelRunLoopMode"]));
	const response = Number(alert.runModal);
	tick.invalidate;
	if (response === -1001) return "timeout";
	return response === 1001 ? "approved" : "denied";
}`;

// same argv-as-data rule as the dialog script
const MACOS_REMINDER_SCRIPT = `function run(argv) {
	const spec = JSON.parse(argv[0]);
	const app = Application.currentApplication();
	app.includeStandardAdditions = true;
	app.displayNotification(spec.body, { withTitle: spec.title, soundName: "Ping" });
}`;

export function macosBackend(env: NodeJS.ProcessEnv): ApprovalBackend {
	return {
		name: "macos",
		invocation: (dialog) => ({
			command: OSASCRIPT,
			args: ["-l", "JavaScript", "-e", MACOS_SCRIPT, JSON.stringify(dialog)],
			env: baseEnv(env),
			parse: (status, stdout) => {
				const out = stdout.trim();
				if (status === 0 && out === "approved") return "approved";
				if (status === 0 && out === "timeout") return "timeout";
				return "denied";
			},
		}),
		reminder: (dialog, remainingSeconds) => ({
			command: OSASCRIPT,
			args: [
				"-l",
				"JavaScript",
				"-e",
				MACOS_REMINDER_SCRIPT,
				JSON.stringify(reminderText(dialog, remainingSeconds)),
			],
			env: baseEnv(env),
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
				DOKPLOY_APPROVAL_MESSAGE: `${plainDialogText(dialog)}\n\nYes approves, No denies.`,
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
				plainDialogText(dialog),
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
		reminder: (dialog, remainingSeconds) => {
			const { title, body } = reminderText(dialog, remainingSeconds);
			return {
				command,
				args: ["--notification", "--no-markup", "--text", `${title}\n${body}`],
				env: { ...baseEnv(env), ...pick(env, LINUX_PASSTHROUGH_ENV) },
			};
		},
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
				plainDialogText(dialog),
			],
			env: { ...baseEnv(env), ...pick(env, LINUX_PASSTHROUGH_ENV) },
			parse: (status) => (status === 0 ? "approved" : "denied"),
		}),
		reminder: (dialog, remainingSeconds) => {
			const { title, body } = reminderText(dialog, remainingSeconds);
			return {
				command,
				args: ["--title", title, "--passivepopup", body, "10"],
				env: { ...baseEnv(env), ...pick(env, LINUX_PASSTHROUGH_ENV) },
			};
		},
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

export function runReminderInvocation(invocation: ReminderInvocation): void {
	try {
		const child = spawn(invocation.command, invocation.args, {
			env: invocation.env,
			stdio: "ignore",
		});
		child.on("error", () => {});
		// a lingering popup must not hold the CLI open after the dialog closes
		child.unref();
	} catch {
		// best effort; the dialog itself still enforces the deadline
	}
}
