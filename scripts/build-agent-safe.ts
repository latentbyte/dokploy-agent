import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const GENERATED_PATH = path.join(ROOT, "src", "generated", "commands.ts");
const AGENT_SAFE_TAG = "agent-safe";

interface GeneratedBackup {
	existed: boolean;
	content?: string;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): void {
	execFileSync("pnpm", args, {
		cwd: ROOT,
		stdio: "inherit",
		env: {
			...process.env,
			...env,
		},
	});
}

function readGeneratedBackup(): GeneratedBackup {
	if (!fs.existsSync(GENERATED_PATH)) {
		return { existed: false };
	}

	return {
		existed: true,
		content: fs.readFileSync(GENERATED_PATH, "utf8"),
	};
}

function restoreGenerated(backup: GeneratedBackup): void {
	if (!backup.existed) {
		fs.rmSync(GENERATED_PATH, { force: true });
		return;
	}

	fs.writeFileSync(GENERATED_PATH, backup.content ?? "");
}

const backup = readGeneratedBackup();

try {
	run(["run", "generate:agent-safe"]);
	run(["exec", "tsc", "-b"]);
	run(["exec", "tsx", "scripts/write-build-info.ts"], {
		DOKPLOY_BUILD_TAG: AGENT_SAFE_TAG,
	});
} finally {
	restoreGenerated(backup);
}
