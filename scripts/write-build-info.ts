import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_PATH = path.join(ROOT, "dist");
const OUT_PATH = path.join(DIST_PATH, "build-info.json");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const AGENT_SAFE_TAG = "agent-safe";

interface PackageJson {
	version: string;
}

function readPackageVersion(): string {
	const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8")) as PackageJson;
	return pkg.version;
}

function readGitValue(args: string[]): string {
	try {
		return execFileSync("git", args, {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "unknown";
	}
}

const buildInfo = {
	version: readPackageVersion(),
	commit: readGitValue(["rev-parse", "--short=12", "HEAD"]),
	commitFull: readGitValue(["rev-parse", "HEAD"]),
	builtAt: new Date().toISOString(),
	mode:
		process.env.DOKPLOY_BUILD_TAG === AGENT_SAFE_TAG ? "agent-safe" : "full",
};

fs.mkdirSync(DIST_PATH, { recursive: true });
fs.writeFileSync(OUT_PATH, `${JSON.stringify(buildInfo, null, 2)}\n`);
console.log(`Wrote ${path.relative(ROOT, OUT_PATH)}`);
