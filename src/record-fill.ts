import { CliError } from "./agent/errors.js";
import { apiGet } from "./client.js";

export interface RecordField {
	name: string;
	/** spec accepts null, so a null current value is kept */
	nullable?: boolean;
	/** optional with a spec default; kept so the default cannot reset it */
	optional?: boolean;
}

export interface RecordLookup {
	endpoint: string;
	idKey: string;
	fields: readonly RecordField[];
}

// update endpoints whose spec requires the full field set (often nullable) get
// omitted fields from the current record, so callers pass only what changes
export async function fillFromCurrentRecord(
	lookup: RecordLookup,
	opts: Record<string, any>,
): Promise<Record<string, any>> {
	const missing = lookup.fields.filter(
		(field) => opts[field.name] === undefined,
	);
	if (missing.length === 0) return opts;

	const record = await apiGet(lookup.endpoint, {
		[lookup.idKey]: opts[lookup.idKey],
	});
	const unresolved: string[] = [];
	for (const field of missing) {
		const value =
			record && typeof record === "object" ? record[field.name] : undefined;
		if (value !== undefined && (value !== null || field.nullable)) {
			opts[field.name] = value;
		} else if (!field.optional) {
			unresolved.push(field.name);
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
