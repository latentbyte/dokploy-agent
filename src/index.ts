#!/usr/bin/env node

import chalk from "chalk";
import { program } from "commander";
import { registerAuthCommand } from "./commands/auth.js";
import { registerGeneratedCommands } from "./generated/commands.js";

const pkg = {
	name: "dokploy",
	version: "0.3.0",
	description: "Dokploy CLI - Manage your Dokploy server",
};

program
	.name(process.env.DOKPLOY_AGENT_BIN ?? pkg.name)
	.version(pkg.version)
	.description(pkg.description)
	.showHelpAfterError()
	.showSuggestionAfterError();

registerAuthCommand(program);
registerGeneratedCommands(program);

const argv = process.argv.filter((arg) => arg !== "--");

if (argv.length <= 2) {
	program.outputHelp();
	process.exit(0);
}

program.parseAsync(argv).catch((err) => {
	console.error(chalk.red(err.message));
	process.exit(1);
});
