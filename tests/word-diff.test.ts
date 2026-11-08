import { describe, expect, it } from "vitest";
import { wordDiff } from "../src/agent/word-diff.js";

const marked = (text: string, spans: [number, number][]) =>
	spans.map(([start, end]) => text.slice(start, end));

describe("wordDiff", () => {
	it("marks changed words and punctuation only", () => {
		const before = "URL host omnisink.srv.example.com";
		const after = "URL host omnisink-srv.example.net";
		const diff = wordDiff(before, after);
		expect(marked(before, diff?.before ?? [])).toEqual([".", "com"]);
		expect(marked(after, diff?.after ?? [])).toEqual(["-", "net"]);
	});

	it("merges adjacent changed tokens into one span", () => {
		const diff = wordDiff("KEY=ab***", 'KEY="new value"');
		expect(diff?.before).toEqual([[4, 9]]);
		expect(marked('KEY="new value"', diff?.after ?? [])).toEqual([
			'"new value"',
		]);
	});

	it("skips lines that share no visible token", () => {
		expect(wordDiff("alpha beta", "gamma delta")).toBeUndefined();
		expect(wordDiff("same", "same")).toEqual({ before: [], after: [] });
	});

	it("counts offsets in UTF-16 units", () => {
		const diff = wordDiff("x 😀 a", "x 😀 b");
		expect(diff?.before).toEqual([[5, 6]]);
	});
});
