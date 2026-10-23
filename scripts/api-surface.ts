/**
 * Rewrites docs/agent-safe-api-surface.json from an agent-safe dist build.
 *
 * Usage: just api-surface
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface SafetyEntry {
	endpoint: string;
	group: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = path.join(ROOT, "docs", "agent-safe-api-surface.json");

const buildInfo = JSON.parse(
	fs.readFileSync(path.join(ROOT, "dist", "build-info.json"), "utf8"),
) as { mode: string };
if (buildInfo.mode !== "agent-safe") {
	throw new Error("dist is not an agent-safe build; run just build-agent-safe");
}

// isolated config so the report never reads real credentials or policy
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-surface-"));
function report<T>(kind: string): T {
	const output = execFileSync(
		"node",
		[path.join(ROOT, "dist", "index.js"), "agent-safety", kind, "--json"],
		{
			encoding: "utf8",
			env: {
				...process.env,
				DOKPLOY_CONFIG_PATH: path.join(configDir, "config.json"),
				XDG_CONFIG_HOME: configDir,
			},
		},
	);
	return JSON.parse(output) as T;
}

function byGroup(entries: SafetyEntry[]): Record<string, SafetyEntry[]> {
	const groups: Record<string, SafetyEntry[]> = {};
	for (const entry of entries) {
		const list = groups[entry.group] ?? [];
		list.push(entry);
		groups[entry.group] = list;
	}
	return groups;
}

try {
	const allowed = report<SafetyEntry[]>("allowed");
	const disallowed = report<SafetyEntry[]>("disallowed");
	const hidden = report<SafetyEntry[]>("hidden");
	const unavailable = report<SafetyEntry[]>("unavailable");
	const logs = report<Record<string, SafetyEntry[]>>("logs");
	const spec = JSON.parse(
		fs.readFileSync(path.join(ROOT, "openapi.json"), "utf8"),
	) as { paths: Record<string, Record<string, unknown>> };
	const operationCount = Object.values(spec.paths).reduce(
		(count, methods) => count + Object.keys(methods).length,
		0,
	);

	const surface = {
		generated: {
			total: allowed.length + disallowed.length + hidden.length,
			safe_count: allowed.length,
			disallowed_count: disallowed.length,
			hidden_count: hidden.length,
			safe: byGroup(allowed),
			disallowed: byGroup(disallowed),
			hidden: byGroup(hidden),
			logs: {
				allowed: logs.allowed ?? [],
				disallowed: logs.disallowed ?? [],
				hidden: logs.hidden ?? [],
			},
		},
		openapi: {
			total: operationCount,
			unavailable_count: unavailable.length,
			unavailable: byGroup(unavailable),
			logs: logs.unavailable ?? [],
		},
	};
	fs.writeFileSync(OUT_PATH, `${JSON.stringify(surface, null, "\t")}\n`);
	console.log(
		`Wrote ${path.relative(ROOT, OUT_PATH)}: ${allowed.length} allowed, ${disallowed.length} disallowed, ${hidden.length} hidden`,
	);
} finally {
	fs.rmSync(configDir, { recursive: true, force: true });
}
