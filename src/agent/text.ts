// controls, characters some parsers treat as line breaks (dotenv's multiline
// ^ matches after U+2028/U+2029), and bidi or invisible marks that hide or
// reorder text on screen
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x00, 0x08],
	[0x0b, 0x1f],
	[0x7f, 0x9f],
	[0x200b, 0x200f],
	[0x2028, 0x202e],
	[0x2060, 0x2069],
	[0xfeff, 0xfeff],
];

export function isUnsafeTextChar(code: number): boolean {
	return UNSAFE_RANGES.some(([start, end]) => code >= start && code <= end);
}

function codeLabel(code: number): string {
	return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** first unsafe character as U+XXXX, or undefined; tab and newline are fine */
export function firstUnsafeChar(value: string): string | undefined {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (isUnsafeTextChar(code)) return codeLabel(code);
	}
	return undefined;
}

/** single-line display text: newlines, tabs, and unsafe characters become visible escapes */
export function escapeForDisplay(value: string): string {
	let out = "";
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (char === "\n") out += "\\n";
		else if (char === "\r") out += "\\r";
		else if (char === "\t") out += "\\t";
		else if (isUnsafeTextChar(code)) out += `<${codeLabel(code)}>`;
		else out += char;
	}
	return out;
}
