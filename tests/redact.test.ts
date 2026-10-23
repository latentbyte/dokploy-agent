import { describe, expect, it } from "vitest";
import {
	filterLogString,
	isPublicIdentifierKey,
	isSensitiveEnvKey,
	isSensitiveKey,
	limitLogString,
	maskSecret,
	redactEnvDocument,
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
			apiKey: "*** (10 chars)",
			nested: { password: "secr*** (12 chars)" },
		});
	});

	it("keeps public resource IDs visible", () => {
		const output = sanitizeForAgent({
			id: "app-row-id",
			applicationId: "app-123456",
			githubId: "github-123456",
			gitProvider: { gitProviderId: "provider-123456" },
			serverId: "server-123456",
			organizationId: "org-123456",
		});

		expect(output).toEqual({
			id: "app-row-id",
			applicationId: "app-123456",
			githubId: "github-123456",
			gitProvider: { gitProviderId: "provider-123456" },
			serverId: "server-123456",
			organizationId: "org-123456",
		});
	});

	it("keeps spec-derived resource IDs visible but masks credential IDs", () => {
		const output = sanitizeForAgent({
			dnsProviderId: "dns-123456",
			vaultProviderId: "vault-123456",
			config: { accessKeyId: "AKIA-ish-id", clientId: "client-123456" },
		});

		expect(output).toEqual({
			dnsProviderId: "dns-123456",
			vaultProviderId: "vault-123456",
			config: {
				accessKeyId: "*** (11 chars)",
				clientId: "clie*** (13 chars)",
			},
		});
	});

	it("reveals at most a third of a masked value", () => {
		expect(maskSecret("abc")).toBe("*** (3 chars)");
		expect(maskSecret("abcdefghijk")).toBe("*** (11 chars)");
		expect(maskSecret("abcdefghijkl")).toBe("abcd*** (12 chars)");
		expect(maskSecret("abcdefghijklmnopqrstuvw")).toBe("abcd*** (23 chars)");
		expect(maskSecret("abcdefghijklmnopqrstuvwx")).toBe(
			"abcd***uvwx (24 chars)",
		);
	});

	it("masks every value and comment in environment documents", () => {
		const input = [
			"# internal hostname follows",
			"FOO=valuable-secret",
			"export PORT=3000",
			'EMPTY=""',
		].join("\n");

		expect(redactEnvDocument(input)).toBe(
			[
				"# [comment hidden]",
				"FOO=valu*** (15 chars)",
				"export PORT=*** (4 chars)",
				"EMPTY=*** (0 chars)",
			].join("\n"),
		);
		expect(sanitizeForAgent({ env: input })).toEqual({
			env: [
				"# [comment hidden]",
				"FOO=valu*** (15 chars)",
				"export PORT=*** (4 chars)",
				"EMPTY=*** (0 chars)",
			].join("\n"),
		});
	});

	it("masks multi-line env values and hides stray lines", () => {
		const input = [
			'DEPLOY_KEY="-----BEGIN OPENSSH PRIVATE KEY-----',
			"b3BlbnNzaC1rZXk",
			'-----END OPENSSH PRIVATE KEY-----"',
			"PORT=3000",
			"",
			"orphan-secret-line",
		].join("\r\n");

		const output = redactEnvDocument(input);
		expect(output).toBe(
			[
				"DEPLOY_KEY=----***---- (87 chars)",
				"PORT=*** (4 chars)",
				"",
				"[line hidden]",
			].join("\r\n"),
		);
		expect(output).not.toContain("b3BlbnNzaC1rZXk");
	});

	it("detects sensitive env key parts", () => {
		expect(isSensitiveKey("POSTGRES_PASSWORD")).toBe(true);
		expect(isSensitiveKey("apiUrl")).toBe(true);
		expect(isSensitiveKey("databaseUrl")).toBe(true);
		expect(isSensitiveKey("serverId")).toBe(true);
		expect(isPublicIdentifierKey("serverId")).toBe(true);
		expect(isPublicIdentifierKey("applicationId")).toBe(true);
		expect(isPublicIdentifierKey("githubId")).toBe(true);
		expect(isPublicIdentifierKey("gitProviderId")).toBe(true);
		expect(isPublicIdentifierKey("buildServerId")).toBe(true);
		expect(isPublicIdentifierKey("registryId")).toBe(true);
		expect(isPublicIdentifierKey("buildRegistryId")).toBe(true);
		expect(isPublicIdentifierKey("rollbackRegistryId")).toBe(true);
		expect(isPublicIdentifierKey("organizationId")).toBe(true);
		expect(isPublicIdentifierKey("dnsProviderId")).toBe(true);
		expect(isPublicIdentifierKey("vaultProviderId")).toBe(true);
		expect(isPublicIdentifierKey("networkId")).toBe(true);
		expect(isPublicIdentifierKey("accessKeyId")).toBe(false);
		expect(isPublicIdentifierKey("clientId")).toBe(false);
		expect(isSensitiveKey("dbPwd")).toBe(true);
		expect(isSensitiveKey("valid")).toBe(false);
		expect(isSensitiveEnvKey("POSTGRESPASSWORD")).toBe(true);
		expect(isSensitiveEnvKey("ORGANIZATIONID")).toBe(true);
		expect(isSensitiveEnvKey("VALID")).toBe(false);
	});

	it("redacts env-like assignments by sensitive key", () => {
		const output = redactString(
			[
				"POSTGRES_PASSWORD=postgres-secret",
				"POSTGRESPASSWORD=postgres-secret-two",
				"API_URL=https://example.com/token",
				"ORGANIZATIONID: org-123456",
				"SERVER_ID: srv-123456",
				"DB_PWD=pwd-secret",
				"VALID=true",
				"SAFE_HOST=example.com",
			].join("\n"),
		);

		expect(output).toContain("POSTGRES_PASSWORD=post*** (15 chars)");
		expect(output).toContain("POSTGRESPASSWORD=post*** (19 chars)");
		expect(output).toContain("API_URL=http***oken (25 chars)");
		expect(output).toContain("ORGANIZATIONID: *** (10 chars)");
		expect(output).toContain("SERVER_ID: *** (10 chars)");
		expect(output).toContain("DB_PWD=*** (10 chars)");
		expect(output).toContain("VALID=true");
		expect(output).toContain("SAFE_HOST=example.com");
		expect(output).not.toContain("postgres-secret");
		expect(output).not.toContain("srv-123456");
		expect(output).not.toContain("pwd-secret");
	});

	it("redacts quoted assignments with spaces and escaped quotes", () => {
		const output = redactString(
			['TOKEN="secret value"', "PASS='token value'", "NOTE=not secret"].join(
				"\n",
			),
		);
		expect(output).toContain("TOKEN=secr*** (12 chars)");
		expect(output).toContain("PASS=*** (11 chars)");
		expect(output).not.toContain("secret value");
		expect(output).not.toContain("token value");
		const escaped = redactString('TOKEN="abc\\"def"\n');
		expect(escaped).toContain("TOKEN=*** (7 chars)");
	});

	it("redacts numeric secrets from nested objects and arrays", () => {
		const output = sanitizeForAgent({
			deployment: {
				password: 123456,
				token: "abc",
			},
			services: [{ apiToken: 654321 }, "TOKEN=shouldhide"],
		});

		expect(output).toEqual({
			deployment: {
				password: "*** (6 chars)",
				token: "*** (3 chars)",
			},
			services: [{ apiToken: "*** (6 chars)" }, "TOKEN=*** (10 chars)"],
		});
	});

	it("redacts secret-like log text", () => {
		const output = redactString(
			"DOKPLOY_API_KEY=abcd1234 Authorization: Bearer eyJabcdef.eyJpayload.sig",
		);

		expect(output).toContain("DOKPLOY_API_KEY=*** (8 chars)");
		expect(output).toContain("Bearer eyJa***.sig (24 chars)");
		expect(output).not.toContain("abcd1234");
	});

	it("hides private key blocks", () => {
		const output = redactString(
			"deploy key\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA\n-----END OPENSSH PRIVATE KEY-----\ndone",
		);

		expect(output).toBe(
			"deploy key\n-----BEGIN OPENSSH PRIVATE KEY-----\n[private key hidden]\n-----END OPENSSH PRIVATE KEY-----\ndone",
		);
	});

	it("redacts JSON text and NUL-separated environments", () => {
		const json = redactString(
			'{"db_password": "hunter2hunter2", "config":{"apiToken":"cf-token-value"}, "name": "web"}',
		);
		expect(json).toContain('"db_password": hunt*** (14 chars)');
		expect(json).toContain('"apiToken":cf-t*** (14 chars)');
		expect(json).toContain('"name": "web"');
		expect(json).not.toContain("hunter2hunter2");
		expect(json).not.toContain("cf-token-value");

		const environ = redactString(
			"PATH=/bin\0POSTGRES_PASSWORD=hunter2hunter2\0HOME=/root",
		);
		expect(environ).toBe(
			"PATH=/bin\0POSTGRES_PASSWORD=hunt*** (14 chars)\0HOME=/root",
		);
	});

	it("redacts assignments nested in quoted values of benign keys", () => {
		const output = redactString(
			[
				'{"level":"info","msg":"starting with API_KEY=abc123def456 now"}',
				'{"args":"--password=hunter2secret"}',
				'NOTE="run with TOKEN=abcdef123456"',
				"password:\n  hunter2secret",
			].join("\n"),
		);

		expect(output).toContain(
			'"msg":"starting with API_KEY=abc1*** (12 chars) now"',
		);
		expect(output).toContain('"args":"--password=hunt*** (13 chars)"');
		expect(output).toContain('NOTE="run with TOKEN=abcd*** (12 chars)"');
		expect(output).not.toContain("abc123def456");
		expect(output).not.toContain("hunter2secret");
		expect(output).not.toContain("abcdef123456");
	});

	it("masks well-known token formats without a key name", () => {
		const tokens = [
			"sk-proj-abcdefghijklmnopqrstuvwxyz",
			"sk_live_abcdefghijklmnop",
			"ghp_abcdefghijklmnopqrstuvwxyz0123",
			"AKIAIOSFODNN7EXAMPLE",
			"xoxb-1234567890-abcdefghij",
		];
		const output = redactString(`values: ${tokens.join(" ")}`);

		for (const token of tokens) {
			expect(output).not.toContain(token);
			expect(output).toContain(maskSecret(token));
		}
		expect(redactString("sk-learn and ghp_short stay")).toBe(
			"sk-learn and ghp_short stay",
		);
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
			logs: "PASSWORD=long*** (17 chars)",
		});
	});

	it("redacts and limits log fields", () => {
		const output = sanitizeForAgent(
			{ logs: "one\ntwo\nPASSWORD=long-secret-value" },
			{ logOutput: true, maxLogLines: 2, maxLogChars: 1000 },
		);

		expect(output).toEqual({
			logs: "[truncated to last 2 lines, omitted 1 lines]\ntwo\nPASSWORD=long*** (17 chars)",
		});
	});
});
