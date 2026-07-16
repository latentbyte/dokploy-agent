import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testWorkflowPath = path.join(ROOT, ".github", "workflows", "test.yml");
const mainWorkflowPath = path.join(
	ROOT,
	".github",
	"workflows",
	"onPushToMain.yml",
);

const testWorkflow = fs.readFileSync(testWorkflowPath, "utf8");
const mainWorkflow = fs.readFileSync(mainWorkflowPath, "utf8");

describe("workflow gates", () => {
	it("runs test workflow on pull requests and checks", () => {
		expect(testWorkflow).toContain("pull_request:");
		expect(testWorkflow).toContain("pnpm run check");
		expect(testWorkflow).toContain("pnpm run build");
		expect(testWorkflow).toContain("pnpm run test");
	});

	it("gates release on verification workflow in main workflow", () => {
		expect(mainWorkflow).toContain("needs: verify");
		expect(mainWorkflow).toContain("pnpm run check");
		expect(mainWorkflow).toContain("pnpm run test");
	});
});
