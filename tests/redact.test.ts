import { describe, expect, it } from "vitest";
import {
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
