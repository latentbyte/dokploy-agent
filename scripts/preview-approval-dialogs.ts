// renders sample macOS approval dialogs to PNGs offscreen, without showing a
// window or taking focus. usage: tsx scripts/preview-approval-dialogs.ts [outDir]
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ApprovalRequest,
	buildApprovalDialog,
} from "../src/agent/approval.js";
import { macosBackend } from "../src/agent/approval-backends.js";

const outDir = path.resolve(process.argv[2] ?? "tmp/approval-preview");
fs.mkdirSync(outDir, { recursive: true });

const target = {
	kind: "application",
	id: "aBc123XyZ_9",
	name: "web",
	appName: "web-a1b2c3",
	project: "shop",
	environment: "production",
	server: "edge-1",
};
const denial =
	"agent-safe deploy policy rejects application aBc123XyZ_9 in shop/production; allowed projects: sandbox/staging";
const samples: Record<string, ApprovalRequest> = {
	"env-set": {
		endpoint: "application.saveEnvironment",
		title: "env set",
		target,
		lines: [
			{ kind: "remove", text: "STRIPE_KEY=sk_l****9f" },
			{ kind: "add", text: 'STRIPE_KEY="sk_live_example"' },
		],
		audit: {},
		reason: "Rotate the Stripe key after the leak reported in ticket 42.",
	},
	"compose-update": {
		endpoint: "compose.update",
		title: "update",
		target: { ...target, kind: "compose" },
		lines: [
			{ kind: "remove", text: "branch: main" },
			{ kind: "add", text: "branch: release" },
			{ kind: "text", text: "composeFile:" },
			{ kind: "text", text: "..." },
			{ kind: "text", text: "    image: nginx:1.25" },
			{ kind: "remove", text: "    replicas: 1" },
			{ kind: "add", text: "    replicas: 3" },
			{ kind: "text", text: "    ports:" },
			{ kind: "text", text: "..." },
		],
		audit: {},
		reason: "Scale nginx for the launch.\nSwitch to the release branch.",
	},
	deploy: {
		endpoint: "application.deploy",
		title: "deploy",
		target,
		lines: [{ kind: "text", text: "run application.deploy" }],
		audit: {},
	},
};

// stop where the real script would show the window; draw the laid-out alert
const SHOW_MARKER = "\tapp.activateIgnoringOtherApps(true);";

for (const [name, request] of Object.entries(samples)) {
	const dialog = buildApprovalDialog(request, denial, 90, "/home/dev/shop");
	const script = macosBackend({}).invocation(dialog).args[3];
	const cut = script.indexOf(SHOW_MARKER);
	if (cut < 0)
		throw new Error("macOS approval script changed; update SHOW_MARKER");
	const file = path.join(outDir, `${name}.png`);
	const render = `${script.slice(0, cut)}
	approve.enabled = true;
	// offscreen drawing skips the window background, so dark text needs light
	alert.window.appearance = $.NSAppearance.appearanceNamed("NSAppearanceNameAqua");
	alert.layout;
	const content = alert.window.contentView;
	const rep = content.bitmapImageRepForCachingDisplayInRect(content.bounds);
	content.cacheDisplayInRectToBitmapImageRep(content.bounds, rep);
	rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(argv[1], true);
	return "ok";
}`;
	const result = spawnSync(
		"/usr/bin/osascript",
		["-l", "JavaScript", "-e", render, JSON.stringify(dialog), file],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(`${name}: ${result.stderr.trim()}`);
	console.log(file);
}
