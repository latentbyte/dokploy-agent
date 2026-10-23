// dotenv-style documents as Dokploy stores them; quoted values may span lines,
// so assignments are located by scanning rather than per-line regexes

export interface EnvLine {
	/** offset of the first character */
	index: number;
	/** length up to, not including, the line ending */
	length: number;
	/** line ending after the segment: "", "\n", or "\r\n" */
	eol: string;
	assignment?: {
		prefix: string;
		name: string;
		separator: string;
		value: string;
	};
}

const ASSIGNMENT_START_PATTERN =
	/^([\t ]*(?:export[\t ]+)?)([A-Za-z_][A-Za-z0-9_.-]*)([\t ]*=[\t ]*)/;

function lineEndAt(document: string, from: number): number {
	const newline = document.indexOf("\n", from);
	if (newline === -1) return document.length;
	return newline > from && document[newline - 1] === "\r"
		? newline - 1
		: newline;
}

function eolAt(document: string, end: number): string {
	if (document.startsWith("\r\n", end)) return "\r\n";
	if (document.startsWith("\n", end)) return "\n";
	return "";
}

function closingQuoteIndex(
	document: string,
	from: number,
	quote: string,
): number {
	for (let i = from; i < document.length; i += 1) {
		const char = document[i];
		if (quote === '"' && char === "\\") {
			i += 1;
			continue;
		}
		if (char === quote) return i;
	}
	return -1;
}

// one entry per logical line; a quoted multi-line value is one entry
export function parseEnvDocument(document: string): EnvLine[] {
	const lines: EnvLine[] = [];
	let index = 0;
	while (index < document.length) {
		let end = lineEndAt(document, index);
		const match = document.slice(index, end).match(ASSIGNMENT_START_PATTERN);
		let assignment: EnvLine["assignment"];
		if (match) {
			const valueStart = index + match[0].length;
			const quote = document[valueStart];
			if (quote === '"' || quote === "'") {
				const close = closingQuoteIndex(document, valueStart + 1, quote);
				// unterminated quotes stay single-line, matching lenient parsers
				if (close > end) end = lineEndAt(document, close);
			}
			assignment = {
				prefix: match[1] ?? "",
				name: match[2] ?? "",
				separator: match[3] ?? "",
				value: document.slice(valueStart, end),
			};
		}
		const eol = eolAt(document, end);
		lines.push({ index, length: end - index, eol, assignment });
		index = end + eol.length;
	}
	return lines;
}

export function unquoteEnvValue(value: string): string {
	const trimmed = value.trim();
	const match = trimmed.match(/^(["'])([\s\S]*)\1$/);
	if (!match) return trimmed;
	return (match[2] ?? "").replace(/\\(["'])/g, "$1");
}
