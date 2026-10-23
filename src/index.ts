#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { CommanderError, program } from "commander";
import { cliExitCode, formatJsonError } from "./agent/errors.js";
import { formatCliError } from "./client.js";
import { registerApplicationLogCommands } from "./commands/application-logs.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerComposeToolCommands } from "./commands/compose-tools.js";
import { registerDeploymentLogsCommand } from "./commands/deployment-logs.js";
import { registerServiceEnvCommands } from "./commands/service-env.js";
import { registerServiceInventoryCommands } from "./commands/service-inventory.js";
import {
	AGENT_SAFE_BUILD,
	registerGeneratedCommands,
} from "./generated/commands.js";

interface BuildInfo {
	version: string;
	commit: string;
	builtAt: string;
	mode: string;
}

const packageJson = JSON.parse(
	fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const pkg = {
	name: "dokploy",
	version: packageJson.version,
	description: "Dokploy CLI - Manage your Dokploy server",
};

function readBuildInfo(): BuildInfo | undefined {
	try {
		const buildInfoPath = path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"build-info.json",
		);
		return JSON.parse(fs.readFileSync(buildInfoPath, "utf8")) as BuildInfo;
	} catch {
		return undefined;
	}
}

function formatVersion(): string {
	const buildInfo = readBuildInfo();
	if (!buildInfo) return pkg.version;
	return `${buildInfo.version} (commit ${buildInfo.commit}, built ${buildInfo.builtAt}, mode ${buildInfo.mode})`;
}

program
	.name(process.env.DOKPLOY_AGENT_BIN ?? pkg.name)
	.version(formatVersion())
	.description(pkg.description)
	.showHelpAfterError()
	.showSuggestionAfterError()
	.exitOverride();

registerAuthCommand(program);
registerGeneratedCommands(program);
registerServiceEnvCommands(program, {
	agentSafe: AGENT_SAFE_BUILD,
});
registerApplicationLogCommands(program);
registerDeploymentLogsCommand(program);
registerServiceInventoryCommands(program);
registerComposeToolCommands(program);

const argv = process.argv.filter((arg) => arg !== "--");

const jsonOutput = argv.includes("--json");

if (jsonOutput) {
	program.configureOutput({
		writeErr: () => {},
		outputError: () => {},
	});
}

if (argv.length <= 2) {
	program.outputHelp();
	process.exit(0);
}

async function run(): Promise<void> {
	try {
		await program.parseAsync(argv);
	} catch (error) {
		if (
			error instanceof CommanderError &&
			(error.code === "commander.helpDisplayed" ||
				error.code === "commander.version")
		) {
			process.exitCode = 0;
			return;
		}

		const message = formatCliError(error);
		if (jsonOutput) {
			console.error(formatJsonError(error, message));
		} else if (!(error instanceof CommanderError)) {
			console.error(chalk.red(message));
		}
		process.exitCode = cliExitCode(error);
	}
}

void run();
