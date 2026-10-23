import { parseEnvDocument, unquoteEnvValue } from "./env-document.js";
import { DOKPLOY_RESOURCE_ID_KEYS } from "./generated/resource-ids.js";

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

const SECRET_KEY_PARTS = new Set([
	"api",
	"key",
	"id",
	"url",
	"uri",
	"token",
	"secret",
	"password",
	"passworkd",
	"passwd",
	"pass",
	"pwd",
	"credential",
	"credentials",
	"private",
	"privatekey",
	"authorization",
	"webhook",
	"dsn",
]);
const LOG_KEY_PATTERN = /(?:log|logs|stdout|stderr|message|output)/i;
const PUBLIC_IDENTIFIER_KEYS = new Set([
	...DOKPLOY_RESOURCE_ID_KEYS.map((key) => key.toLowerCase()),
	"id",
	"containerid",
	"applicationid",
	"composeid",
	"deploymentid",
	"domainid",
	"environmentid",
	"githubid",
	"gitproviderid",
	"projectid",
	"serverid",
	"buildserverid",
	"registryid",
	"buildregistryid",
	"rollbackregistryid",
	"postgresid",
	"mysqlid",
	"mariadbid",
	"mongoid",
	"redisid",
	"libsqlid",
]);
const ENV_KEY_PATTERN =
	/(?:api|key|token|secret|password|passworkd|passwd|pass|pwd|credential|private|authorization|webhook|dsn|url|uri)/i;
const ENV_DOCUMENT_KEYS = new Set(["env", "previewenv"]);
// optional quote after the key covers JSON text; NUL covers /proc/*/environ
const ENV_ASSIGNMENT_PATTERN =
	/(^|[\s([{,;'"\0-])([A-Za-z_][A-Za-z0-9_.-]*)("?\s*[:=]\s*)((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"',}\]\0]+))/gm;
const PRIVATE_KEY_BLOCK_PATTERN =
	/(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g;
// well-known credential formats that need no key name to be recognized
const TOKEN_PREFIX_PATTERN =
	/\b(?:sk-[A-Za-z0-9_-]{20,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abeoprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36})\b/g;

function stripQuotedValue(value: string): string {
	if (value.length < 2) return value;
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1).replace(/\\(["'])/g, "$1");
	}
	return value;
}

const STRING_SECRET_PATTERNS: Array<
	[RegExp, (match: string, ...groups: string[]) => string]
> = [
	[
		PRIVATE_KEY_BLOCK_PATTERN,
		(_match, begin: string, end: string) =>
			`${begin}\n[private key hidden]\n${end}`,
	],
	[
		ENV_ASSIGNMENT_PATTERN,
		(
			match: string,
			prefix: string,
			key: string,
			separator: string,
			value: string,
		) => {
			if (!isSensitiveEnvKey(key)) {
				// quoted values of benign keys (JSON log fields) can embed assignments
				const quote = value[0];
				if ((quote === '"' || quote === "'") && value.length > 1) {
					return `${prefix}${key}${separator}${quote}${redactString(value.slice(1, -1))}${quote}`;
				}
				return match;
			}
			if (key.toLowerCase() === "authorization") {
				const bare = stripQuotedValue(value);
				if (/^(bearer|basic)$/i.test(bare)) return match;
			}
			return `${prefix}${key}${separator}${maskSecret(stripQuotedValue(value))}`;
		},
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
	[TOKEN_PREFIX_PATTERN, (match) => maskSecret(match)],
];

// reveal at most a third of a value: 4-char prefix from 12 chars, plus a 4-char
// suffix from 24; length always shown so agents can tell values apart
const MASK_EDGE_CHARS = 4;
const MASK_PREFIX_MIN_LENGTH = 12;
const MASK_SUFFIX_MIN_LENGTH = 24;

export function maskSecret(value: unknown): string {
	const text = String(value);
	const length = ` (${text.length} chars)`;
	if (text.length < MASK_PREFIX_MIN_LENGTH) return `***${length}`;
	const prefix = text.slice(0, MASK_EDGE_CHARS);
	if (text.length < MASK_SUFFIX_MIN_LENGTH) return `${prefix}***${length}`;
	return `${prefix}***${text.slice(-MASK_EDGE_CHARS)}${length}`;
}

// any line that is not a blank, comment, or assignment is hidden too: it may be
// a stray piece of a value, such as an unterminated quoted key
export function redactEnvDocument(input: string): string {
	return parseEnvDocument(input)
		.map(({ index, length, eol, assignment }) => {
			const text = input.slice(index, index + length);
			if (assignment) {
				const { prefix, name, separator, value } = assignment;
				return `${prefix}${name}${separator}${maskSecret(unquoteEnvValue(value))}${eol}`;
			}
			if (!text.trim()) return `${text}${eol}`;
			if (text.trimStart().startsWith("#")) return `# [comment hidden]${eol}`;
			return `[line hidden]${eol}`;
		})
		.join("");
}

export function isSensitiveKey(key: string): boolean {
	const parts = key
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);

	return parts.some((part) => SECRET_KEY_PARTS.has(part));
}

export function isPublicIdentifierKey(key: string): boolean {
	return PUBLIC_IDENTIFIER_KEYS.has(
		key.toLowerCase().replace(/[^a-z0-9]+/g, ""),
	);
}

export function isSensitiveEnvKey(key: string): boolean {
	if (isSensitiveKey(key)) return true;
	const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
	return (
		ENV_KEY_PATTERN.test(key) ||
		normalized === "id" ||
		(normalized.endsWith("id") && normalized !== "valid")
	);
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
		if (
			key &&
			ENV_DOCUMENT_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]+/g, ""))
		) {
			return redactEnvDocument(data);
		}
		if (key && isSensitiveKey(key) && !isPublicIdentifierKey(key)) {
			return maskSecret(data);
		}
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

	if (typeof data === "number" || typeof data === "boolean") {
		if (key && isSensitiveKey(key) && !isPublicIdentifierKey(key)) {
			return maskSecret(String(data));
		}
		return data;
	}

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
