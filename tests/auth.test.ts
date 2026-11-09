import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerAuthCommand } from "../src/commands/auth.js";

describe("auth command", () => {
	const names = (agentSafe: boolean) => {
		const program = new Command();
		registerAuthCommand(program, { agentSafe });
		return program.commands.map((command) => command.name());
	};

	it("is left out of agent-safe builds so agents cannot rewrite the config", () => {
		expect(names(true)).not.toContain("auth");
		expect(names(false)).toContain("auth");
	});
});
