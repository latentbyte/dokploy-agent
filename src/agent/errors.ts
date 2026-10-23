import { CommanderError } from "commander";

export class CliError extends Error {
	readonly code: string;
	readonly exitCode: number;

	constructor(code: string, message: string, exitCode = 1) {
		super(message);
		this.name = "CliError";
		this.code = code;
		this.exitCode = exitCode;
	}
}

// policy denials share one code and exit status so agents can tell them apart
export function agentPolicyBlocked(message: string): CliError {
	return new CliError("AGENT_POLICY_BLOCKED", message, 2);
}

export function cliErrorCode(error: unknown): string {
	if (error instanceof CliError) return error.code;
	if (error instanceof CommanderError) return error.code;
	return "CLI_ERROR";
}

export function cliExitCode(error: unknown): number {
	if (error instanceof CliError) return error.exitCode;
	if (error instanceof CommanderError) return error.exitCode;
	return 1;
}

export function formatJsonError(error: unknown, message: string): string {
	return JSON.stringify(
		{
			ok: false,
			error: {
				code: cliErrorCode(error),
				message,
			},
		},
		null,
		2,
	);
}
