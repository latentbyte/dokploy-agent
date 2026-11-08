// [start, end) offsets into a line, in UTF-16 units like NSRange
export type Span = [number, number];

// word runs, whitespace runs, and single punctuation chars, so a host like
// a.b vs a-b highlights only the separator
const TOKEN = /[\p{L}\p{N}_]+|\s+|./gsu;

function spans(tokens: string[], changed: boolean[]): Span[] {
	const out: Span[] = [];
	let at = 0;
	tokens.forEach((token, i) => {
		const end = at + token.length;
		if (changed[i]) {
			const last = out.at(-1);
			if (last && last[1] === at) last[1] = end;
			else out.push([at, end]);
		}
		at = end;
	});
	return out;
}

// token-level LCS diff of a removed/added line pair. Undefined when the lines
// share no visible token, since highlighting everything says nothing
export function wordDiff(
	before: string,
	after: string,
): { before: Span[]; after: Span[] } | undefined {
	const a = before.match(TOKEN) ?? [];
	const b = after.match(TOKEN) ?? [];
	const lcs = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0),
	);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i][j] =
				a[i] === b[j]
					? lcs[i + 1][j + 1] + 1
					: Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const changedA = a.map(() => true);
	const changedB = b.map(() => true);
	let shared = false;
	for (let i = 0, j = 0; i < a.length && j < b.length; ) {
		if (a[i] === b[j]) {
			changedA[i] = false;
			changedB[j] = false;
			if (a[i].trim()) shared = true;
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
		else j++;
	}
	if (!shared) return undefined;
	return { before: spans(a, changedA), after: spans(b, changedB) };
}
