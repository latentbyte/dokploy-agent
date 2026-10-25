import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { vi } from "vitest";

// no test may open a real approval dialog or write the real audit log;
// tests that need a backend mock detectApprovalBackend themselves
vi.mock("../src/agent/approval-backends.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../src/agent/approval-backends.js")
	>()),
	detectApprovalBackend: vi.fn(() => undefined),
}));

process.env.XDG_STATE_HOME = fs.mkdtempSync(
	path.join(os.tmpdir(), "dokploy-agent-state-"),
);
