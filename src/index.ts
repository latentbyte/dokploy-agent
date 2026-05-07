#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { program } from "commander";
import { formatCliError } from "./client.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerDeploymentLogsCommand } from "./commands/deployment-logs.js";
import { registerGeneratedCommands } from "./generated/commands.js";

interface BuildInfo {
	version: string;
	commit: string;
	builtAt: string;
	mode: string;
}

const pkg = {
	name: "dokploy",
	version: "0.29.2",
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
registerDeploymentLogsCommand(program);

const argv = process.argv.filter((arg) => arg !== "--");

if (argv.length <= 2) {
	program.outputHelp();
	process.exit(0);
}

program.parseAsync(argv).catch((err) => {
	console.error(chalk.red(formatCliError(err)));
	process.exit(1);
});
