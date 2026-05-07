import { describe, expect, it } from "vitest";
import {
	filterLogString,
	limitLogString,
	maskSecret,
	redactString,
	sanitizeForAgent,
} from "../src/redact.js";

describe("agent redaction", () => {
	it("masks secret object keys", () => {
		const output = sanitizeForAgent({
			apiKey: "abcd123456",
			nested: { password: "secret-value" },
		});

		expect(output).toEqual({
			apiKey: "abcd***",
			nested: { password: "secr***" },
		});
	});

	it("keeps very short secret values unchanged", () => {
		expect(maskSecret("abc")).toBe("abc");
	});

	it("redacts secret-like log text", () => {
		const output = redactString(
			"DOKPLOY_API_KEY=abcd1234 Authorization: Bearer eyJabcdef.eyJpayload.sig",
		);

		expect(output).toContain("DOKPLOY_API_KEY=abcd***");
		expect(output).toContain("Bearer eyJa***");
		expect(output).not.toContain("abcd1234");
	});

	it("limits log output to the tail", () => {
		const output = limitLogString("one\ntwo\nthree", 2, 100);

		expect(output).toBe(
			"[truncated to last 2 lines, omitted 1 lines]\ntwo\nthree",
		);
	});

	it("filters log output locally", () => {
		const output = filterLogString(
			"boot\nerror one\nok\nerror two",
			"error",
			0,
		);

		expect(output).toBe(
			"error one\n[omitted non-matching log lines]\nerror two",
		);
	});

	it("filters log output with context", () => {
		const output = filterLogString(
			"boot\npre\nerror one\npost\nok",
			"error",
			1,
		);

		expect(output).toBe("pre\nerror one\npost");
	});

	it("redacts and filters log fields before limiting", () => {
		const output = sanitizeForAgent(
			{ logs: "one\ntwo\nPASSWORD=long-secret-value\nthree" },
			{
				logOutput: true,
				logSearch: "password",
				maxLogLines: 500,
				maxLogChars: 1000,
			},
		);

		expect(output).toEqual({
			logs: "PASSWORD=long***",
		});
	});

	it("redacts and limits log fields", () => {
		const output = sanitizeForAgent(
			{ logs: "one\ntwo\nPASSWORD=long-secret-value" },
			{ logOutput: true, maxLogLines: 2, maxLogChars: 1000 },
		);

		expect(output).toEqual({
			logs: "[truncated to last 2 lines, omitted 1 lines]\ntwo\nPASSWORD=long***",
		});
	});
});
