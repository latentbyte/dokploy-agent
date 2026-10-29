import { beforeEach, describe, expect, it, vi } from "vitest";

const apiGet = vi.fn();
vi.mock("../src/client.js", () => ({
	apiGet: (...args: unknown[]) => apiGet(...args),
}));

import { fillFromCurrentRecord } from "../src/record-fill.js";

const lookup = {
	endpoint: "application.one",
	idKey: "applicationId",
	fields: [
		{ name: "buildType" },
		{ name: "dockerfile", nullable: true },
		{ name: "publishDirectory", optional: true },
	],
} as const;

describe("fillFromCurrentRecord", () => {
	beforeEach(() => apiGet.mockReset());

	it("skips the lookup when every field is passed", async () => {
		const opts = {
			applicationId: "a1",
			buildType: "nixpacks",
			dockerfile: null,
			publishDirectory: "dist",
		};
		expect(await fillFromCurrentRecord(lookup, opts)).toBe(opts);
		expect(apiGet).not.toHaveBeenCalled();
	});

	it("fills omitted fields from the record and keeps passed ones", async () => {
		apiGet.mockResolvedValue({
			buildType: "dockerfile",
			dockerfile: "Dockerfile",
			publishDirectory: "out",
		});
		const result = await fillFromCurrentRecord(lookup, {
			applicationId: "a1",
			buildType: "static",
		});
		expect(apiGet).toHaveBeenCalledWith("application.one", {
			applicationId: "a1",
		});
		expect(result).toMatchObject({
			buildType: "static",
			dockerfile: "Dockerfile",
			publishDirectory: "out",
		});
	});

	it("keeps null only for nullable fields", async () => {
		apiGet.mockResolvedValue({ buildType: null, dockerfile: null });
		await expect(
			fillFromCurrentRecord(lookup, { applicationId: "a1" }),
		).rejects.toMatchObject({
			code: "MISSING_OPTION",
			message: expect.stringContaining("--buildType"),
		});

		apiGet.mockResolvedValue({ buildType: "static", dockerfile: null });
		const result = await fillFromCurrentRecord(lookup, {
			applicationId: "a1",
		});
		expect(result.dockerfile).toBeNull();
		expect("publishDirectory" in result).toBe(false);
	});

	it("reports every unresolved required field when the record is missing", async () => {
		apiGet.mockResolvedValue(undefined);
		await expect(
			fillFromCurrentRecord(lookup, { applicationId: "a1" }),
		).rejects.toThrow(/--buildType, --dockerfile/);
	});
});
