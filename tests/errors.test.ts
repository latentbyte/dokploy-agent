import { CommanderError } from "commander";
import { describe, expect, it } from "vitest";
import {
	agentPolicyBlocked,
	CliError,
	cliErrorCode,
	cliExitCode,
	formatJsonError,
} from "../src/agent/errors.js";

describe("agent errors", () => {
	it("policy denials use code AGENT_POLICY_BLOCKED and exit 2", () => {
		const error = agentPolicyBlocked("nope");
		expect(cliErrorCode(error)).toBe("AGENT_POLICY_BLOCKED");
		expect(cliExitCode(error)).toBe(2);
	});

	it("CliError defaults to exit 1", () => {
		expect(cliExitCode(new CliError("X", "m"))).toBe(1);
	});

	it("uses commander's code and exit code", () => {
		const error = new CommanderError(9, "commander.x", "bad");
		expect(cliErrorCode(error)).toBe("commander.x");
		expect(cliExitCode(error)).toBe(9);
	});

	it("falls back for unknown errors", () => {
		expect(cliErrorCode(new Error("x"))).toBe("CLI_ERROR");
		expect(cliExitCode("boom")).toBe(1);
	});

	it("formats the JSON error shape", () => {
		expect(JSON.parse(formatJsonError(new CliError("C", "m"), "msg"))).toEqual({
			ok: false,
			error: { code: "C", message: "msg" },
		});
	});
});
