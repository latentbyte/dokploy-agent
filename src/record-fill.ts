import { CliError } from "./agent/errors.js";
import { apiGet } from "./client.js";

export interface RecordLookup {
	endpoint: string;
	idKey: string;
	fillKeys: readonly string[];
}

// update endpoints whose spec requires the full field set (often nullable) get
// omitted fields from the current record, so callers pass only what changes
export async function fillFromCurrentRecord(
	lookup: RecordLookup,
	opts: Record<string, any>,
): Promise<Record<string, any>> {
	const missing = lookup.fillKeys.filter((key) => opts[key] === undefined);
	if (missing.length === 0) return opts;

	const record = await apiGet(lookup.endpoint, {
		[lookup.idKey]: opts[lookup.idKey],
	});
	const unresolved: string[] = [];
	for (const key of missing) {
		if (record && typeof record === "object" && key in record) {
			opts[key] = record[key];
		} else {
			unresolved.push(key);
		}
	}
	if (unresolved.length > 0) {
		throw new CliError(
			"MISSING_OPTION",
			`missing required option(s) ${unresolved.map((key) => `--${key}`).join(", ")}; ${lookup.endpoint} has no current value to keep`,
		);
	}
	return opts;
}
