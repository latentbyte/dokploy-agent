import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = path.join(ROOT, ".github", "workflows");
const testWorkflow = fs.readFileSync(
	path.join(workflowsDir, "test.yml"),
	"utf8",
);
const agentSafeWorkflow = fs.readFileSync(
	path.join(workflowsDir, "agent-safe.yml"),
	"utf8",
);

describe("workflow gates", () => {
	it("runs test workflow on pull requests and checks", () => {
		expect(testWorkflow).toContain("pull_request:");
		expect(testWorkflow).toContain("pnpm run check");
		expect(testWorkflow).toContain("pnpm run build");
		expect(testWorkflow).toContain("pnpm run test");
	});

	it("runs verification on every push, including main", () => {
		for (const workflow of [testWorkflow, agentSafeWorkflow]) {
			expect(workflow).toContain("push:");
			expect(workflow).not.toContain("branches-ignore");
		}
	});

	it("has no npm publish workflow", () => {
		expect(fs.readdirSync(workflowsDir).sort()).toEqual([
			"agent-safe.yml",
			"test.yml",
		]);
	});
});
