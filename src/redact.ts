export interface SanitizeOptions {
	logOutput?: boolean;
	maxLogLines?: number;
	maxLogChars?: number;
	logSearch?: string;
	logContext?: number;
	logCaseSensitive?: boolean;
}

const DEFAULT_MAX_LOG_LINES = 500;
const DEFAULT_MAX_LOG_CHARS = 50_000;

const SECRET_KEY_PATTERN =
	/(?:api.?key|token|secret|password|passwd|pass|credential|private|privatekey|authorization|webhook|dsn|database.?url)/i;
const LOG_KEY_PATTERN = /(?:log|logs|stdout|stderr|message|output)/i;

const STRING_SECRET_PATTERNS: Array<
	[RegExp, (match: string, ...groups: string[]) => string]
> = [
	[
		/(\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|DSN)[A-Z0-9_]*\s*=\s*["']?)([^\s"']+)/gi,
		(_match, prefix: string, value: string) => `${prefix}${maskSecret(value)}`,
	],
	[
		/(\b(?:x-api-key|api-key|token|secret|password)\b\s*[:=]\s*["']?)([^\s"',}]+)/gi,
		(_match, prefix: string, value: string) => `${prefix}${maskSecret(value)}`,
	],
	[
		/(\b(?:bearer|basic)\s+)([a-z0-9._~+/-]+=*)/gi,
		(_match, prefix: string, value: string) => `${prefix}${maskSecret(value)}`,
	],
	[
		/(\/\/[^\s:/@]+:)([^\s@]+)(@)/g,
		(_match, prefix: string, value: string, suffix: string) =>
			`${prefix}${maskSecret(value)}${suffix}`,
	],
	[
		/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
		(match) => maskSecret(match),
	],
];

export function maskSecret(value: unknown): string {
	const text = String(value);
	if (text.length <= 4) return text;
	return `${text.slice(0, 4)}***`;
}

export function redactString(input: string): string {
	let output = input;
	for (const [pattern, replacer] of STRING_SECRET_PATTERNS) {
		output = output.replace(pattern, replacer);
	}
	return output;
}

export function filterLogString(
	input: string,
	search: string | undefined,
	context = 0,
	caseSensitive = false,
): string {
	if (!search) return input;

	const lines = input.split(/\r?\n/);
	const needle = caseSensitive ? search : search.toLowerCase();
	const matchedIndexes = new Set<number>();

	for (const [index, line] of lines.entries()) {
		const haystack = caseSensitive ? line : line.toLowerCase();
		if (!haystack.includes(needle)) continue;

		const start = Math.max(0, index - context);
		const end = Math.min(lines.length - 1, index + context);
		for (let i = start; i <= end; i += 1) {
			matchedIndexes.add(i);
		}
	}

	if (matchedIndexes.size === 0) return "[no log lines matched search query]";

	const output: string[] = [];
	let previousIndex = -1;
	for (const index of [...matchedIndexes].sort((a, b) => a - b)) {
		if (previousIndex !== -1 && index > previousIndex + 1) {
			output.push("[omitted non-matching log lines]");
		}
		output.push(lines[index]);
		previousIndex = index;
	}
	return output.join("\n");
}

export function limitLogString(
	input: string,
	maxLines = DEFAULT_MAX_LOG_LINES,
	maxChars = DEFAULT_MAX_LOG_CHARS,
): string {
	let output = input;
	const lines = output.split(/\r?\n/);
	if (maxLines > 0 && lines.length > maxLines) {
		const omitted = lines.length - maxLines;
		output = `[truncated to last ${maxLines} lines, omitted ${omitted} lines]\n${lines.slice(-maxLines).join("\n")}`;
	}
	if (maxChars > 0 && output.length > maxChars) {
		const omitted = output.length - maxChars;
		output = `[truncated to last ${maxChars} chars, omitted ${omitted} chars]\n${output.slice(-maxChars)}`;
	}
	return output;
}

export function sanitizeForAgent(
	data: unknown,
	options: SanitizeOptions = {},
): unknown {
	return sanitizeValue(data, options, undefined);
}

function sanitizeValue(
	data: unknown,
	options: SanitizeOptions,
	key: string | undefined,
): unknown {
	if (data === null || data === undefined) return data;

	if (typeof data === "string") {
		if (key && SECRET_KEY_PATTERN.test(key)) return maskSecret(data);
		const redacted = redactString(data);
		if (options.logOutput || (key && LOG_KEY_PATTERN.test(key))) {
			const filtered = filterLogString(
				redacted,
				options.logSearch,
				options.logContext,
				options.logCaseSensitive,
			);
			return limitLogString(filtered, options.maxLogLines, options.maxLogChars);
		}
		return redacted;
	}

	if (typeof data === "number" || typeof data === "boolean") return data;

	if (Array.isArray(data)) {
		return data.map((item) => sanitizeValue(item, options, key));
	}

	if (typeof data === "object") {
		const sanitized: Record<string, unknown> = {};
		for (const [entryKey, value] of Object.entries(data)) {
			sanitized[entryKey] = sanitizeValue(value, options, entryKey);
		}
		return sanitized;
	}

	return data;
}
