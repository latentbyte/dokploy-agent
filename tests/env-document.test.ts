import { describe, expect, it } from "vitest";
import { parseEnvDocument, unquoteEnvValue } from "../src/env-document.js";

describe("parseEnvDocument", () => {
	it("splits assignments, comments, and blanks with their line endings", () => {
		const doc = "# note\r\nA=1\n\nexport B = two";
		const lines = parseEnvDocument(doc);
		expect(lines.map((l) => l.eol)).toEqual(["\r\n", "\n", "\n", ""]);
		expect(lines[0]?.assignment).toBeUndefined();
		expect(lines[1]?.assignment).toEqual({
			prefix: "",
			name: "A",
			separator: "=",
			value: "1",
		});
		expect(lines[3]?.assignment).toEqual({
			prefix: "export ",
			name: "B",
			separator: " = ",
			value: "two",
		});
	});

	it("treats a quoted multi-line value as one entry", () => {
		const doc = 'KEY="line1\nline2"\nNEXT=x\n';
		const lines = parseEnvDocument(doc);
		expect(lines).toHaveLength(2);
		expect(lines[0]?.assignment?.value).toBe('"line1\nline2"');
		expect(lines[1]?.assignment?.name).toBe("NEXT");
	});

	it("ignores escaped quotes inside double quotes", () => {
		const lines = parseEnvDocument('K="a\\"\nb"\nZ=1');
		expect(lines).toHaveLength(2);
		expect(lines[0]?.assignment?.value).toBe('"a\\"\nb"');
	});

	it("keeps an unterminated quote on one line", () => {
		const lines = parseEnvDocument('K="open\nZ=1');
		expect(lines).toHaveLength(2);
		expect(lines[0]?.assignment?.value).toBe('"open');
	});

	it("covers the whole document by index and length", () => {
		const doc = 'A=1\r\nB="x\ny"\n#c\nC=3';
		const rebuilt = parseEnvDocument(doc)
			.map((l) => doc.slice(l.index, l.index + l.length) + l.eol)
			.join("");
		expect(rebuilt).toBe(doc);
	});

	it("returns nothing for an empty document", () => {
		expect(parseEnvDocument("")).toEqual([]);
	});
});

describe("unquoteEnvValue", () => {
	it("strips matching quotes and unescapes quotes", () => {
		expect(unquoteEnvValue(' "a\\"b" ')).toBe('a"b');
		expect(unquoteEnvValue("'x'")).toBe("x");
	});

	it("leaves mismatched or unquoted values", () => {
		expect(unquoteEnvValue(" plain ")).toBe("plain");
		expect(unquoteEnvValue("\"a'")).toBe("\"a'");
	});
});
