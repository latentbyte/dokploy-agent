import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_PATH = path.join(ROOT, "src");
const DIST_PATH = path.join(ROOT, "dist");
const TMP_ROOT = path.join(ROOT, "tmp");
const AGENT_SAFE_TAG = "agent-safe";

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
	execFileSync(cmd, args, {
		cwd: ROOT,
		stdio: "inherit",
		env: {
			...process.env,
			...env,
		},
	});
}

function writeBuildTsconfig(tempDir: string, tempSrcPath: string): string {
	const tsconfigPath = path.join(tempDir, "tsconfig.agent-safe.json");
	fs.writeFileSync(
		tsconfigPath,
		`${JSON.stringify(
			{
				extends: path.join(ROOT, "tsconfig.json"),
				compilerOptions: {
					rootDir: tempSrcPath,
					outDir: DIST_PATH,
				},
				include: [`${tempSrcPath}/**/*`],
			},
			null,
			2,
		)}\n`,
	);
	return tsconfigPath;
}

fs.mkdirSync(TMP_ROOT, { recursive: true });
const tempDir = fs.mkdtempSync(path.join(TMP_ROOT, "dokploy-agent-build-"));
const tempSrcPath = path.join(tempDir, "src");
const tempGeneratedPath = path.join(tempSrcPath, "generated", "commands.ts");

try {
	fs.cpSync(SRC_PATH, tempSrcPath, { recursive: true });
	run("pnpm", [
		"exec",
		"tsx",
		"scripts/generate.ts",
		"--agent-safe",
		"--out",
		tempGeneratedPath,
	]);
	run("pnpm", ["exec", "tsc", "-p", writeBuildTsconfig(tempDir, tempSrcPath)]);
	run("pnpm", ["exec", "tsx", "scripts/write-build-info.ts"], {
		DOKPLOY_BUILD_TAG: AGENT_SAFE_TAG,
	});
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}
