#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { CommanderError, program } from "commander";
import { formatCliError } from "./client.js";
import { registerApplicationEnvCommands } from "./commands/application-env.js";
import { registerApplicationLogCommands } from "./commands/application-logs.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerComposeToolCommands } from "./commands/compose-tools.js";
import { registerDeploymentLogsCommand } from "./commands/deployment-logs.js";
import { registerServiceInventoryCommands } from "./commands/service-inventory.js";
import { registerGeneratedCommands } from "./generated/commands.js";

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
	.showSuggestionAfterError();

registerAuthCommand(program);
registerGeneratedCommands(program);
registerApplicationEnvCommands(program, {
	agentSafe: readBuildInfo()?.mode === "agent-safe",
});
registerApplicationLogCommands(program);
registerDeploymentLogsCommand(program);
registerServiceInventoryCommands(program);
registerComposeToolCommands(program);

const argv = process.argv.filter((arg) => arg !== "--");

if (argv.includes("--json")) {
	program.configureOutput({
		writeErr: () => {},
		outputError: () => {},
	});
}

if (argv.length <= 2) {
	program.outputHelp();
	process.exit(0);
}

program.exitOverride();

program.parseAsync(argv).catch((err) => {
	if (
		err instanceof CommanderError &&
		(err.code === "commander.helpDisplayed" || err.code === "commander.version")
	) {
		process.exit(0);
	}

	if (argv.includes("--json")) {
		const code = err instanceof CommanderError ? err.code : "CLI_ERROR";
		console.error(
			JSON.stringify(
				{
					ok: false,
					error: {
						code,
						message: formatCliError(err),
					},
				},
				null,
				2,
			),
		);
	} else if (!(err instanceof CommanderError)) {
		console.error(chalk.red(formatCliError(err)));
	}
	process.exit(1);
});
