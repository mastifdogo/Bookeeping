import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectStatus, multipartBody, sessionFrom, setupTestApp, type TestApp } from "./harness.ts";
import { insertJournalEntry, lockAccounts } from "../src/ledger.ts";
import { GENERAL_LEDGER_HEADER, MAX_FILE_BYTES } from "../src/files.ts";
import { readCsv } from "../src/csv.ts";
import { createUser, setUserActive, SESSION_COOKIE } from "../src/auth.ts";
import { LOGIN_MAX_FAILURES, LOGIN_MAX_FAILURES_PER_USER, LoginLimiter } from "../src/limiter.ts";
import { ModuleHost } from "../src/module-host.ts";
import { fakeGitHub } from "./fake-github.ts";
import { today } from "../src/date.ts";
import { postItem } from "../src/dashboard.ts";
import { readBackupStatus, runBackup } from "../src/backup.ts";
import { fakeGoogle } from "./fake-google.ts";
import { fakeAi, fakeGmail } from "./fake-services.ts";

type Line = { account_code: string; debit_cents: number; credit_cents: number; memo?: string };
const dr = (code: string, cents: number): Line => ({ account_code: code, debit_cents: cents, credit_cents: 0 });
const cr = (code: string, cents: number): Line => ({ account_code: code, debit_cents: 0, credit_cents: cents });
const entry = (date: string, description: string, ...lines: Line[]) => ({ entry_date: date, description, lines });

async function createAccount(ta: TestApp, code: string, name: string, type: string, currency: string): Promise<void> {
	expectStatus(await ta.call("POST", "/accounts", { code, name, type, currency }), 201);
}

const readRecords = (text: string) => [...readCsv(text)].map((r) => r.fields);

test("ledger end to end", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call, countRows } = ta;

	await createAccount(ta, "1000", "Bank CAD", "asset", "CAD");
	await createAccount(ta, "1010", "Bank USD", "asset", "USD");
	await createAccount(ta, "1900", "FX clearing CAD", "asset", "CAD");
	await createAccount(ta, "1910", "FX clearing USD", "asset", "USD");
	await createAccount(ta, "4000", "Sales", "revenue", "CAD");
	await createAccount(ta, "6100", "=Supplies", "expense", "CAD"); // formula-looking name
	await createAccount(ta, "9000", "Old account", "expense", "CAD");

	expectStatus(await call("POST", "/accounts", { code: "1000", name: "Dup", type: "asset", currency: "CAD" }), 409);
	expectStatus(await call("POST", "/accounts", { code: "2000", name: "Euro", type: "asset", currency: "EUR" }), 422);
	expectStatus(await call("PATCH", "/accounts/9000", { is_active: false }), 200);
	expectStatus(await call("PATCH", "/accounts/9000", { code: "9001" }), 400);
	expectStatus(await call("GET", "/accounts/nope"), 404);

	let r = await call("GET", "/currencies");
	expectStatus(r, 200);
	assert.ok(r.text.includes('"CAD"') && r.text.includes('"USD"'), r.text);

	// --- Balanced entries post successfully -------------------------------
	r = await call("POST", "/journal-entries", entry("2026-09-15", "Cash sale", dr("1000", 150000), { ...cr("4000", 150000), memo: "Invoice 1 — café ☕" }));
	expectStatus(r, 201);
	const sale = r.json();
	assert.deepEqual(sale.totals, [{ currency: "CAD", amount_cents: 150000 }]);
	assert.equal(sale.lines.length, 2);
	assert.equal(sale.lines[1].credit_cents, 150000);
	assert.equal(sale.lines[1].account_code, "4000");
	assert.equal(sale.lines[1].currency, "CAD");

	r = await call("POST", "/journal-entries", entry("2026-10-02", "Supplies", { ...dr("6100", 4599), memo: "+paper" }, cr("1000", 4599)));
	expectStatus(r, 201);
	const purchase = r.json();

	// Convert CAD 1,370.00 to USD 1,000.00 through the FX clearing accounts.
	r = await call("POST", "/journal-entries", entry("2026-10-03", "Buy USD", dr("1900", 137000), cr("1000", 137000), dr("1010", 100000), cr("1910", 100000)));
	expectStatus(r, 201);
	assert.deepEqual(r.json().totals, [
		{ currency: "CAD", amount_cents: 137000 },
		{ currency: "USD", amount_cents: 100000 },
	]);

	const entriesBefore = await countRows("journal_entries");
	const linesBefore = await countRows("transactions");

	// --- Rejected entries leave no trace ----------------------------------
	const rejected: [string, unknown, number][] = [
		["unbalanced", entry("2026-10-03", "Bad", dr("1000", 100), cr("4000", 99)), 422],
		["balanced overall but not per currency", entry("2026-10-03", "Bad", dr("1000", 100), cr("1010", 100)), 422],
		["single line", entry("2026-10-03", "Bad", dr("1000", 100)), 422],
		["inactive account", entry("2026-10-03", "Bad", dr("9000", 100), cr("1000", 100)), 422],
		["unknown account", entry("2026-10-03", "Bad", dr("7777", 100), cr("1000", 100)), 422],
		[
			"account id instead of code",
			{ entry_date: "2026-10-03", description: "Bad", lines: [{ account_id: 1, debit_cents: 1, credit_cents: 0 }, { account_id: 2, debit_cents: 0, credit_cents: 1 }] },
			400,
		],
		[
			"float amount",
			{ entry_date: "2026-10-03", description: "Bad", lines: [{ account_code: "1000", debit_cents: 1.5, credit_cents: 0 }, { account_code: "4000", debit_cents: 0, credit_cents: 1.5 }] },
			400,
		],
		["unknown field", { entry_date: "2026-10-03", description: "Bad", status: "draft", lines: [dr("1000", 1), cr("4000", 1)] }, 400],
	];
	for (const [name, body, want] of rejected) {
		await t.test("reject " + name, async () => expectStatus(await call("POST", "/journal-entries", body), want));
	}
	assert.equal(await countRows("journal_entries"), entriesBefore, "rejected entries changed the ledger");
	assert.equal(await countRows("transactions"), linesBefore, "rejected entries changed the ledger");

	// Resolve accounts for the direct-insert tests below (bypassing the API).
	const accounts = await lockAccounts(app.db, ["1000", "1010", "4000"]);

	// --- Atomicity: a failing line rolls back the header ------------------
	await t.test("rollback on failing line", async () => {
		const tx = await app.db.connect();
		try {
			await tx.query("BEGIN");
			const bad = new Map([
				["1000", accounts.get("1000")!],
				["ghost", { id: 424242n, currency: "CAD" as const, active: true }],
			]);
			await assert.rejects(
				insertJournalEntry(tx, { entry_date: "2026-10-04", description: "Partial", reference: "", lines: [{ account_code: "1000", debit_cents: 5n, credit_cents: 0n, memo: "" }, { account_code: "ghost", debit_cents: 0n, credit_cents: 5n, memo: "" }] }, bad, null, null, null),
			);
			await tx.query("ROLLBACK");
		} finally {
			tx.release();
		}
		assert.equal(await countRows("journal_entries"), entriesBefore, "header survived a failed line");
	});

	// --- Database rejects unbalanced commits even without the app checks ---
	const sneaky: Record<string, [string, bigint][]> = {
		unbalanced: [["1000", 1000n], ["4000", -1n]],
		"cross-currency mix": [["1000", 1000n], ["1010", -1000n]],
	};
	for (const [name, lines] of Object.entries(sneaky)) {
		await t.test("db rejects " + name, async () => {
			const tx = await app.db.connect();
			try {
				await tx.query("BEGIN");
				await insertJournalEntry(
					tx,
					{
						entry_date: "2026-10-04",
						description: "Sneaky",
						reference: "",
						lines: lines.map(([code, amt]) => ({ account_code: code, debit_cents: amt > 0n ? amt : 0n, credit_cents: amt < 0n ? -amt : 0n, memo: "" })),
					},
					accounts,
					null,
					null,
					null,
				);
				await assert.rejects(tx.query("COMMIT"), /unbalanced/);
			} finally {
				tx.release();
			}
			assert.equal(await countRows("journal_entries"), entriesBefore, "unbalanced entry was committed");
		});
	}

	// --- Immutability ------------------------------------------------------
	await t.test("posted rows are immutable", async () => {
		for (const stmt of [
			"UPDATE transactions SET amount = amount * 2",
			"DELETE FROM transactions",
			"UPDATE journal_entries SET description = 'changed'",
			"DELETE FROM journal_entries",
			"TRUNCATE transactions CASCADE",
			"UPDATE accounts SET code = 'X1000' WHERE code = '1000'",
			"UPDATE accounts SET currency = 'USD' WHERE code = '1000'",
		]) {
			await assert.rejects(app.db.query(stmt), Error, stmt);
		}
		// Appending balanced lines to an already-posted entry is also refused.
		await assert.rejects(
			app.db.query(
				`INSERT INTO transactions (journal_entry_id, account_id, currency, line_number, amount)
				 VALUES ($1, $2, 'CAD', 10, 1), ($1, $3, 'CAD', 11, -1)`,
				[sale.id, accounts.get("1000")!.id, accounts.get("4000")!.id],
			),
			/already posted/,
		);
	});

	// --- Reversal ----------------------------------------------------------
	r = await call("POST", `/journal-entries/${purchase.id}/reverse`, { entry_date: "2026-10-05" });
	expectStatus(r, 201);
	const rev = r.json();
	assert.equal(rev.reverses_id, purchase.id);
	assert.equal(rev.lines[0].credit_cents, 4599);
	assert.equal(rev.lines[1].debit_cents, 4599);
	expectStatus(await call("POST", `/journal-entries/${purchase.id}/reverse`), 409);
	expectStatus(await call("POST", `/journal-entries/${rev.id}/reverse`), 409);

	r = await call("GET", `/journal-entries/${purchase.id}`);
	expectStatus(r, 200);
	assert.equal(r.json().reversed_by_id, rev.id);

	// --- Reports -----------------------------------------------------------
	r = await call("GET", "/reports/trial-balance?as_of=2026-12-31");
	expectStatus(r, 200);
	assert.deepEqual(r.json().totals, [
		{ currency: "CAD", debit_cents: 150000, credit_cents: 150000 },
		{ currency: "USD", debit_cents: 100000, credit_cents: 100000 },
	]);
	r = await call("GET", "/reports/trial-balance?as_of=2026-12-31&currency=usd");
	expectStatus(r, 200);
	let tb = r.json();
	assert.equal(tb.rows.length, 2);
	assert.equal(tb.totals.length, 1);
	assert.equal(tb.totals[0].currency, "USD");

	r = await call("GET", "/accounts/1000/ledger?from=2026-10-01");
	expectStatus(r, 200);
	const led = r.json();
	assert.equal(led.account.currency, "CAD");
	assert.equal(led.opening_balance_cents, 150000);
	assert.equal(led.lines.length, 3);
	assert.equal(led.lines[0].running_balance_cents, 150000 - 4599);
	assert.equal(led.closing_balance_cents, 150000 - 137000);

	r = await call("GET", "/journal-entries?limit=2&account_code=1000");
	expectStatus(r, 200);
	const page = r.json();
	assert.equal(page.data.length, 2);
	assert.equal(page.data[0].id, rev.id);

	// --- General Ledger CSV export ----------------------------------------
	r = await call("POST", "/exports/general-ledger");
	expectStatus(r, 201);
	const exp = r.json();
	const raw = await readFile(path.join(app.csvDir, exp.filename));
	assert.ok(raw[0] !== 0xef, "export must be UTF-8 without BOM");
	const text = raw.toString("utf8");
	const records = readRecords(text);
	assert.deepEqual(records[0], GENERAL_LEDGER_HEADER);
	assert.equal(exp.row_count, 10);
	assert.equal(records.length, 11);
	// Account 1000 rows come first: +1500.00, -45.99, -1370.00, +45.99.
	const wantRunning = ["1500.00", "1454.01", "84.01", "130.00"];
	for (const [i, rec] of records.slice(1, 5).entries()) {
		assert.equal(rec[0], "1000");
		assert.equal(rec[3], "CAD");
		assert.equal(rec[13], wantRunning[i]);
	}
	assert.ok(text.includes("Invoice 1 — café ☕"), "UTF-8 memo not preserved");
	assert.ok(text.includes("'=Supplies") && text.includes("'+paper"), "formula-looking text was not neutralised");

	// Date-filtered export emits opening balances; currency filter applies.
	r = await call("POST", "/exports/general-ledger", { from: "2026-10-01", currency: "CAD" });
	expectStatus(r, 201);
	const exp2 = r.json();
	const text2 = await readFile(path.join(app.csvDir, exp2.filename), "utf8");
	const recs2 = readRecords(text2);
	assert.equal(recs2[1]![9], "Opening balance");
	assert.equal(recs2[1]![13], "1500.00");
	assert.equal(recs2[1]![11], "");
	assert.ok(!text2.includes(",USD,"), "CAD-only export contains USD rows");
	expectStatus(await call("POST", "/exports/general-ledger", { currency: "EUR" }), 422);
	expectStatus(await call("POST", "/exports/general-ledger", { from: "2026-10-02", to: "2026-10-01" }), 422);

	assert.deepEqual((await readdir(app.csvDir)).filter((f) => f.endsWith(".tmp")), [], "temp files left behind");

	// --- File listing and download ----------------------------------------
	r = await call("GET", "/files");
	expectStatus(r, 200);
	assert.equal(r.json().data.length, 2);
	r = await call("GET", "/files/" + exp.filename);
	expectStatus(r, 200);
	assert.ok(r.body.equals(raw), "downloaded file differs from export");
	assert.equal(r.headers["content-type"], "text/csv; charset=utf-8");
	assert.equal(r.headers["content-disposition"], `attachment; filename="${exp.filename}"`);
	for (const bad of ["..%2Fetc%2Fpasswd", "missing.csv", ".hidden.csv", "x.txt"]) {
		expectStatus(await call("GET", "/files/" + bad), 404);
	}
});

test("import journal entries", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call, countRows } = ta;

	await createAccount(ta, "1000", "Bank CAD", "asset", "CAD");
	await createAccount(ta, "1010", "Bank USD", "asset", "USD");
	await createAccount(ta, "1900", "FX clearing CAD", "asset", "CAD");
	await createAccount(ta, "1910", "FX clearing USD", "asset", "USD");
	await createAccount(ta, "4000", "Sales", "revenue", "CAD");

	const write = (name: string, content: string) => writeFile(path.join(app.csvDir, name), content, { mode: 0o600 });
	const importFile = (name: string) => call("POST", "/imports/journal-entries", { filename: name });

	const header = "entry_key,entry_date,description,reference,account_code,debit,credit,memo,currency\n";
	await write(
		"good.csv",
		header +
			"S1,2026-10-01,Sale,INV-1,1000,250.00,,,CAD\n" +
			"S1,,,,4000,,250.00,Widgets,\n" +
			"FX1,2026-10-02,Buy USD,,1900,137.00,,,\n" +
			"FX1,2026-10-02,Buy USD,,1000,,137.00,,\n" +
			"FX1,2026-10-02,Buy USD,,1010,100.00,,,USD\n" +
			"FX1,2026-10-02,Buy USD,,1910,,100.00,,USD\n",
	);

	let r = await importFile("good.csv");
	expectStatus(r, 201);
	const res = r.json();
	assert.equal(res.entries_imported, 2);
	assert.equal(res.lines_imported, 6);
	assert.equal(res.sha256.length, 64);
	const linked = await app.db.query(`SELECT min(import_id) AS id FROM journal_entries`);
	assert.equal(Number(linked.rows[0].id), res.import_id, "entries not linked to import");

	// Same content under another name is refused.
	await write("copy.csv", await readFile(path.join(app.csvDir, "good.csv"), "utf8"));
	r = await importFile("copy.csv");
	expectStatus(r, 409);
	assert.ok(r.text.includes("already imported"), r.text);

	const entries = await countRows("journal_entries");
	const lines = await countRows("transactions");

	// A file with one bad entry imports nothing.
	const cases: Record<string, string> = {
		"one bad entry": header + "A,2026-10-05,Good,,1000,1.00,,,\nA,,,,4000,,1.00,,\n" + "B,2026-10-05,Bad,,1000,1.00,,,\nB,,,,4000,,0.99,,\n",
		"unknown account": header + "A,2026-10-05,x,,1000,1.00,,,\nA,,,,7777,,1.00,,\n",
		"per-currency": header + "A,2026-10-05,x,,1000,1.00,,,\nA,,,,1010,,1.00,,\n",
		"currency mismatch": header + "A,2026-10-05,x,,1000,1.00,,,USD\nA,,,,4000,,1.00,,\n",
	};
	for (const [name, content] of Object.entries(cases)) {
		await t.test(name, async () => {
			const fn = name.replaceAll(" ", "_") + ".csv";
			await write(fn, content);
			const r = await importFile(fn);
			expectStatus(r, 422);
			assert.ok(r.text.includes('"row ') || r.text.includes("entry_key"), `errors should point at rows: ${r.text}`);
		});
	}
	assert.equal(await countRows("journal_entries"), entries, "failed imports changed the ledger");
	assert.equal(await countRows("transactions"), lines);
	assert.equal(await countRows("csv_imports"), 1);

	expectStatus(await importFile("missing.csv"), 404);
	expectStatus(await importFile("../etc/passwd"), 422);

	// Round-trip sanity: the imported amounts appear in the trial balance.
	r = await call("GET", "/reports/trial-balance?as_of=2026-12-31");
	expectStatus(r, 200);
	const tb = r.json();
	assert.equal(tb.totals.length, 2);
	assert.equal(tb.totals[0].debit_cents, 25000);
	assert.equal(tb.totals[1].debit_cents, 10000);
});

test("upload and request safety", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call, request } = ta;
	await createAccount(ta, "1000", "Bank CAD", "asset", "CAD");
	await createAccount(ta, "4000", "Sales", "revenue", "CAD");

	const cookie = `${SESSION_COOKIE}=${ta.token}`;
	const upload = (filename: string, content: Buffer, headers: Record<string, string> = {}) => {
		const { body, contentType } = multipartBody(filename, content);
		return request("POST", "/api/v1/files", { rawBody: body, cookie, headers: { "Content-Type": contentType, ...headers } });
	};
	const content = Buffer.from("entry_key,entry_date,description,account_code,debit,credit\nS1,2026-10-01,Sale,1000,5.00,\nS1,,,4000,,5.00\n");

	// Upload, then import the uploaded file.
	let r = await upload("sales.csv", content);
	expectStatus(r, 201);
	const f = r.json();
	assert.equal(f.filename, "sales.csv");
	assert.equal(f.size_bytes, content.length);
	assert.ok((await readFile(path.join(app.csvDir, "sales.csv"))).equals(content), "stored file differs from upload");
	assert.equal((await stat(path.join(app.csvDir, "sales.csv"))).mode & 0o777, 0o640);
	expectStatus(await call("POST", "/imports/journal-entries", { filename: "sales.csv" }), 201);

	// Never overwrite; reject bad names, binary content, empty and huge files.
	expectStatus(await upload("sales.csv", Buffer.from("x")), 409);
	expectStatus(await upload("evil.sh", content), 422);
	expectStatus(await upload(".hidden.csv", content), 422);
	// Path components are stripped: the file lands inside the CSV directory.
	expectStatus(await upload("../../escape.csv", content), 201);
	await stat(path.join(app.csvDir, "escape.csv"));
	expectStatus(await upload("bin.csv", Buffer.from([0xff, 0xfe, 0x00, 0x01])), 422);
	expectStatus(await upload("empty.csv", Buffer.alloc(0)), 422);
	r = await upload("huge.csv", Buffer.alloc(MAX_FILE_BYTES + 1, "a"));
	expectStatus(r, 413);
	assert.ok(r.text.includes("payload_too_large"), r.text);
	await assert.rejects(stat(path.join(path.dirname(app.csvDir), "escape.csv")), Error, "upload escaped the CSV directory");
	assert.deepEqual((await readdir(app.csvDir)).filter((f) => f.endsWith(".tmp")), [], "temp files left behind");
	expectStatus(await request("POST", "/api/v1/files", { rawBody: "x", cookie, headers: { "Content-Type": "text/plain" } }), 400);

	// Cross-site browser requests are refused.
	expectStatus(await upload("csrf.csv", content, { "Sec-Fetch-Site": "cross-site" }), 403);
	expectStatus(await upload("csrf2.csv", content, { Origin: "http://evil.example" }), 403);
	expectStatus(await upload("same.csv", content, { "Sec-Fetch-Site": "same-origin" }), 201);
	const port = new URL(`http://${(await request("GET", "/api/v1/health")).headers.host ?? "x"}`).port; // unused; Host is set by the client
	void port;

	// JSON endpoints require application/json (a text/plain form post is a
	// CORS "simple request" a malicious page could send).
	r = await request("POST", "/api/v1/accounts", {
		rawBody: '{"code":"5000","name":"X","type":"expense","currency":"CAD"}',
		cookie,
		headers: { "Content-Type": "text/plain" },
	});
	expectStatus(r, 415);
	expectStatus(await request("POST", "/api/v1/accounts", { rawBody: "x".repeat((1 << 20) + 1), cookie, headers: { "Content-Type": "application/json" } }), 413);
	expectStatus(await request("POST", "/api/v1/accounts", { rawBody: "", cookie, headers: { "Content-Type": "application/json" } }), 400);
	expectStatus(await request("POST", "/api/v1/accounts", { rawBody: "{} {}", cookie, headers: { "Content-Type": "application/json" } }), 400);

	// Non-API paths serve the frontend (or its placeholder); unknown API paths are JSON 404s.
	for (const [p, want] of [["/", 200], ["/journal/new", 200], ["/api/v2/nope", 404], ["/api/v1/nope", 404], ["/api/v1", 404]] as const) {
		const r = await request("GET", p);
		assert.equal(r.status, want, `GET ${p}`);
		if (p.startsWith("/api/")) assert.ok(r.text.includes('"not_found"'), `GET ${p}: expected JSON error, got ${r.text}`);
		assert.equal(r.headers["x-frame-options"], "SAMEORIGIN", `GET ${p}: missing security headers`);
		assert.equal(r.headers["content-security-policy"], "frame-ancestors 'self'", `GET ${p}: missing security headers`);
	}
	r = await request("DELETE", "/api/v1/accounts", { cookie });
	expectStatus(r, 405);
	r = await request("POST", "/", {});
	expectStatus(r, 405);
});

test("authentication", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, request } = ta;
	const raw = (method: string, p: string, body?: string, cookie?: string) =>
		request(method, "/api/v1" + p, { rawBody: body, cookie, headers: body ? { "Content-Type": "application/json" } : {} });

	// Health is public; everything else needs a session.
	expectStatus(await raw("GET", "/health"), 200);
	for (const p of ["/accounts", "/journal-entries", "/files", "/auth/me", "/reports/balance-sheet"]) {
		const r = await raw("GET", p);
		assert.equal(r.status, 401, `GET ${p} without session`);
		assert.ok(r.text.includes('"unauthorized"'));
	}
	expectStatus(await raw("GET", "/accounts", undefined, `${SESSION_COOKIE}=forged`), 401);

	// Bad credentials, including an unknown user, get the same vague 401.
	for (const body of ['{"username":"tester","password":"wrong password!"}', '{"username":"nobody","password":"whatever12345"}']) {
		const r = await raw("POST", "/auth/login", body);
		assert.equal(r.status, 401);
		assert.ok(r.text.includes("invalid username or password"), r.text);
	}

	// Good login: hardened cookie, and the session works.
	let r = await raw("POST", "/auth/login", '{"username":"  Tester ","password":"correct horse battery"}');
	expectStatus(r, 200);
	const c = sessionFrom(r);
	assert.deepEqual(c.attrs, ["Path=/", "Max-Age=604800", "HttpOnly", "SameSite=Strict"]);
	const cookie = `${SESSION_COOKIE}=${c.value}`;
	r = await raw("GET", "/auth/me", undefined, cookie);
	expectStatus(r, 200);
	assert.ok(r.text.includes('"username":"tester"'), r.text);
	assert.ok(!("id" in r.json()), "user id must not be exposed");
	assert.equal(r.json().organization.name, "Main books");
	assert.equal(r.json().server_admin, true);

	// Secure flag when behind a TLS-terminating proxy.
	r = await request("POST", "/api/v1/auth/login", {
		rawBody: '{"username":"tester","password":"correct horse battery"}',
		headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
	});
	const other = sessionFrom(r);
	assert.ok(other.attrs.includes("Secure"), "expected Secure cookie behind https proxy");
	const otherCookie = `${SESSION_COOKIE}=${other.value}`;

	// Audit trail: entries record who posted them.
	const post = (p: string, body: unknown) => request("POST", "/api/v1" + p, { body, cookie });
	expectStatus(await post("/accounts", { code: "1000", name: "Bank CAD", type: "asset", currency: "CAD" }), 201);
	expectStatus(await post("/accounts", { code: "4000", name: "Sales", type: "revenue", currency: "CAD" }), 201);
	r = await post("/journal-entries", entry("2026-10-01", "Sale", dr("1000", 100), cr("4000", 100)));
	expectStatus(r, 201);
	assert.equal(r.json().created_by, "tester");

	// Password change: validates, keeps this session, ends the others.
	expectStatus(await raw("POST", "/auth/password", '{"current_password":"nope","new_password":"abc"}', cookie), 422);
	expectStatus(await raw("POST", "/auth/password", '{"current_password":"correct horse battery","new_password":"a much better passphrase"}', cookie), 204);
	expectStatus(await raw("GET", "/auth/me", undefined, cookie), 200);
	expectStatus(await raw("GET", "/auth/me", undefined, otherCookie), 401);

	// Logout ends the session server-side and clears the cookie.
	r = await raw("POST", "/auth/logout", undefined, cookie);
	expectStatus(r, 204);
	assert.equal(sessionFrom(r).header, `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
	expectStatus(await raw("GET", "/auth/me", undefined, cookie), 401);

	// Disabled users cannot log in and lose existing sessions.
	r = await raw("POST", "/auth/login", '{"username":"tester","password":"a much better passphrase"}');
	const c2 = `${SESSION_COOKIE}=${sessionFrom(r).value}`;
	await setUserActive(app, "tester", false);
	expectStatus(await raw("GET", "/auth/me", undefined, c2), 401);
	expectStatus(await raw("POST", "/auth/login", '{"username":"tester","password":"a much better passphrase"}'), 401);
	await setUserActive(app, "tester", true);

	// Users can't be deleted (audit trail), and passwords are not stored in clear.
	await assert.rejects(app.db.query(`DELETE FROM users`));
	const hash = (await app.db.query(`SELECT password_hash FROM users WHERE username = 'tester'`)).rows[0].password_hash as string;
	assert.match(hash, /^\$2[aby]\$12\$/);

	// Validation of new users.
	await assert.rejects(createUser(app, "Bad Name!", "long enough password"));
	await assert.rejects(createUser(app, "bob", "123"));
	await createUser(app, "pin", "1234"); // a 4-digit PIN is enough

	// Rate limiting: after repeated failures even the right password is refused.
	for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
		await raw("POST", "/auth/login", '{"username":"tester","password":"wrong wrong wrong"}');
	}
	expectStatus(await raw("POST", "/auth/login", '{"username":"tester","password":"a much better passphrase"}'), 429);

	// The per-username limit also holds when attempts come from many
	// addresses (simulated by clearing the per-address limiter).
	for (let i = LOGIN_MAX_FAILURES; i < LOGIN_MAX_FAILURES_PER_USER; i += LOGIN_MAX_FAILURES) {
		app.logins = new LoginLimiter();
		for (let j = 0; j < LOGIN_MAX_FAILURES; j++) {
			await raw("POST", "/auth/login", '{"username":"tester","password":"wrong wrong wrong"}');
		}
	}
	app.logins = new LoginLimiter();
	expectStatus(await raw("POST", "/auth/login", '{"username":"tester","password":"a much better passphrase"}'), 429);

	// A 4-digit PIN logs in (another user, so the limits above don't apply).
	expectStatus(await raw("POST", "/auth/login", '{"username":"pin","password":"1234"}'), 200);
});

test("hashes from the Go version keep working", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	// Written by golang.org/x/crypto/bcrypt (cost 12) for "correct horse battery".
	const goHash = "$2a$12$4nK2BHvfnf.Q0CwnKdjcPeBANQpCHG9oS0wNubF4F7BDtS2O9s/VG";
	await ta.app.db.query(`INSERT INTO users (username, password_hash) VALUES ('gouser', $1)`, [goHash]);
	const r = await ta.request("POST", "/api/v1/auth/login", { body: { username: "gouser", password: "correct horse battery" } });
	expectStatus(r, 200);
});

test("financial statements", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { call } = ta;
	await createAccount(ta, "1000", "Bank CAD", "asset", "CAD");
	await createAccount(ta, "1010", "Bank USD", "asset", "USD");
	await createAccount(ta, "1900", "FX clearing CAD", "asset", "CAD");
	await createAccount(ta, "1910", "FX clearing USD", "liability", "USD");
	await createAccount(ta, "2000", "Credit card", "liability", "CAD");
	await createAccount(ta, "3000", "Owner equity", "equity", "CAD");
	await createAccount(ta, "4000", "Sales", "revenue", "CAD");
	await createAccount(ta, "4010", "Sales USD", "revenue", "USD");
	await createAccount(ta, "6100", "Supplies", "expense", "CAD");

	const post = async (date: string, ...lines: Line[]) => expectStatus(await call("POST", "/journal-entries", entry(date, "x", ...lines)), 201);
	await post("2025-12-15", dr("1000", 1000000), cr("3000", 1000000)); // capital 10,000
	await post("2025-12-20", dr("1000", 50000), cr("4000", 50000)); // 2025 sale 500
	await post("2026-02-01", dr("1000", 120000), cr("4000", 120000)); // 2026 sale 1,200
	await post("2026-03-01", dr("6100", 30000), cr("2000", 30000)); // supplies on card 300
	await post("2026-04-01", dr("1010", 80000), cr("4010", 80000)); // USD sale 800
	await post("2026-05-01", dr("1900", 13700), cr("1000", 13700), dr("1910", 10000), cr("1010", 10000)); // swap

	let r = await call("GET", "/reports/balance-sheet?as_of=2026-12-31");
	expectStatus(r, 200);
	let bs = r.json();
	assert.equal(bs.currencies.length, 2);
	const [cad, usd] = bs.currencies;
	// CAD assets: bank 10000+500+1200-137 = 11563; clearing 137 => 11700.
	// Liabilities: card 300. Equity 10000 + net income (500+1200-300=1400) = 11400.
	assert.equal(cad.currency, "CAD");
	assert.equal(cad.total_assets_cents, 1170000);
	assert.equal(cad.total_liabilities_cents, 30000);
	assert.equal(cad.net_income_cents, 140000);
	assert.equal(cad.total_equity_cents, 1140000);
	assert.equal(cad.balanced, true);
	// USD: bank 800-100 = 700; clearing (a liability here) shows -100; equity = net income 800.
	assert.equal(usd.total_assets_cents, 70000);
	assert.equal(usd.total_liabilities_cents, -10000);
	assert.equal(usd.total_equity_cents, 80000);
	assert.equal(usd.balanced, true);

	// Balance sheet as of an earlier date.
	r = await call("GET", "/reports/balance-sheet?as_of=2025-12-31&currency=CAD");
	bs = r.json();
	assert.equal(bs.currencies.length, 1);
	assert.equal(bs.currencies[0].total_assets_cents, 1050000);
	assert.equal(bs.currencies[0].net_income_cents, 50000);

	// Income statement for 2026 only.
	r = await call("GET", "/reports/income-statement?from=2026-01-01&to=2026-12-31");
	expectStatus(r, 200);
	const is = r.json();
	assert.equal(is.currencies.length, 2);
	const c = is.currencies[0];
	assert.equal(c.total_revenue_cents, 120000);
	assert.equal(c.total_expenses_cents, 30000);
	assert.equal(c.net_income_cents, 90000);
	assert.equal(c.revenue.length, 1);
	assert.equal(c.revenue[0].account_code, "4000");
	assert.equal(c.expenses.length, 1);
	assert.equal(is.currencies[1].currency, "USD");
	assert.equal(is.currencies[1].net_income_cents, 80000);
	expectStatus(await call("GET", "/reports/income-statement?from=2026-02-01&to=2026-01-01"), 422);
});

test("update settings API", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call } = ta;

	// Without the updater's directories the page explains it isn't set up.
	let r = await call("GET", "/system/update");
	expectStatus(r, 200);
	assert.equal(r.json().updater_installed, false);
	assert.equal(r.json().status, null);
	expectStatus(await call("POST", "/system/update/check"), 409);

	const root = await mkdtemp(path.join(tmpdir(), "ledger-upd-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	app.update = { config: path.join(root, "config"), status: path.join(root, "status") };
	await mkdir(app.update.config);
	await mkdir(app.update.status);

	r = await call("GET", "/system/update");
	assert.equal(r.json().updater_installed, true);
	assert.equal(r.json().schedule.enabled, false);
	assert.equal(r.json().next_run_at, null);

	const schedule = { enabled: true, days: [6, 0], time: "02:15", timezone: "America/Toronto", reboot: "after_update" };
	r = await call("PUT", "/system/update/schedule", schedule);
	expectStatus(r, 200);
	assert.deepEqual(r.json().schedule, { ...schedule, days: [0, 6] });
	assert.ok(Date.parse(r.json().next_run_at) > Date.now());
	assert.deepEqual(JSON.parse(await readFile(path.join(app.update.config, "schedule.json"), "utf8")).days, [0, 6]);

	r = await call("PUT", "/system/update/schedule", { ...schedule, time: "25:00", timezone: "Nowhere/Land" });
	expectStatus(r, 422);
	assert.equal(r.json().error.details.length, 2);
	expectStatus(await call("PUT", "/system/update/schedule", { ...schedule, extra: true }), 422);

	expectStatus(await call("POST", "/system/update/check"), 202);
	await stat(path.join(app.update.config, "run-now"));

	// A run in progress blocks another request.
	await writeFile(path.join(app.update.status, "status.json"), JSON.stringify({ state: "running", started_at: new Date().toISOString(), message: "Downloading" }));
	r = await call("GET", "/system/update");
	assert.equal(r.json().status.state, "running");
	assert.equal(r.json().status.installed_version, null); // defaults filled in
	expectStatus(await call("POST", "/system/update/check"), 409);

	// Requires a session, like everything else.
	expectStatus(await ta.request("GET", "/api/v1/system/update"), 401);
});

test("modules: runtime, UI and management API", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call, request } = ta;
	const cookie = `${SESSION_COOKIE}=${ta.token}`;
	const root = await mkdtemp(path.join(tmpdir(), "ledger-modrt-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const hello = path.join(import.meta.dirname, "fixtures", "hello-module");

	// Installed modules (what the root installer leaves behind): the fixture,
	// one that posts entries, and one that fails to load.
	const modules = path.join(root, "modules");
	await cp(hello, path.join(modules, "hello"), { recursive: true });
	await mkdir(path.join(modules, "poster"), { recursive: true });
	await writeFile(path.join(modules, "poster", "ledger-module.json"), JSON.stringify({ id: "poster", name: "Poster", version: "1.0.0", server: "server.mjs" }));
	await writeFile(
		path.join(modules, "poster", "server.mjs"),
		`export default function (ctx) {
			ctx.route("POST", "/sale/:amount", (req) => ctx.ledger.createJournalEntry({
				entry_date: "2026-10-01", description: "Sale via module",
				lines: [{ account_code: "1000", debit_cents: req.params.amount }, { account_code: "4000", credit_cents: Number(req.params.amount) }],
			}, req.user));
			ctx.route("GET", "/boom", () => { throw new ctx.HttpError(418, "teapot"); });
		}`,
	);
	await mkdir(path.join(modules, "configured"), { recursive: true });
	await writeFile(
		path.join(modules, "configured", "ledger-module.json"),
		JSON.stringify({
			id: "configured",
			name: "Configured",
			version: "1.0.0",
			server: "server.mjs",
			settings: {
				fields: [
					{ key: "api_key", label: "API key", type: "secret", required: true },
					{ key: "model", type: "select", options: ["small", { value: "large", label: "Large model" }], default: "small" },
					{ key: "max_tokens", type: "number", min: 1, max: 1000, default: 100 },
					{ key: "enabled", type: "boolean", default: true },
				],
			},
		}),
	);
	await writeFile(
		path.join(modules, "configured", "server.mjs"),
		`let seen = null;
		export default function (ctx) {
			ctx.settings.onChange((v) => { seen = v; });
			ctx.route("GET", "/values", async () => ({ now: await ctx.settings.get(), seen }));
			ctx.route("POST", "/bump", async () => { await ctx.settings.set({ max_tokens: 999 }); return ctx.settings.get(); });
		}`,
	);
	await mkdir(path.join(modules, "broken"), { recursive: true });
	await writeFile(path.join(modules, "broken", "ledger-module.json"), JSON.stringify({ id: "broken", name: "Broken", version: "1.0.0", server: "server.mjs" }));
	await writeFile(path.join(modules, "broken", "server.mjs"), `export default function () { throw new Error("cannot start"); }`);
	// The hello module's migration, as the installer would apply it.
	await app.db.query(`CREATE SCHEMA mod_hello; SET search_path = mod_hello; ${await readFile(path.join(hello, "migrations", "001_notes.sql"), "utf8")} RESET search_path;`);

	app.modules = new ModuleHost(modules);
	await app.modules.loadAll(app);
	assert.equal(app.modules.modules.get("broken")!.error, "cannot start");
	assert.equal(app.modules.modules.get("hello")!.error, null);

	let r0;
	// Module settings: declared fields, secrets never sent back, validated.
	let ms = await call("GET", "/modules/configured/settings");
	expectStatus(ms, 200);
	assert.deepEqual(ms.json().values, { api_key: null, model: "small", max_tokens: 100, enabled: true });
	assert.deepEqual(ms.json().secrets_set, { api_key: false });
	assert.equal(ms.json().fields[1].options[1].label, "Large model");
	expectStatus(await call("GET", "/modules/poster/settings"), 404); // declares none
	expectStatus(await call("PUT", "/modules/configured/settings", { values: { model: "large" } }), 422); // api_key required
	expectStatus(await call("PUT", "/modules/configured/settings", { values: { api_key: "sk-1", max_tokens: 5000 } }), 422);
	expectStatus(await call("PUT", "/modules/configured/settings", { values: { api_key: "sk-1", nope: 1 } }), 422);
	ms = await call("PUT", "/modules/configured/settings", { values: { api_key: "sk-1", model: "large", enabled: false } });
	expectStatus(ms, 200);
	assert.deepEqual(ms.json().values, { api_key: null, model: "large", max_tokens: 100, enabled: false });
	assert.deepEqual(ms.json().secrets_set, { api_key: true });
	let mv = (await call("GET", "/m/configured/values")).json();
	assert.equal(mv.now.api_key, "sk-1"); // the module sees the secret
	assert.equal(mv.seen.model, "large"); // and was told about the change
	// Leaving a secret out keeps it; null resets other fields to their default.
	await call("PUT", "/modules/configured/settings", { values: { model: null } });
	mv = (await call("GET", "/m/configured/values")).json();
	assert.deepEqual([mv.now.api_key, mv.now.model], ["sk-1", "small"]);
	assert.equal((await call("POST", "/m/configured/bump")).json().max_tokens, 999);
	r0 = await call("GET", "/modules");
	assert.deepEqual(
		r0.json().modules.filter((m: any) => m.has_settings).map((m: any) => m.id).sort(),
		["configured", "hello"],
	);

	// The fixture module's API.
	await createAccount(ta, "1000", "Bank CAD", "asset", "CAD");
	await createAccount(ta, "4000", "Sales", "revenue", "CAD");
	let r = await call("GET", "/m/hello/summary");
	expectStatus(r, 200);
	assert.equal(r.json().accounts, 2);
	r = await call("GET", "/dashboard");
	assert.deepEqual(
		r.json().todos.map((i: any) => [i.source, i.source_name, i.key, i.closed_at === null]),
		[["hello", "Hello module", "first-note", true]],
	);
	r = await call("POST", "/m/hello/notes", { body: "First note" });
	expectStatus(r, 201);
	assert.equal(r.json().created_by, "tester");
	r = await call("GET", "/dashboard");
	assert.notEqual(r.json().todos[0].closed_at, null); // ticked off by the module
	assert.deepEqual(
		r.json().notifications.map((i: any) => [i.key, i.title, i.body, i.link]),
		[["latest-note", "tester wrote a note", "First note", "/apps/hello"]],
	);
	expectStatus(await call("POST", "/m/hello/notes", { body: "" }), 422);
	r = await call("GET", "/m/hello/notes");
	assert.equal(r.json().data.length, 1);
	expectStatus(await call("DELETE", `/m/hello/notes/${r.json().data[0].id}`), 204);
	expectStatus(await call("DELETE", "/m/hello/notes/999"), 404);
	expectStatus(await call("PUT", "/m/hello/notes"), 405);
	expectStatus(await call("GET", "/m/hello/nope"), 404);
	expectStatus(await call("GET", "/m/broken/anything"), 404);
	expectStatus(await request("GET", "/api/v1/m/hello/summary"), 401); // needs a session

	// Entries posted by a module are validated and attributed like any other.
	r = await call("POST", "/m/poster/sale/2500");
	expectStatus(r, 200);
	assert.equal(r.json().created_by, "tester");
	assert.equal(r.json().totals[0].amount_cents, 2500);
	expectStatus(await call("POST", "/m/poster/sale/0"), 422);
	r = await call("GET", "/m/poster/boom");
	expectStatus(r, 418);
	assert.equal(r.json().error.message, "teapot");

	// The UI: same origin, framable by Ledger only, login required.
	r = await request("GET", "/m/hello/", { cookie });
	expectStatus(r, 200);
	assert.match(r.text, /Hello from a module/);
	assert.equal(r.headers["x-frame-options"], "SAMEORIGIN");
	expectStatus(await request("GET", "/m/hello", { cookie }), 301);
	expectStatus(await request("GET", "/m/hello/some/client/route", { cookie }), 200); // index.html
	expectStatus(await request("GET", "/m/hello/missing.js", { cookie }), 404);
	expectStatus(await request("GET", "/m/hello/..%2F..%2Fledger-module.json", { cookie }), 404);
	expectStatus(await request("GET", "/m/hello/"), 401);
	expectStatus(await request("GET", "/m/poster/", { cookie }), 404); // no UI

	// Management API: preview and add through (fake) GitHub, then remove.
	r = await call("GET", "/modules");
	expectStatus(r, 200);
	assert.deepEqual(r.json().nav.map((n: any) => [n.id, n.label, n.icon, n.icon_path?.slice(0, 8), n.icon_fill, n.icon_url]), [
		["hello", "Hello", null, "M4 5h16v", false, null],
	]);
	assert.equal(r.json().installer_available, false);
	const names = r.json().modules.map((m: { id: string; state: string }) => `${m.id}:${m.state}`).sort();
	assert.deepEqual(names, ["broken:removing", "configured:removing", "hello:removing", "poster:removing"]); // installed but not on the wanted list

	const gh = await fakeGitHub(t);
	process.env.LEDGER_UPDATE_API = gh.base;
	t.after(() => delete process.env.LEDGER_UPDATE_API);
	await gh.publish("someone/ledger-hello", "v1.0.0", hello);
	r = await call("POST", "/modules/preview", { repo: "https://github.com/someone/ledger-hello" });
	expectStatus(r, 200);
	assert.equal(r.json().manifest.id, "hello");
	assert.equal(r.json().tag, "v1.0.0");
	expectStatus(await call("POST", "/modules/preview", { repo: "someone/nothing-here" }), 422);
	expectStatus(await call("POST", "/modules/preview", { repo: "not a repo" }), 422);
	expectStatus(await call("POST", "/modules", { repo: "someone/ledger-hello" }), 409); // updater not set up

	app.update = { config: path.join(root, "config"), status: path.join(root, "status") };
	await mkdir(app.update.config);
	await mkdir(app.update.status);
	r = await call("POST", "/modules", { repo: "someone/ledger-hello" });
	expectStatus(r, 202);
	assert.deepEqual(JSON.parse(await readFile(path.join(app.update.config, "modules.json"), "utf8")), [{ repo: "someone/ledger-hello", id: "hello" }]);
	await stat(path.join(app.update.config, "modules-run-now"));
	const added = r.json().modules.find((m: { repo: string }) => m.repo === "someone/ledger-hello");
	assert.equal(added.state, "running"); // matched to the installed copy by id

	// The repository was renamed on GitHub: point the module at the new name.
	gh.rename("someone/ledger-hello", "someone/hello-module");
	await gh.publish("someone/other", "v1.0.0", hello, async (stage) => {
		const m = JSON.parse(await readFile(path.join(stage, "ledger-module.json"), "utf8"));
		await writeFile(path.join(stage, "ledger-module.json"), JSON.stringify({ ...m, id: "other" }));
	});
	r = await call("PATCH", "/modules/hello", { repo: "https://github.com/someone/hello-module" });
	expectStatus(r, 202);
	assert.deepEqual(JSON.parse(await readFile(path.join(app.update.config, "modules.json"), "utf8")), [{ repo: "someone/hello-module", id: "hello" }]);
	r = await call("PATCH", "/modules/hello", { repo: "someone/other" }); // a different module
	expectStatus(r, 422);
	assert.equal(r.json().error.details[0].message, 'someone/other holds the module "other", not "hello"');
	expectStatus(await call("PATCH", "/modules/hello", { repo: "not a repo" }), 422);
	expectStatus(await call("PATCH", "/modules/nonexistent", { repo: "someone/hello-module" }), 404);

	// Ledger's own repository: only the same GitHub repository (renamed) is accepted.
	process.env.LEDGER_UPDATE_REPO = "mastifdogo/Bookeeping";
	t.after(() => delete process.env.LEDGER_UPDATE_REPO);
	gh.repo("mastifdogo/Bookeeping");
	gh.rename("mastifdogo/Bookeeping", "mastifdogo/ledger");
	r = await call("GET", "/system/update");
	assert.deepEqual(r.json().repo, { current: "mastifdogo/Bookeeping", installed: "mastifdogo/Bookeeping" });
	r = await call("PUT", "/system/update/repo", { repo: "github.com/mastifdogo/ledger" });
	expectStatus(r, 200);
	assert.deepEqual(r.json().repo, { current: "mastifdogo/ledger", installed: "mastifdogo/Bookeeping" });
	r = await call("PUT", "/system/update/repo", { repo: "someone/other" });
	expectStatus(r, 422);
	assert.match(r.text, /different repository/);
	r = await call("PUT", "/system/update/repo", { repo: "mastifdogo/Bookeeping" }); // back to the installed name (GitHub redirects)
	assert.equal(r.json().repo.current, "mastifdogo/ledger"); // GitHub's current spelling is kept

	r = await call("DELETE", "/modules/hello");
	expectStatus(r, 202);
	assert.deepEqual(JSON.parse(await readFile(path.join(app.update.config, "modules.json"), "utf8")), []);
	expectStatus(await call("DELETE", "/modules/nonexistent"), 404);
});

test("dashboard: summary, notifications and to-dos", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call } = ta;
	const day = today();

	let r = await call("GET", "/dashboard");
	expectStatus(r, 200);
	assert.deepEqual(r.json(), { summary: { as_of: day, currencies: [] }, notifications: [], todos: [] });

	await createAccount(ta, "1000", "Bank", "asset", "CAD");
	await createAccount(ta, "2000", "Card", "liability", "CAD");
	await createAccount(ta, "3000", "Equity", "equity", "CAD");
	await createAccount(ta, "4000", "Sales", "revenue", "CAD");
	await createAccount(ta, "6100", "Supplies", "expense", "CAD");
	await createAccount(ta, "6200", "Rent", "expense", "CAD");
	const post = async (...lines: Line[]) => expectStatus(await call("POST", "/journal-entries", entry(day, "x", ...lines)), 201);
	await post(dr("1000", 500000), cr("3000", 500000));
	await post(dr("1000", 120000), cr("4000", 120000));
	await post(dr("6100", 3000), cr("2000", 3000));
	await post(dr("6200", 90000), cr("1000", 90000));

	r = await call("GET", "/dashboard");
	const [cad] = r.json().summary.currencies;
	assert.equal(cad.currency, "CAD");
	assert.equal(cad.assets_cents, 530000);
	assert.equal(cad.liabilities_cents, 3000);
	assert.equal(cad.net_worth_cents, 527000);
	assert.equal(cad.month.revenue_cents, 120000);
	assert.equal(cad.month.expenses_cents, 93000);
	assert.equal(cad.month.net_income_cents, 27000);
	assert.equal(cad.year.net_income_cents, 27000);
	assert.equal(cad.year.from, day.slice(0, 4) + "-01-01");
	assert.deepEqual(
		cad.top_expenses.map((e: any) => [e.account_code, e.amount_cents]),
		[["6200", 90000], ["6100", 3000]],
	);

	// Posting (as a module would): the same key updates instead of duplicating.
	const n = await postItem(app, "ledger", "notification", { key: "k", title: "Hello", level: "warning", link: "/system" });
	await postItem(app, "ledger", "notification", { key: "k", title: "Hello", level: "warning", link: "/system" });
	await postItem(app, "ledger", "notification", { title: "No key, always new" });
	const later = await postItem(app, "ledger", "todo", { key: "b", title: "Later", due: "2099-01-01" });
	await postItem(app, "ledger", "todo", { key: "a", title: "Sooner", due: "2000-01-01" });
	await postItem(app, "ledger", "notification", { key: "old", title: "Gone", expiresAt: new Date(Date.now() - 1000) });
	r = await call("GET", "/dashboard");
	assert.deepEqual(r.json().notifications.map((i: any) => i.title).sort(), ["Hello", "No key, always new"]);
	assert.deepEqual(r.json().todos.map((i: any) => i.key), ["a", "b"]); // by due date

	// Bad input is a validation error.
	for (const bad of [{ title: "" }, { title: "x", level: "loud" }, { title: "x", link: "https://evil.example" }, { title: "x", link: "//evil.example" }]) {
		await assert.rejects(postItem(app, "ledger", "notification", bad), /validation failed/);
	}
	await assert.rejects(postItem(app, "ledger", "todo", { title: "no key" } as any), /key/);
	await assert.rejects(postItem(app, "ledger", "todo", { key: "x", title: "x", due: "soon" }), /due/);

	// Dismiss a notification; it shows again only if its text changes.
	r = await call("POST", `/dashboard/items/${n.id}/close`);
	expectStatus(r, 200);
	assert.equal(r.json().closed_by, "tester");
	expectStatus(await call("POST", `/dashboard/items/${n.id}/reopen`), 404); // to-dos only
	await postItem(app, "ledger", "notification", { key: "k", title: "Hello", level: "warning", link: "/system" });
	assert.equal((await call("GET", "/dashboard")).json().notifications.length, 1);
	await postItem(app, "ledger", "notification", { key: "k", title: "Hello again" });
	assert.equal((await call("GET", "/dashboard")).json().notifications.length, 2);

	// Complete and reopen a to-do; done ones stay listed, after the open ones.
	expectStatus(await call("POST", `/dashboard/items/${later.id}/close`), 200);
	r = await call("GET", "/dashboard");
	assert.deepEqual(r.json().todos.map((i: any) => [i.key, i.closed_at === null]), [["a", true], ["b", false]]);
	r = await call("POST", `/dashboard/items/${later.id}/reopen`);
	expectStatus(r, 200);
	assert.equal(r.json().closed_at, null);
	expectStatus(await call("POST", "/dashboard/items/999999/close"), 404);
	expectStatus(await call("POST", "/dashboard/items/abc/close"), 404);
	expectStatus(await ta.request("GET", "/api/v1/dashboard"), 401);
});

test("sidebar preferences are per user", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { call } = ta;
	let r = await call("GET", "/settings/sidebar");
	expectStatus(r, 200);
	assert.deepEqual(r.json(), { items: [] });

	const items = [
		{ id: "module:invoicing", hidden: false },
		{ id: "core:dashboard", hidden: false },
		{ id: "core:files", hidden: true },
	];
	r = await call("PUT", "/settings/sidebar", { items });
	expectStatus(r, 200);
	assert.deepEqual((await call("GET", "/settings/sidebar")).json(), { items });

	// Another user has their own.
	await createUser(ta.app, "other", "1234");
	const login = await ta.request("POST", "/api/v1/auth/login", { body: { username: "other", password: "1234" } });
	const cookie = sessionFrom(login).header.split(";")[0]!;
	assert.deepEqual((await ta.request("GET", "/api/v1/settings/sidebar", { cookie })).json(), { items: [] });

	for (const bad of [
		{ items: [{ id: "core:files" }, { id: "core:files" }] },
		{ items: [{ id: "elsewhere" }] },
		{ items: [{ id: "module:x", hidden: "yes" }] },
		{ items: "nope" },
	]) {
		expectStatus(await call("PUT", "/settings/sidebar", bad), 422);
	}
	expectStatus(await call("PUT", "/settings/sidebar", { items: [], extra: 1 }), 400);
	expectStatus(await call("PUT", "/settings/sidebar", { items: [{ id: "core:files", colour: "red" }] }), 400);
	expectStatus(await call("PUT", "/settings/sidebar", { items: [] }), 200);
	assert.deepEqual((await call("GET", "/settings/sidebar")).json(), { items: [] });
	expectStatus(await ta.request("GET", "/api/v1/settings/sidebar"), 401);
});

test("reconciliation", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { call } = ta;
	await createAccount(ta, "1000", "Chequing", "asset", "CAD");
	await createAccount(ta, "2000", "Visa", "liability", "CAD");
	await createAccount(ta, "3000", "Equity", "equity", "CAD");
	await createAccount(ta, "6100", "Supplies", "expense", "CAD");
	const post = async (date: string, ...lines: Line[]) => {
		const r = await call("POST", "/journal-entries", entry(date, "x", ...lines));
		expectStatus(r, 201);
		return r.json();
	};
	await post("2026-09-01", dr("1000", 100000), cr("3000", 100000)); // +1000.00
	await post("2026-09-10", dr("6100", 2500), cr("1000", 2500)); // -25.00
	await post("2026-09-20", dr("6100", 4000), cr("2000", 4000)); // card +40.00 owed
	await post("2026-10-05", dr("6100", 1000), cr("1000", 1000)); // after the statement

	// Statement: Sept 30, balance 975.00.
	let r = await call("POST", "/reconciliations", { account_code: "1000", statement_date: "2026-09-30", statement_balance_cents: 97500 });
	expectStatus(r, 201);
	let d = r.json();
	const id = d.reconciliation.id;
	assert.equal(d.reconciliation.status, "open");
	assert.equal(d.lines.length, 2); // the October line is after the statement
	assert.deepEqual(d.lines.map((l: any) => l.amount_cents), [100000, -2500]);
	assert.equal(d.difference_cents, 97500);
	expectStatus(await call("POST", "/reconciliations", { account_code: "1000", statement_date: "2026-09-30", statement_balance_cents: 0 }), 409);

	// Tick the first line: not balanced yet, can't finish.
	const [l1, l2] = d.lines.map((l: any) => l.transaction_id);
	r = await call("POST", `/reconciliations/${id}/cleared`, { clear: [l1] });
	expectStatus(r, 200);
	assert.equal(r.json().difference_cents, -2500);
	expectStatus(await call("POST", `/reconciliations/${id}/finish`), 409);
	r = await call("POST", `/reconciliations/${id}/cleared`, { clear: [l2] });
	assert.equal(r.json().difference_cents, 0);
	assert.equal(r.json().cleared_balance_cents, 97500);
	// Lines of other accounts or after the statement date are refused.
	const visa = (await call("GET", "/accounts/2000/ledger")).json().lines[0].line_id;
	expectStatus(await call("POST", `/reconciliations/${id}/cleared`, { clear: [visa] }), 422);
	r = await call("POST", `/reconciliations/${id}/finish`);
	expectStatus(r, 200);
	assert.equal(r.json().reconciliation.status, "finished");
	assert.equal(r.json().reconciliation.finished_by, "tester");
	expectStatus(await call("POST", `/reconciliations/${id}/cleared`, { unclear: [l1] }), 409);
	expectStatus(await call("DELETE", `/reconciliations/${id}`), 409);

	// Next statement starts from the reconciled balance; cleared lines are gone.
	expectStatus(await call("POST", "/reconciliations", { account_code: "1000", statement_date: "2026-09-15", statement_balance_cents: 0 }), 422);
	r = await call("POST", "/reconciliations", { account_code: "1000", statement_date: "2026-10-31", statement_balance_cents: 96500 });
	expectStatus(r, 201);
	d = r.json();
	assert.equal(d.opening_balance_cents, 97500);
	assert.equal(d.lines.length, 1);
	assert.equal(d.difference_cents, -1000);
	// The earlier one can't be undone while this one is open; delete this one, then undo.
	expectStatus(await call("POST", `/reconciliations/${id}/undo`), 409);
	expectStatus(await call("DELETE", `/reconciliations/${d.reconciliation.id}`), 204);
	r = await call("POST", `/reconciliations/${id}/undo`);
	expectStatus(r, 200);
	assert.equal(r.json().reconciliation.status, "open");
	r = await call("PATCH", `/reconciliations/${id}`, { statement_date: "2026-09-05" });
	expectStatus(r, 422); // a cleared line is dated after it
	r = await call("PATCH", `/reconciliations/${id}`, { statement_balance_cents: 100000 });
	assert.equal(r.json().difference_cents, 2500);

	// Liability: natural sign (amount owed is positive).
	r = await call("POST", "/reconciliations", { account_code: "2000", statement_date: "2026-09-30", statement_balance_cents: 4000 });
	d = r.json();
	assert.equal(d.lines[0].amount_cents, 4000);
	r = await call("POST", `/reconciliations/${d.reconciliation.id}/cleared`, { clear: [d.lines[0].transaction_id] });
	assert.equal(r.json().difference_cents, 0);

	r = await call("GET", "/reconciliations?account_code=1000");
	assert.equal(r.json().data.length, 1);
	assert.equal((await call("GET", "/reconciliations")).json().data.length, 2);
	expectStatus(await call("GET", "/reconciliations/999"), 404);
	expectStatus(await call("POST", "/reconciliations", { account_code: "nope", statement_date: "2026-09-30", statement_balance_cents: 0 }), 422);
	expectStatus(await call("POST", "/reconciliations", { account_code: "1000" }), 422);
});

test("backups: settings, a mounted share and Google Drive", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call } = ta;
	const g = await fakeGoogle(t);
	app.backup.google = { oauth: g.oauth, api: g.api };
	const root = await mkdtemp(path.join(tmpdir(), "ledger-bk-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const prevRoots = process.env.BACKUP_SHARE_ROOTS;
	process.env.BACKUP_SHARE_ROOTS = root;
	t.after(() => (prevRoots === undefined ? delete process.env.BACKUP_SHARE_ROOTS : (process.env.BACKUP_SHARE_ROOTS = prevRoots)));

	// Not set up on this server until the state directory exists.
	let r = await call("GET", "/backups");
	expectStatus(r, 200);
	assert.equal(r.json().available, false);
	expectStatus(await call("POST", "/backups/run"), 409);
	await mkdir(app.backup.dir, { mode: 0o700 });

	const share = path.join(root, "share", "backups");
	await mkdir(path.dirname(share));
	const settings = {
		schedule: { enabled: true, days: [1, 3, 5], time: "01:15", timezone: "America/Winnipeg" },
		share: { enabled: true, mode: "folder", path: share, keep_days: 7 },
		google: { enabled: false, client_id: "123-abc.apps.googleusercontent.com", client_secret: "secret-1", keep_count: 2 },
	};
	r = await call("PUT", "/backups/config", settings);
	expectStatus(r, 200);
	let info = r.json();
	assert.equal(info.available, true);
	assert.deepEqual(info.config.google, { enabled: false, client_id: settings.google.client_id, has_client_secret: true, connected: false, account: "", keep_count: 2 });
	assert.ok(info.next_run);
	assert.equal(JSON.stringify(info).includes("secret-1"), false); // secrets stay on the server
	// Invalid settings.
	for (const bad of [
		{ ...settings, share: { ...settings.share, path: "/etc/backups" } },
		{ ...settings, share: { ...settings.share, path: "relative" } },
		{ ...settings, schedule: { ...settings.schedule, days: [] } },
		{ ...settings, share: { ...settings.share, mode: "smb", server: "bad host!", share: "backups" } },
		{ ...settings, share: { ...settings.share, mode: "smb", server: "nas.local", share: "a/b" } },
		{ ...settings, share: { ...settings.share, mode: "smb", server: "nas.local", share: "backups", directory: "../up" } },
		{ ...settings, truenas: settings.share },
		{ ...settings, google: { ...settings.google, enabled: true, client_id: "" } },
		{ ...settings, google: { ...settings.google, client_id: "nope" } },
		{ extra: 1 },
	]) {
		expectStatus(await call("PUT", "/backups/config", bad), 422);
	}
	r = await call("POST", "/backups/share/test", { mode: "folder", path: share });
	assert.equal(r.json().ok, true, r.text);
	r = await call("POST", "/backups/share/test", { mode: "folder", path: path.join(root, "missing", "dir") });
	assert.equal(r.json().ok, false);
	assert.match(r.json().message, /mounted/);

	// A backup to the mounted share (pg_dump replaced by a stub file).
	const dump = async (f: string) => writeFile(f, "PGDMP fake dump");
	let out = await runBackup({ dir: app.backup.dir, databaseUrl: app.backup.databaseUrl, trigger: "manual", google: app.backup.google, dump });
	assert.equal(out.status.state, "ok", out.status.message);
	const files = await readdir(share);
	assert.equal(files.length, 1);
	assert.match(files[0]!, /^ledger-\d{8}T\d{6}Z\.dump$/);
	assert.equal((await readdir(path.join(app.backup.dir, "tmp"))).length, 0); // the local copy is removed
	info = (await call("GET", "/backups")).json();
	assert.equal(info.status.state, "ok");
	assert.equal(info.share_files.length, 1);
	assert.ok(info.status.last_ok.share);
	// A scheduled run only happens when due.
	out = await runBackup({ dir: app.backup.dir, databaseUrl: app.backup.databaseUrl, trigger: "scheduled", dump, now: () => Date.parse("2026-10-27T12:00:00Z") });
	assert.equal(out.ran, false); // a Tuesday
	out = await runBackup({ dir: app.backup.dir, databaseUrl: app.backup.databaseUrl, trigger: "scheduled", dump, now: () => Date.parse("2026-10-28T06:20:00Z") });
	assert.equal(out.ran, true); // Wednesday 01:20 in Winnipeg
	assert.equal((await readBackupStatus(app.backup.dir)).last_scheduled_for, "2026-10-28T06:15:00.000Z");

	// Connect Google Drive with the device flow.
	r = await call("POST", "/backups/google/connect");
	expectStatus(r, 200);
	assert.equal(r.json().user_code, "ABCD-EFGH");
	r = await call("POST", "/backups/google/poll");
	assert.equal(r.json().state, "pending");
	r = await call("POST", "/backups/google/poll");
	assert.deepEqual(r.json(), { state: "connected", account: "me@example.com" });
	info = (await call("GET", "/backups")).json();
	assert.equal(info.config.google.connected, true);
	assert.equal(info.config.google.enabled, true);

	// Both destinations; Drive keeps the newest 2.
	for (let i = 0; i < 3; i++) {
		out = await runBackup({ dir: app.backup.dir, databaseUrl: app.backup.databaseUrl, trigger: "manual", google: app.backup.google, dump, now: () => Date.parse(`2026-11-0${i + 1}T10:00:00Z`) });
		assert.equal(out.status.state, "ok", out.status.message);
	}
	assert.deepEqual(g.files.map((f) => f.name).sort(), ["ledger-20261102T100000Z.dump", "ledger-20261103T100000Z.dump"]);
	assert.equal(g.files[0]!.parents[0], "folder-1");

	// Drive access revoked: the share still works, so a warning, posted to the dashboard.
	g.revokedGrant = true;
	out = await runBackup({ dir: app.backup.dir, databaseUrl: app.backup.databaseUrl, trigger: "manual", google: app.backup.google, dump });
	assert.equal(out.status.state, "warning");
	assert.equal(out.ok, true);
	assert.match(out.status.message, /revoked or expired/);
	let dash = (await call("GET", "/dashboard")).json();
	assert.deepEqual(
		dash.notifications.map((n: any) => [n.key, n.level, n.link]),
		[["backup", "warning", "/settings/backups"]],
	);
	g.revokedGrant = false;
	out = await runBackup({ dir: app.backup.dir, databaseUrl: app.backup.databaseUrl, trigger: "manual", google: app.backup.google, dump });
	assert.equal(out.status.state, "ok");
	dash = (await call("GET", "/dashboard")).json();
	assert.deepEqual(dash.notifications, []); // cleared by the successful backup

	// Nothing turned on: an error.
	r = await call("PUT", "/backups/config", { ...settings, share: { ...settings.share, enabled: false } });
	expectStatus(r, 200);
	await call("POST", "/backups/google/disconnect");
	assert.deepEqual(g.revoked, ["refresh-1"]);
	out = await runBackup({ dir: app.backup.dir, databaseUrl: app.backup.databaseUrl, trigger: "manual", dump });
	assert.equal(out.status.state, "error");
	assert.match(out.status.message, /no backup destination/);
	info = (await call("GET", "/backups")).json();
	assert.equal(info.config.google.connected, false);
	// Changing the client ID forgets the connection; the secret is kept only for the same client.
	r = await call("PUT", "/backups/config", { ...settings, google: { enabled: false, client_id: "999-zzz.apps.googleusercontent.com", keep_count: 2 } });
	assert.equal(r.json().config.google.has_client_secret, false);
	expectStatus(await call("GET", "/backups"), 200);
	expectStatus(await ta.request("GET", "/api/v1/backups"), 401);
});

test("users and roles", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { call, request } = ta;
	const as = async (username: string, password: string) => {
		const r = await request("POST", "/api/v1/auth/login", { body: { username, password } });
		expectStatus(r, 200);
		const cookie = sessionFrom(r).header.split(";")[0]!;
		return (method: string, p: string, body?: unknown) => request(method, "/api/v1" + p, { body, cookie });
	};

	let r = await call("GET", "/auth/me");
	assert.equal(r.json().role, "admin"); // the harness user (like `ledger user add`)
	expectStatus(await call("POST", "/users", { username: "bob", password: "1234", role: "bookkeeper" }), 201);
	expectStatus(await call("POST", "/users", { username: "vera", password: "5678", role: "viewer" }), 201);
	expectStatus(await call("POST", "/users", { username: "bob", password: "1234", role: "viewer" }), 409);
	expectStatus(await call("POST", "/users", { username: "x", password: "1", role: "viewer" }), 422);
	expectStatus(await call("POST", "/users", { username: "y", password: "1234", role: "owner" }), 422);
	r = await call("GET", "/users");
	assert.deepEqual(
		r.json().data.map((u: any) => [u.username, u.role]),
		[["bob", "bookkeeper"], ["tester", "admin"], ["vera", "viewer"]],
	);

	const vera = await as("vera", "5678");
	const bob = await as("bob", "1234");
	// Viewer: reads everything, changes nothing but their own password and sidebar.
	expectStatus(await vera("GET", "/accounts"), 200);
	expectStatus(await vera("GET", "/dashboard"), 200);
	r = await vera("POST", "/accounts", { code: "1000", name: "Bank", type: "asset", currency: "CAD" });
	expectStatus(r, 403);
	assert.match(r.json().error.message, /bookkeeper/);
	expectStatus(await vera("PUT", "/settings/sidebar", { items: [] }), 200);
	expectStatus(await vera("POST", "/auth/password", { current_password: "5678", new_password: "8765" }), 204);
	expectStatus(await vera("GET", "/users"), 403);
	// Bookkeeper: works in the books, but not the system.
	expectStatus(await bob("POST", "/accounts", { code: "1000", name: "Bank", type: "asset", currency: "CAD" }), 201);
	expectStatus(await bob("GET", "/users"), 403);
	expectStatus(await bob("GET", "/backups"), 403);
	expectStatus(await bob("POST", "/modules/sync"), 403);
	expectStatus(await bob("GET", "/modules"), 200); // the sidebar needs it

	// Promote, demote; the last admin stays.
	r = await call("PATCH", "/users/tester", { role: "viewer" });
	expectStatus(r, 422);
	assert.match(r.text, /at least one active admin/);
	expectStatus(await call("PATCH", "/users/tester", { is_active: false }), 422); // not yourself
	r = await call("PATCH", "/users/bob", { role: "admin" });
	assert.equal(r.json().role, "admin");
	expectStatus(await bob("GET", "/users"), 200); // takes effect at once
	expectStatus(await call("PATCH", "/users/tester", { role: "bookkeeper" }), 200); // bob is an admin now
	expectStatus(await call("GET", "/users"), 403);
	expectStatus(await bob("PATCH", "/users/tester", { role: "admin" }), 200);

	// Disabling ends sessions; a password reset too; a bad password changes nothing.
	expectStatus(await bob("PATCH", "/users/vera", { role: "bookkeeper", password: "1" }), 422);
	assert.equal((await bob("GET", "/users")).json().data.find((u: any) => u.username === "vera").role, "viewer");
	expectStatus(await bob("PATCH", "/users/vera", { is_active: false }), 200);
	expectStatus(await vera("GET", "/accounts"), 401);
	expectStatus(await bob("PATCH", "/users/vera", { is_active: true, password: "9999" }), 200);
	await as("vera", "9999");
	expectStatus(await bob("PATCH", "/users/nobody", { role: "viewer" }), 404);
	expectStatus(await bob("PATCH", "/users/vera", { username: "v2" }), 400);
});

test("search", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call } = ta;
	await createAccount(ta, "1000", "Chequing", "asset", "CAD");
	await createAccount(ta, "4000", "Consulting revenue", "revenue", "CAD");
	await createAccount(ta, "6100", "Office 100% supplies", "expense", "CAD");
	const post = async (desc: string, ref: string, cents: number, memo = "") => {
		const e = entry("2026-10-01", desc, dr("1000", cents), cr("4000", cents));
		(e as any).reference = ref;
		e.lines[0]!.memo = memo;
		expectStatus(await call("POST", "/journal-entries", e), 201);
	};
	await post("Invoice 31 Acme", "INV-31", 123456);
	await post("Deposit", "", 4500, "cheque from Globex");

	const q = async (s: string) => (await call("GET", `/search?q=${encodeURIComponent(s)}`)).json();
	let r = await q("cheq");
	assert.deepEqual(r.groups.map((g: any) => [g.source, g.results.map((x: any) => x.title)]), [
		["accounts", ["1000 Chequing"]],
		["entries", ["#2 Deposit"]], // memo match
	]);
	assert.equal(r.groups[0].results[0].href, "/accounts/1000");
	assert.deepEqual((await q("1,234.56")).groups.map((g: any) => g.results[0].title), ["#1 Invoice 31 Acme"]); // amount
	assert.deepEqual((await q("#2")).groups[0].results.map((x: any) => x.href), ["/journal/2"]);
	assert.deepEqual((await q("inv-31")).groups[0].results[0].subtitle, "2026-10-01 · 1,234.56 CAD · INV-31");
	assert.deepEqual((await q("100%")).groups.map((g: any) => g.results.map((x: any) => x.title)), [["6100 Office 100% supplies"]]); // % is literal
	assert.deepEqual((await q("  ")).groups, []);

	// Modules add results; bad hrefs, errors and slow providers are dropped.
	const root = await mkdtemp(path.join(tmpdir(), "ledger-search-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "crm"), { recursive: true });
	await writeFile(path.join(root, "crm", "ledger-module.json"), JSON.stringify({ id: "crm", name: "Customers", version: "1.0.0", server: "server.mjs" }));
	await writeFile(
		path.join(root, "crm", "server.mjs"),
		`export default function (ctx) {
			ctx.search.provide((q, { user }) => q === "acme" ? [
				{ title: "Acme Corp", subtitle: "customer, asked by " + user.username, href: "/apps/crm/customers/1" },
				{ title: "evil", href: "https://evil.example" },
				{ title: "evil2", href: "//evil.example" },
			] : []);
			ctx.search.provide(() => { throw new Error("broken"); });
			ctx.search.provide(() => new Promise(() => {}));
		}`,
	);
	app.modules = new ModuleHost(root);
	await app.modules.loadAll(app);
	r = await q("acme");
	assert.deepEqual(
		r.groups.map((g: any) => [g.label, g.results.map((x: any) => [x.title, x.subtitle, x.href])]),
		[
			["Journal entries", [["#1 Invoice 31 Acme", "2026-10-01 · 1,234.56 CAD · INV-31", "/journal/1"]]],
			["Customers", [["Acme Corp", "customer, asked by tester", "/apps/crm/customers/1"]]],
		],
	);
	expectStatus(await ta.request("GET", "/api/v1/search?q=acme"), 401);
});

/** Loads modules (id → server.mjs source, or { code, manifest } for extra manifest fields) into the test app. */
async function loadModules(t: any, app: any, mods: Record<string, string | { code: string; manifest: Record<string, unknown> }>) {
	const root = await mkdtemp(path.join(tmpdir(), "ledger-mods-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [id, spec] of Object.entries(mods)) {
		const code = typeof spec === "string" ? spec : spec.code;
		const extra = typeof spec === "string" ? {} : spec.manifest;
		await mkdir(path.join(root, id), { recursive: true });
		await writeFile(path.join(root, id, "ledger-module.json"), JSON.stringify({ id, name: id.toUpperCase(), version: "1.0.0", server: "server.mjs", ...extra }));
		await writeFile(path.join(root, id, "server.mjs"), code);
	}
	app.modules = new ModuleHost(root);
	await app.modules.loadAll(app);
}

test("LLM API connections shared with modules", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call } = ta;
	const ai = await fakeAi(t);
	await loadModules(t, app, {
		sorter: `export default function (ctx) {
			ctx.route("GET", "/status", () => ctx.llm.status());
			ctx.route("POST", "/ask", (req) => ctx.llm.json({ system: "Be brief.", prompt: req.body.q, schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }));
			ctx.route("POST", "/chat", (req) => ctx.llm.complete({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: req.body.q }] }));
			ctx.route("POST", "/look", (req) => ctx.llm.complete({ prompt: req.body.q, images: [{ media_type: "image/png", data: "iVBORw0KGgo=" }], connection: req.body.connection }));
		}`,
		other: `export default function (ctx) { ctx.route("POST", "/ask", () => ctx.llm.complete({ prompt: "x" })); }`,
	});
	const claude = { id: "main", name: "Claude", provider: "anthropic", api_key: "sk-test", base_url: ai.base, model: "claude-sonnet-5-5", uses: ["text"] };

	let r = await call("GET", "/integrations/llm");
	expectStatus(r, 200);
	assert.equal(r.json().available, false);
	expectStatus(await call("PUT", "/integrations/llm", { connections: [claude] }), 409);
	await mkdir(app.integrations.dir, { mode: 0o700 });

	// Not set up yet: modules get a clear 409.
	r = await call("POST", "/m/sorter/ask", { q: "hello" });
	expectStatus(r, 409);
	assert.match(r.json().error.message, /Settings → LLM API/);

	r = await call("PUT", "/integrations/llm", { connections: [claude], allow_modules: ["sorter"] });
	expectStatus(r, 200);
	assert.equal(r.json().config.configured, true);
	assert.equal(r.json().config.images_configured, false);
	assert.equal(r.json().config.connections[0].has_api_key, true);
	assert.equal(JSON.stringify(r.json()).includes("sk-test"), false); // the key never leaves the server
	assert.deepEqual(r.json().modules.map((m: any) => m.id).sort(), ["other", "sorter"]);
	for (const bad of [
		{ connections: [{ ...claude, provider: "gpt" }] },
		{ connections: [{ ...claude, base_url: "ftp://x" }] },
		{ connections: [claude, claude] },
		{ connections: [{ ...claude, id: "text" }] },
		{ connections: [{ ...claude, uses: ["video"] }] },
		{ connections: [{ ...claude, max_tokens: 10 }] },
		{ allow_modules: ["Bad Id"] },
		{ provider: "anthropic" },
	]) {
		expectStatus(await call("PUT", "/integrations/llm", bad), 422);
	}

	r = await call("POST", "/integrations/llm/test");
	expectStatus(r, 200);
	assert.equal(r.json().text, "OK");
	r = await call("POST", "/m/sorter/ask", { q: "Which account?" });
	expectStatus(r, 200);
	assert.deepEqual(r.json().data, { answer: "Which account?" });
	assert.equal(r.json().usage.input_tokens, 12);
	const sent = ai.requests.at(-1)!;
	assert.equal(sent.body.system, "Be brief.");
	assert.equal(sent.body.output_config.format.type, "json_schema");
	assert.equal(sent.headers["x-api-key"], "sk-test");
	r = await call("POST", "/m/sorter/chat", { q: "and now?" });
	assert.equal(r.json().text, "OK");
	assert.equal(ai.requests.at(-1)!.body.messages.length, 3);
	r = await call("POST", "/m/other/ask");
	expectStatus(r, 403); // not allowed
	assert.match(r.json().error.message, /allow it under Settings → LLM API/);

	// Images need a connection for images.
	r = await call("POST", "/m/sorter/look", { q: "what is this?" });
	expectStatus(r, 409);
	assert.match(r.json().error.message, /images/);
	// A second connection, a local vision model, answers requests with pictures; the key of "main" is kept.
	const { api_key: _key, ...claudeNoKey } = claude;
	r = await call("PUT", "/integrations/llm", {
		connections: [claudeNoKey, { id: "vision", name: "Local vision", provider: "ollama", model: "qwen2.5vl:7b", base_url: ai.base, uses: ["images"] }],
	});
	expectStatus(r, 200);
	assert.equal(r.json().config.images_configured, true);
	assert.equal(r.json().config.connections[0].has_api_key, true);
	r = await call("POST", "/m/sorter/look", { q: "what is this?" });
	expectStatus(r, 200);
	let last = ai.requests.at(-1)!;
	assert.equal(last.path, "/api/chat");
	assert.deepEqual(last.body.messages.at(-1).images, ["iVBORw0KGgo="]);
	assert.equal((await call("POST", "/m/sorter/ask", { q: "text?" })).json().data.answer, "text?");
	assert.equal(ai.requests.at(-1)!.path, "/v1/messages", "text still goes to Claude");
	// A module can pick a connection by id: pictures to Claude.
	r = await call("POST", "/m/sorter/look", { q: "and Claude?", connection: "main" });
	expectStatus(r, 200);
	last = ai.requests.at(-1)!;
	assert.equal(last.path, "/v1/messages");
	assert.equal(last.body.messages.at(-1).content[0].type, "image");
	expectStatus(await call("POST", "/m/sorter/look", { q: "x", connection: "nope" }), 409);
	expectStatus(await call("POST", "/integrations/llm/test", { connection: "vision" }), 200);
	assert.equal(ai.requests.at(-1)!.path, "/api/chat");
	const status = (await call("GET", "/m/sorter/status")).json();
	assert.equal(status.configured, true);
	assert.equal(status.provider, "anthropic");
	assert.deepEqual(status.images, { configured: true, provider: "ollama", model: "qwen2.5vl:7b" });
	assert.equal(status.readsPdf, false);
	assert.deepEqual(status.connections.map((x: any) => x.id), ["main", "vision"]);

	// OpenAI-compatible servers get pictures as data URLs.
	await call("PUT", "/integrations/llm", { connections: [claudeNoKey, { id: "vision", name: "LM Studio", provider: "openai", model: "local-vl", base_url: ai.base + "/v1", uses: ["images"] }] });
	r = await call("POST", "/m/sorter/look", { q: "compatible?" });
	expectStatus(r, 200);
	last = ai.requests.at(-1)!;
	assert.equal(last.path, "/v1/chat/completions");
	assert.equal(last.body.messages.at(-1).content[1].image_url.url, "data:image/png;base64,iVBORw0KGgo=");

	// Usage per module and connection.
	r = await call("GET", "/integrations/llm");
	const usage = Object.fromEntries(r.json().usage.last_30_days.map((u: any) => [u.source, [u.calls, u.failed]]));
	// Only calls that reach a provider are logged (not the refused ones).
	assert.deepEqual(usage, { sorter: [6, 0], ledger: [2, 0] });
	assert.equal(r.json().usage.recent[0].connection, "vision");
});

test("LLM API settings from Ledger 0.11.1 become one connection", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call } = ta;
	await mkdir(app.integrations.dir, { mode: 0o700 });
	await writeFile(path.join(app.integrations.dir, "llm.json"), JSON.stringify({ provider: "anthropic", model: "claude-haiku-5-5", base_url: "", api_key: "sk-old", effort: "medium", max_tokens: 8000, allow_modules: ["x-mod"] }));
	const r = await call("GET", "/integrations/llm");
	expectStatus(r, 200);
	const cfg = r.json().config;
	assert.equal(cfg.connections.length, 1);
	assert.deepEqual(
		{ ...cfg.connections[0], configured: undefined },
		{ id: "main", name: "Main", provider: "anthropic", model: "claude-haiku-5-5", base_url: "", effort: "medium", max_tokens: 8000, uses: ["text", "images"], has_api_key: true, configured: undefined },
	);
	assert.deepEqual(cfg.allow_modules, ["x-mod"]);
	assert.equal(cfg.images_configured, true);
});

test("Gmail shared with modules", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call } = ta;
	const g = await fakeGmail(t);
	app.integrations.gmail = { auth: g.base, oauth: g.base, gmail: g.base };
	await mkdir(app.integrations.dir, { mode: 0o700 });
	await loadModules(t, app, {
		bills: `export default function (ctx) {
			ctx.route("GET", "/status", () => ctx.gmail.status());
			ctx.route("GET", "/bills", () => ctx.gmail.search("bill newer_than:30d", { max: 10 }));
			ctx.route("GET", "/msg/:id", async (req) => {
				const m = await ctx.gmail.message(req.params.id);
				const pdf = await ctx.gmail.attachment(m.id, m.attachments[0].attachmentId);
				const raw = await ctx.gmail.raw(m.id);
				return { ...m, pdf: pdf.toString(), raw: raw.toString() };
			});
			ctx.route("POST", "/send", () => ctx.gmail.send({ to: "client@example.com", subject: "Invoice 31 — €", text: "Hi", html: "<p>Hi</p>",
				attachments: [{ filename: "inv.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1") }] }));
			ctx.route("POST", "/send-bad", () => ctx.gmail.send({ to: "not an address", subject: "x", text: "y" }));
		}`,
	});

	let r = await call("GET", "/m/bills/status");
	assert.deepEqual(r.json(), { connected: false, account: "", canRead: false, canSend: false });
	expectStatus(await call("GET", "/m/bills/bills"), 409);
	expectStatus(await call("POST", "/integrations/gmail/start"), 409); // no client yet

	r = await call("PUT", "/integrations/gmail", { client_id: "123-abc.apps.googleusercontent.com", client_secret: "gsecret" });
	expectStatus(r, 200);
	assert.equal(r.json().config.has_client_secret, true);
	assert.equal(JSON.stringify(r.json()).includes("gsecret"), false);
	// Connect read-only first (the user unticks sending on Google's page)...
	const connect = async (grantSend: boolean) => {
		g.grantSend = grantSend;
		const s = await call("POST", "/integrations/gmail/start", { send: true });
		expectStatus(s, 200);
		const a = new URL(s.json().auth_url);
		g.lastChallenge = a.searchParams.get("code_challenge")!;
		return call("POST", "/integrations/gmail/finish", { url: `http://127.0.0.1/?state=${a.searchParams.get("state")}&code=good-code` });
	};
	r = await connect(false);
	expectStatus(r, 200);
	assert.deepEqual([r.json().config.connected, r.json().config.can_send], [true, false]);
	// ...then allow sending without disconnecting.
	r = await connect(true);
	expectStatus(r, 200);
	assert.deepEqual([r.json().config.connected, r.json().config.can_send], [true, true]);
	assert.deepEqual(g.revoked, []); // the earlier grant isn't revoked (that would revoke the new one too)

	r = await call("POST", "/integrations/gmail/start", { send: true });
	expectStatus(r, 200);
	const auth = new URL(r.json().auth_url);
	assert.equal(auth.searchParams.get("redirect_uri"), "http://127.0.0.1");
	assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
	assert.match(auth.searchParams.get("scope")!, /gmail\.readonly .*gmail\.send/);
	g.lastChallenge = auth.searchParams.get("code_challenge")!;
	const state = auth.searchParams.get("state")!;
	// Pasting an address from another attempt, or a bad code, is refused.
	expectStatus(await call("POST", "/integrations/gmail/finish", { url: `http://127.0.0.1/?state=other&code=good-code` }), 422);
	expectStatus(await call("POST", "/integrations/gmail/finish", { url: `http://127.0.0.1/?state=${state}&code=bad-code` }), 422);
	r = await call("POST", "/integrations/gmail/finish", { url: `http://127.0.0.1/?state=${state}&code=good-code&scope=x` });
	expectStatus(r, 200);
	assert.deepEqual([r.json().config.connected, r.json().config.account, r.json().config.can_send], [true, "me@example.com", true]);

	// Connected, but the module isn't allowed yet.
	r = await call("GET", "/m/bills/bills");
	expectStatus(r, 403);
	assert.match(r.json().error.message, /allowed to read mail/);
	await call("PUT", "/integrations/gmail", { allow_read: ["bills"] });
	r = await call("GET", "/m/bills/bills");
	expectStatus(r, 200);
	assert.deepEqual(r.json().messages.map((m: any) => [m.id, m.from, m.subject]), [
		["m1", "Hydro <bills@hydro.example>", "Your bill m1"],
		["m2", "Hydro <bills@hydro.example>", "Your bill m2"],
	]);
	assert.equal(r.json().nextPageToken, "p2");
	r = await call("GET", "/m/bills/msg/m1");
	assert.deepEqual([r.json().text, r.json().html, r.json().attachments[0].filename, r.json().pdf], ["Amount due: $42.00", "<p>Amount due</p>", "bill.pdf", "%PDF"]);
	assert.match(r.json().raw, /Amount due: \$42.00/);
	expectStatus(await call("GET", "/m/bills/msg/..%2Fx"), 422);

	expectStatus(await call("POST", "/m/bills/send"), 403); // reading allowed, sending not
	await call("PUT", "/integrations/gmail", { allow_send: ["bills"] });
	r = await call("POST", "/m/bills/send");
	expectStatus(r, 200);
	assert.deepEqual(r.json(), { id: "sent1", threadId: "st1" });
	const mime = g.sent[0]!;
	assert.match(mime, /^To: client@example.com\r\n/);
	assert.match(mime, /Subject: =\?UTF-8\?B\?/); // non-ASCII subject encoded
	assert.match(mime, /multipart\/mixed[\s\S]*multipart\/alternative[\s\S]*filename="inv.pdf"/);
	expectStatus(await call("POST", "/m/bills/send-bad"), 422);
	assert.deepEqual((await call("GET", "/m/bills/status")).json(), { connected: true, account: "me@example.com", canRead: true, canSend: true });

	r = await call("POST", "/integrations/gmail/disconnect");
	assert.equal(r.json().config.connected, false);
	assert.deepEqual(g.revoked, ["ref-1"]);
	expectStatus(await call("GET", "/m/bills/bills"), 409);
});

test("journal list can hide reversed entries", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { call } = ta;
	await createAccount(ta, "1000", "Bank", "asset", "CAD");
	await createAccount(ta, "4000", "Sales", "revenue", "CAD");
	for (const d of ["Kept", "Mistake"]) expectStatus(await call("POST", "/journal-entries", entry("2026-10-01", d, dr("1000", 100), cr("4000", 100))), 201);
	expectStatus(await call("POST", "/journal-entries/2/reverse", { entry_date: "2026-10-02" }), 201);
	const list = async (q: string) => (await call("GET", `/journal-entries${q}`)).json().data.map((e: any) => e.description);
	assert.equal((await list("")).length, 3);
	assert.deepEqual(await list("?hide_reversed=true"), ["Kept"]);
	assert.equal((await list("?hide_reversed=false")).length, 3);
	expectStatus(await call("GET", "/journal-entries?hide_reversed=maybe"), 422);
});

test("modules hand files to each other", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call } = ta;
	await loadModules(t, app, {
		downloads: `export default function (ctx) {
			ctx.route("GET", "/targets", (req) => ctx.files.targets(req.query.get("kind") || undefined));
			ctx.route("POST", "/send", (req) => ctx.files.send({ to: req.body.to, kind: req.body.kind, filename: "oct.csv", contentType: "text/csv",
				data: Buffer.from("date,amount\\n2026-10-01,12.50\\n"), meta: { account_code: "1000" }, note: "October statement" }, req.user));
			ctx.route("GET", "/outbox", () => ctx.files.outbox());
			ctx.route("GET", "/peek/:id", async (req) => (await ctx.files.get(req.params.id)).data.toString());
			ctx.route("DELETE", "/withdraw/:id", (req) => ctx.files.remove(req.params.id));
		}`,
		autosort: {
			manifest: { files: { accepts: ["statement", "bill"] } },
			code: `let got = [];
			export default function (ctx) {
				ctx.files.onReceive((f) => { got.push(f.id + ":" + f.kind + ":" + f.filename); });
				ctx.route("GET", "/got", () => got);
				ctx.route("GET", "/inbox", (req) => ctx.files.inbox({ status: req.query.get("status") || undefined }));
				ctx.route("POST", "/take/:id", async (req) => {
					const f = await ctx.files.get(req.params.id);
					return ctx.files.update(f.id, { status: "done", result: "12 transactions, " + f.data.length + " bytes" });
				});
			}`,
		},
	});

	let r = await call("GET", "/m/downloads/targets?kind=statement");
	assert.deepEqual(r.json(), [{ id: "autosort", name: "AUTOSORT", accepts: ["statement", "bill"] }]);
	assert.deepEqual((await call("GET", "/m/downloads/targets?kind=receipt")).json(), []);
	expectStatus(await call("GET", "/m/downloads/targets?kind=photo"), 422);

	r = await call("POST", "/m/downloads/send", { to: "autosort", kind: "statement" });
	expectStatus(r, 200);
	const id = r.json().id;
	assert.deepEqual([r.json().status, r.json().size_bytes, r.json().sent_by, r.json().meta], ["new", 29, "tester", { account_code: "1000" }]);
	await new Promise((res) => setTimeout(res, 50));
	assert.deepEqual((await call("GET", "/m/autosort/got")).json(), [`${id}:statement:oct.csv`]);
	// Kinds the receiver doesn't take, unknown or non-receiving modules are refused.
	expectStatus(await call("POST", "/m/downloads/send", { to: "autosort", kind: "receipt" }), 409);
	expectStatus(await call("POST", "/m/downloads/send", { to: "downloads", kind: "statement" }), 409);
	expectStatus(await call("POST", "/m/downloads/send", { to: "nope", kind: "bill" }), 409);
	expectStatus(await call("POST", "/m/downloads/send", { to: "autosort", kind: "photo" }), 422);

	r = await call("GET", "/m/autosort/inbox?status=new");
	assert.deepEqual(r.json().map((f: any) => [f.id, f.sender, f.kind, f.note]), [[id, "downloads", "statement", "October statement"]]);
	assert.equal(r.json()[0].data, undefined); // listings carry no bytes
	r = await call("POST", `/m/autosort/take/${id}`);
	assert.deepEqual([r.json().status, r.json().result], ["done", "12 transactions, 29 bytes"]);
	r = await call("GET", "/m/downloads/outbox");
	assert.deepEqual(r.json().map((f: any) => [f.recipient, f.status, f.result]), [["autosort", "done", "12 transactions, 29 bytes"]]);
	assert.equal((await call("GET", `/m/downloads/peek/${id}`)).json(), "date,amount\n2026-10-01,12.50\n");
	// Only the receiver changes the status; the sender can't withdraw a file already taken.
	expectStatus(await call("DELETE", `/m/downloads/withdraw/${id}`), 409);
	expectStatus(await call("GET", "/m/downloads/peek/999"), 404);
	// No journal entries were posted.
	assert.equal(await ta.countRows("journal_entries"), 0);
});

test("organizations keep books apart", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call, request } = ta;
	const loginAs = async (username: string, password: string) => {
		const r = await request("POST", "/api/v1/auth/login", { body: { username, password } });
		expectStatus(r, 200);
		const cookie = `${SESSION_COOKIE}=${sessionFrom(r).value}`;
		return (method: string, p: string, body?: unknown) => request(method, "/api/v1" + p, { body, cookie });
	};

	// A new user with personal books of their own and a starter chart.
	let r = await call("POST", "/users", {
		username: "sam",
		password: "sam-password",
		role: "admin",
		organization: { mode: "new", name: "Sam's books", kind: "personal", chart: "CAD" },
	});
	expectStatus(r, 201);
	assert.equal(r.json().role, "none");
	assert.equal(r.json().server_admin, false);
	const samOrg = r.json().organizations[0];
	assert.deepEqual({ ...samOrg, id: 0 }, { id: 0, name: "Sam's books", kind: "personal", status: "ready", role: "admin" });

	const sam = await loginAs("sam", "sam-password");
	r = await sam("GET", "/auth/me");
	expectStatus(r, 200);
	assert.equal(r.json().organization.name, "Sam's books");
	assert.equal(r.json().role, "admin");
	assert.equal(r.json().server_admin, false);
	assert.equal(r.json().organizations.length, 1);
	const samAccounts = (await sam("GET", "/accounts")).json().data;
	assert.ok(samAccounts.some((a: any) => a.name === "Groceries" && a.currency === "CAD"), JSON.stringify(samAccounts));
	assert.equal((await call("GET", "/accounts")).json().data.length, 0, "the main books stay empty");

	// Entries stay in their own books.
	r = await sam("POST", "/journal-entries", {
		entry_date: "2026-11-01",
		description: "Groceries",
		lines: [
			{ account_code: "5100", debit_cents: 4250 },
			{ account_code: "1000", credit_cents: 4250 },
		],
	});
	expectStatus(r, 201);
	assert.equal((await sam("GET", "/journal-entries")).json().data.length, 1);
	assert.equal((await call("GET", "/journal-entries")).json().data.length, 0);

	// Running the server stays with the main books' admins.
	expectStatus(await sam("GET", "/users"), 403);
	expectStatus(await sam("POST", "/organizations", { name: "Mine", kind: "business" }), 403);
	expectStatus(await sam("GET", "/system/update"), 403);

	// Someone added to an existing organization sees its books.
	r = await call("POST", "/users", { username: "kim", password: "kim-password", role: "viewer", organization: { mode: "existing", organization_id: samOrg.id } });
	expectStatus(r, 201);
	const kim = await loginAs("kim", "kim-password");
	assert.equal((await kim("GET", "/accounts")).json().data.length, samAccounts.length);
	expectStatus(await kim("POST", "/accounts", { code: "9", name: "x", type: "asset", currency: "CAD" }), 403);

	// An admin of the main books can join it too, and switch between books.
	expectStatus(await call("PUT", `/users/tester/organizations/${samOrg.id}`, { role: "bookkeeper" }), 200);
	r = await call("POST", "/auth/organization", { organization_id: samOrg.id });
	expectStatus(r, 200);
	assert.equal(r.json().organization.name, "Sam's books");
	assert.equal(r.json().role, "bookkeeper");
	assert.equal(r.json().server_admin, true);
	assert.equal((await call("GET", "/journal-entries")).json().data.length, 1);
	expectStatus(await call("POST", "/auth/organization", { organization_id: 1 }), 200);
	assert.equal((await call("GET", "/journal-entries")).json().data.length, 0);
	expectStatus(await sam("POST", "/auth/organization", { organization_id: 1 }), 403);

	// Taking the only access away ends the session.
	expectStatus(await call("DELETE", `/users/kim/organizations/${samOrg.id}`), 200);
	expectStatus(await kim("GET", "/auth/me"), 401);
	r = await request("POST", "/api/v1/auth/login", { body: { username: "kim", password: "kim-password" } });
	expectStatus(r, 401);

	// Organizations created from Settings; the creator becomes its admin.
	r = await call("POST", "/organizations", { name: "Side gig", kind: "business", chart: "USD" });
	expectStatus(r, 201);
	assert.equal(r.json().status, "ready");
	assert.equal((await call("GET", "/organizations")).json().data.length, 3);
	assert.equal((await sam("GET", "/organizations")).json().data.length, 1);
	r = await call("GET", "/auth/me");
	assert.deepEqual(r.json().organizations.map((o: any) => [o.name, o.role]), [["Main books", "admin"], ["Sam's books", "bookkeeper"], ["Side gig", "admin"]]);

	// Modules work in whichever books the request is in.
	await loadModules(t, app, {
		whoami: `export default function (ctx) {
			ctx.route("GET", "/", async (req) => ({ org: (await ctx.orgs.current()).name, user: req.user.organization.name,
				accounts: (await ctx.ledger.listAccounts()).length, all: (await ctx.orgs.list()).length }));
		}`,
	});
	r = await sam("GET", "/m/whoami/");
	expectStatus(r, 200);
	assert.deepEqual(r.json(), { org: "Sam's books", user: "Sam's books", accounts: samAccounts.length, all: 3 });
	assert.deepEqual((await call("GET", "/m/whoami/")).json(), { org: "Main books", user: "Main books", accounts: 0, all: 3 });
});

test("module settings belong to each organization", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call, request } = ta;
	await loadModules(t, app, {
		greeter: {
			manifest: {
				settings: {
					fields: [
						{ key: "greeting", label: "Greeting", type: "text", default: "Hello" },
						{ key: "api_key", label: "API key", type: "secret" },
					],
				},
			},
			code: `let seen = [];
			export default function (ctx) {
				ctx.settings.onChange(async (v) => { seen.push((await ctx.orgs.current()).name + ":" + v.greeting); });
				ctx.route("GET", "/", async () => ({ greeting: (await ctx.settings.get()).greeting, seen }));
				ctx.route("GET", "/all", async () => { const out = []; await ctx.orgs.forEach(async (o) => out.push(o.name + ":" + (await ctx.settings.get()).greeting)); return out; });
			}`,
		},
	});
	let r = await call("POST", "/users", { username: "ana", password: "ana-password", role: "admin", organization: { mode: "new", name: "Ana Co", kind: "business" } });
	expectStatus(r, 201);
	r = await request("POST", "/api/v1/auth/login", { body: { username: "ana", password: "ana-password" } });
	const cookie = `${SESSION_COOKIE}=${sessionFrom(r).value}`;
	const ana = (method: string, p: string, body?: unknown) => request(method, "/api/v1" + p, { body, cookie });

	expectStatus(await call("PUT", "/modules/greeter/settings", { values: { greeting: "Bonjour", api_key: "main-secret" } }), 200);
	// Ana, an admin of her organization only, sets its own values.
	r = await ana("GET", "/modules/greeter/settings");
	expectStatus(r, 200);
	assert.equal(r.json().values.greeting, "Hello");
	assert.equal(r.json().secrets_set.api_key, false, "the main books' secret stays there");
	expectStatus(await ana("PUT", "/modules/greeter/settings", { values: { greeting: "Hola" } }), 200);

	assert.equal((await call("GET", "/m/greeter/")).json().greeting, "Bonjour");
	r = await ana("GET", "/m/greeter/");
	assert.equal(r.json().greeting, "Hola");
	assert.deepEqual(r.json().seen, ["Main books:Bonjour", "Ana Co:Hola"]);
	assert.deepEqual((await call("GET", "/m/greeter/all")).json(), ["Main books:Bonjour", "Ana Co:Hola"]);

	// Installing and removing modules stays with admins of the main books.
	expectStatus(await ana("DELETE", "/modules/greeter"), 403);
	// A viewer can't change settings.
	expectStatus(await call("POST", "/users", { username: "vic", password: "vic-password", role: "viewer", organization: { mode: "existing", organization_id: 2 } }), 201);
	r = await request("POST", "/api/v1/auth/login", { body: { username: "vic", password: "vic-password" } });
	expectStatus(await request("GET", "/api/v1/modules/greeter/settings", { cookie: `${SESSION_COOKIE}=${sessionFrom(r).value}` }), 403);
});

test("journal entries link to module records", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call } = ta;
	for (const a of [
		{ code: "1000", name: "Bank", type: "asset", currency: "CAD" },
		{ code: "4000", name: "Sales", type: "revenue", currency: "CAD" },
	]) expectStatus(await call("POST", "/accounts", a), 201);
	await loadModules(t, app, {
		sales: `export default function (ctx) {
			ctx.route("POST", "/invoice", (req) => ctx.ledger.createJournalEntry({ entry_date: "2026-11-01", description: "Invoice 31",
				lines: [{ account_code: "1000", debit_cents: 5000 }, { account_code: "4000", credit_cents: 5000 }],
				links: req.body.links }, req.user));
			ctx.route("POST", "/link/:id", (req) => ctx.ledger.linkJournalEntry(req.params.id, req.body, req.user));
			ctx.route("DELETE", "/link/:id/:ref", async (req) => ({ removed: await ctx.ledger.unlinkJournalEntry(req.params.id, req.params.ref) }));
			ctx.route("GET", "/linked", (req) => ctx.ledger.linkedEntries(req.query.get("ref") ?? undefined));
		}`,
	});
	let r = await call("POST", "/m/sales/invoice", { links: [{ ref: "invoice:31", label: "Invoice 31 · Acme", href: "/apps/sales?invoice=31" }] });
	expectStatus(r, 200);
	const id = r.json().id;
	assert.deepEqual(r.json().links.map((l: any) => [l.module_id, l.ref, l.label, l.href]), [["sales", "invoice:31", "Invoice 31 · Acme", "/apps/sales?invoice=31"]]);

	// A bad link posts nothing.
	const before = await ta.countRows("journal_entries");
	expectStatus(await call("POST", "/m/sales/invoice", { links: [{ ref: "x", label: "X", href: "https://evil.example" }] }), 422);
	expectStatus(await call("POST", "/m/sales/invoice", { links: [{ ref: "", label: "X" }] }), 422);
	assert.equal(await ta.countRows("journal_entries"), before);

	// Links added later show on the entry and in the journal.
	expectStatus(await call("POST", `/m/sales/link/${id}`, { ref: "payment:7", label: "Payment 7" }), 200);
	r = await call("GET", `/journal-entries/${id}`);
	assert.deepEqual(r.json().links.map((l: any) => l.ref), ["invoice:31", "payment:7"]);
	assert.equal((await call("GET", "/journal-entries")).json().data[0].links.length, 2);
	assert.deepEqual((await call("GET", "/m/sales/linked?ref=payment:7")).json(), [{ entry_id: id, ref: "payment:7", label: "Payment 7", href: "", reversed: false }]);

	// Reversing doesn't remove links; the module sees the entry is reversed.
	expectStatus(await call("POST", `/journal-entries/${id}/reverse`, {}), 201);
	assert.equal((await call("GET", "/m/sales/linked?ref=invoice:31")).json()[0].reversed, true);

	assert.deepEqual((await call("DELETE", `/m/sales/link/${id}/payment:7`)).json(), { removed: true });
	assert.deepEqual((await call("DELETE", `/m/sales/link/${id}/payment:7`)).json(), { removed: false });
	expectStatus(await call("POST", "/m/sales/link/999999", { ref: "a", label: "A" }), 404);
	expectStatus(await call("POST", "/m/sales/link/abc", { ref: "a", label: "A" }), 404);
});

test("backups: settings from Ledger 0.11.2 (TrueNAS folder) carry over", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call } = ta;
	await mkdir(app.backup.dir, { mode: 0o700 });
	await writeFile(path.join(app.backup.dir, "config.json"), JSON.stringify({ truenas: { enabled: true, path: "/app/csv_data/nightly", keep_days: 14 } }));
	await writeFile(path.join(app.backup.dir, "status.json"), JSON.stringify({ state: "ok", results: [{ target: "truenas", ok: true, message: "x" }], last_ok: { truenas: "2026-11-01T02:30:00.000Z", google: null } }));
	const info = (await call("GET", "/backups")).json();
	assert.equal(info.config.share.mode, "folder");
	assert.equal(info.config.share.path, "/app/csv_data/nightly");
	assert.equal(info.config.share.keep_days, 14);
	assert.equal(info.status.last_ok.share, "2026-11-01T02:30:00.000Z");
	assert.equal(info.status.results[0].target, "share");
});

// Needs a real SMB server: TEST_SMB=//127.0.0.1/backups and TEST_SMB_USER, TEST_SMB_PASSWORD.
test("backups: straight to an SMB share", async (t) => {
	const target = process.env.TEST_SMB;
	if (!target) return t.skip("TEST_SMB not set");
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call } = ta;
	await mkdir(app.backup.dir, { mode: 0o700 });
	const [, server, shareName] = /^\/\/([^/]+)\/(.+)$/.exec(target)!;
	const dir = `ledger-test-${process.pid}`;
	const smb = { enabled: true, mode: "smb", server, share: shareName, directory: `${dir}/nightly`, username: process.env.TEST_SMB_USER ?? "", password: process.env.TEST_SMB_PASSWORD ?? "", domain: "", keep_days: 7 };
	const schedule = { enabled: false, days: [1], time: "02:30", timezone: "UTC" };
	const google = { enabled: false, client_id: "", keep_count: 5 };

	let r = await call("POST", "/backups/share/test", { ...smb, password: "wrong" });
	expectStatus(r, 200);
	assert.equal(r.json().ok, false);
	assert.match(r.json().message, /user name or password is wrong/);
	r = await call("POST", "/backups/share/test", { ...smb, share: "no-such-share" });
	assert.match(r.json().message, /no share by that name/);
	r = await call("POST", "/backups/share/test", smb);
	assert.equal(r.json().ok, true, r.text);

	r = await call("PUT", "/backups/config", { schedule, share: smb, google });
	expectStatus(r, 200);
	assert.equal(r.json().config.share.has_password, true);
	assert.equal(JSON.stringify(r.json()).includes(smb.password), false);
	// Saving again without the password keeps it.
	const { password: _pw, ...noPassword } = smb;
	expectStatus(await call("PUT", "/backups/config", { schedule, share: noPassword, google }), 200);
	assert.equal((await call("POST", "/backups/share/test", noPassword)).json().ok, true);

	const dump = async (f: string) => writeFile(f, "PGDMP fake dump");
	// An old dump (10 days) is removed after a new one is saved.
	let out = await runBackup({ dir: app.backup.dir, databaseUrl: app.backup.databaseUrl, trigger: "manual", dump, now: () => Date.parse("2026-11-01T02:30:00Z") });
	assert.equal(out.status.state, "ok", out.status.message);
	out = await runBackup({ dir: app.backup.dir, databaseUrl: app.backup.databaseUrl, trigger: "manual", dump, now: () => Date.parse("2026-11-11T02:30:00Z") });
	assert.equal(out.status.state, "ok", out.status.message);
	assert.match(out.status.results[0]!.message, /removed 1 older than 7 days/);
	const info = (await call("GET", "/backups")).json();
	assert.deepEqual(info.share_files.map((f: any) => f.name), ["ledger-20261111T023000Z.dump"]);
	assert.equal(info.share_files[0].size_bytes, "PGDMP fake dump".length);
});

// ---------------------------------------------------------------------------
// Migrating from other bookkeeping software
// ---------------------------------------------------------------------------

async function uploadMigration(ta: TestApp, filename: string, text: string, useAi = true) {
	const boundary = "----mig" + Math.random().toString(16).slice(2);
	const body = Buffer.concat([
		Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="use_ai"\r\n\r\n${useAi}\r\n`),
		Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`),
		Buffer.from(text),
		Buffer.from(`\r\n--${boundary}--\r\n`),
	]);
	return ta.request("POST", "/api/v1/migrations", { rawBody: body, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, cookie: `${SESSION_COOKIE}=${ta.token}` });
}

// A QuickBooks-style "Journal" report: title rows, $ amounts, US dates.
const QB_JOURNAL = `Acme Renovations
Journal
"January 1 - March 31, 2026"

Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit
01/03/2026,Deposit,1001,,Owner investment,Chequing,"$10,000.00",
01/03/2026,Deposit,1001,,Owner investment,Owner's Equity,,"$10,000.00"
01/15/2026,Invoice,1002,Smith Co,Kitchen job,Accounts Receivable (A/R),"$5,650.00",
01/15/2026,Invoice,1002,Smith Co,Kitchen job,Sales,,"$5,000.00"
01/15/2026,Invoice,1002,Smith Co,Kitchen job,GST/HST Payable,,$650.00
02/02/2026,Expense,1003,Staples,Printer paper,Office Supplies,$42.50,
02/02/2026,Expense,1003,Staples,Printer paper,Chequing,,$42.50
,,,,,,"$15,692.50","$15,692.50"
`;

test("migration: a QuickBooks journal export, detected by column names", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { call } = ta;
	expectStatus(await call("POST", "/accounts", { code: "1000", name: "Chequing", type: "asset", currency: "CAD" }), 201);
	assert.equal((await call("GET", "/migrations")).json().ai_available, false);

	let r = await uploadMigration(ta, "Journal.csv", QB_JOURNAL);
	expectStatus(r, 201);
	let plan = r.json();
	assert.equal(plan.detection.kind, "general_ledger");
	assert.equal(plan.detection.source, "rules");
	assert.match(plan.detection.note, /No LLM connection/);
	assert.equal(plan.mapping.header_row, 3); // after the title rows (blank lines don't count)
	assert.deepEqual(
		[plan.mapping.columns.date, plan.mapping.columns.account, plan.mapping.columns.debit, plan.mapping.columns.credit, plan.mapping.columns.entry_id, plan.mapping.columns.description],
		["Date", "Account", "Debit", "Credit", "Num", "Memo/Description"],
	);
	assert.deepEqual(plan.issues.filter((i: any) => i.level === "error"), []);
	assert.equal(plan.entries.count, 3);
	assert.equal(plan.entries.from, "2026-01-03");
	assert.equal(plan.entries.to, "2026-02-02");
	const acc = Object.fromEntries(plan.accounts.map((a: any) => [a.label, [a.action, a.code, a.type]]));
	assert.deepEqual(acc["Chequing"], ["map", "1000", "asset"]); // already in Ledger
	assert.deepEqual(acc["Owner's Equity"]?.slice(0, 1).concat(acc["Owner's Equity"][2]), ["create", "equity"]);
	assert.equal(acc["Accounts Receivable (A/R)"][2], "asset");
	assert.equal(acc["Sales"][2], "revenue");
	assert.equal(acc["GST/HST Payable"][2], "liability");
	assert.equal(acc["Office Supplies"][2], "expense");

	// The user changes their mind about one account's code before importing.
	const id = plan.id;
	r = await call("POST", `/migrations/${id}/preview`, { mapping: { ...plan.mapping, accounts: { "Office Supplies": { action: "create", code: "6100", type: "expense" } } } });
	expectStatus(r, 200);
	plan = r.json();
	assert.equal(plan.accounts.find((a: any) => a.label === "Office Supplies").code, "6100");

	// Viewers can't import.
	await createUser(ta.app, "vee", "vee-password", "viewer");
	r = await ta.request("POST", "/api/v1/auth/login", { body: { username: "vee", password: "vee-password" } });
	expectStatus(await ta.request("POST", `/api/v1/migrations/${id}/import`, { body: { mapping: plan.mapping }, cookie: `${SESSION_COOKIE}=${sessionFrom(r).value}` }), 403);

	r = await call("POST", `/migrations/${id}/import`, { mapping: plan.mapping });
	expectStatus(r, 200);
	assert.equal(r.json().accounts_created, 5);
	assert.equal(r.json().entries_created, 3);
	const entries = (await call("GET", "/journal-entries")).json().data;
	assert.equal(entries.length, 3);
	assert.equal(entries.find((e: any) => e.description === "Kitchen job").totals[0].amount_cents, 565000);
	assert.equal((await call("GET", "/accounts/6100")).json().name, "Office Supplies");
	assert.equal((await call("GET", "/accounts/1000")).json().balance_cents, 995750);

	// The same file again is refused (it's gone from memory, and its content was imported).
	expectStatus(await call("POST", `/migrations/${id}/import`, { mapping: plan.mapping }), 404);
	r = await uploadMigration(ta, "Journal.csv", QB_JOURNAL);
	const again = r.json();
	expectStatus(await call("POST", `/migrations/${again.id}/import`, { mapping: again.mapping }), 409);
});

test("migration: transactions that don't balance are refused, with the rows", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const csv = "Date;Account;Debit;Credit;Transaction ID\n05.03.2026;Bank;100,00;;A1\n05.03.2026;Rent;;90,00;A1\n";
	const r = await uploadMigration(ta, "export.csv", csv);
	expectStatus(r, 201);
	const plan = r.json();
	assert.equal(plan.mapping.decimal_comma, true);
	const errors = plan.issues.filter((i: any) => i.level === "error").map((i: any) => i.message);
	assert.equal(errors.length, 1, JSON.stringify(errors));
	assert.match(errors[0], /Rows 2, 3 \(2026-03-05\): debits and credits differ by 10\.00 CAD/);
	const res = await ta.call("POST", `/migrations/${plan.id}/import`, { mapping: plan.mapping });
	expectStatus(res, 422);
	assert.equal(await ta.countRows("accounts"), 0, "nothing is written");
});

test("migration: a Xero chart of accounts, and a trial balance for opening balances", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { call } = ta;
	const coa = `*Code,*Name,*Type,*Tax Code,Description
090,Business Bank Account,Bank,Tax Exempt,
200,Sales,Revenue,GST on Income,Income from sales
400,Advertising,Expense,GST on Expenses,
610,Accounts Receivable,Current Asset,BAS Excluded,
800,Accounts Payable,Current Liability,BAS Excluded,
960,Retained Earnings,Equity,BAS Excluded,
`;
	let r = await uploadMigration(ta, "ChartOfAccounts.csv", coa);
	expectStatus(r, 201);
	let plan = r.json();
	assert.equal(plan.detection.kind, "accounts");
	assert.deepEqual([plan.mapping.columns.code, plan.mapping.columns.name, plan.mapping.columns.type], ["*Code", "*Name", "*Type"]);
	assert.deepEqual(
		plan.accounts.map((a: any) => [a.code, a.name, a.type, a.from]),
		[
			["090", "Business Bank Account", "asset", "file"],
			["200", "Sales", "revenue", "file"],
			["400", "Advertising", "expense", "file"],
			["610", "Accounts Receivable", "asset", "file"],
			["800", "Accounts Payable", "liability", "file"],
			["960", "Retained Earnings", "equity", "file"],
		],
	);
	r = await call("POST", `/migrations/${plan.id}/import`, { mapping: { ...plan.mapping, currency: "USD" } });
	expectStatus(r, 200);
	assert.equal(r.json().accounts_created, 6);
	assert.equal((await call("GET", "/accounts/200")).json().description, "Income from sales");
	assert.equal((await call("GET", "/accounts/200")).json().currency, "USD");

	// Opening balances; they don't quite balance, so the rest goes to Opening balance equity.
	const tb = "Trial Balance\nAs of December 31, 2025\n\nAccount,Debit,Credit\nBusiness Bank Account,\"12,500.00\",\nAccounts Payable,,800.00\nRetained Earnings,,\"11,000.00\"\nTOTAL,\"12,500.00\",\"11,800.00\"\n";
	r = await uploadMigration(ta, "Trial Balance.csv", tb);
	plan = r.json();
	assert.equal(plan.detection.kind, "trial_balance");
	r = await call("POST", `/migrations/${plan.id}/preview`, { mapping: { ...plan.mapping, as_of: "2025-12-31" } });
	plan = r.json();
	assert.ok(plan.issues.some((i: any) => i.level === "warning" && /Opening balance equity/.test(i.message)), JSON.stringify(plan.issues));
	assert.deepEqual(plan.issues.filter((i: any) => i.level === "error"), []);
	r = await call("POST", `/migrations/${plan.id}/import`, { mapping: plan.mapping });
	expectStatus(r, 200);
	assert.equal(r.json().entries_created, 1);
	assert.equal(r.json().accounts_created, 1); // 3900 Opening balance equity
	const e = (await call("GET", "/journal-entries")).json().data[0];
	assert.equal(e.entry_date, "2025-12-31");
	assert.equal((await call("GET", "/accounts/3900")).json().balance_cents, -70000); // a 700.00 credit (balances are debit-positive)
});

test("migration: customer lists go to a module that takes them", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call } = ta;
	const csv = "Customer,Email,Phone\nSmith Co,ap@smith.example,555-0100\nJones Ltd,,555-0101\n";
	let r = await uploadMigration(ta, "Customers.csv", csv);
	let plan = r.json();
	assert.equal(plan.detection.kind, "customers");
	assert.match(plan.issues[0].message, /No installed module accepts customer lists/);

	await loadModules(t, app, {
		sales: {
			manifest: { files: { accepts: ["customer", "bill"] } },
			code: `let got = [];
			export default function (ctx) {
				ctx.files.onReceive(async (f) => { const full = await ctx.files.get(f.id); got.push([f.sender, f.kind, f.meta.columns.name, full.data.toString().split("\\n").length]); });
				ctx.route("GET", "/got", () => got);
			}`,
		},
	});
	r = await call("POST", `/migrations/${plan.id}/preview`, {});
	plan = r.json();
	assert.deepEqual(plan.contacts, { count: 2, recipients: [{ id: "sales", name: "SALES" }] });
	r = await call("POST", `/migrations/${plan.id}/import`, { mapping: plan.mapping, recipient: "sales" });
	expectStatus(r, 200);
	assert.equal(r.json().sent_to, "sales");
	await new Promise((res) => setTimeout(res, 50));
	assert.deepEqual((await call("GET", "/m/sales/got")).json(), [["ledger", "customer", "Customer", 4]]);
});

test("migration: the AI reads a general ledger report grouped by account", async (t) => {
	const ta = await setupTestApp(t);
	if (!ta) return;
	const { app, call } = ta;
	const report = `General Ledger
Distribution account,Date,Transaction type,Num,Description,Debit,Credit,Balance
Chequing,,,,,,,
,2026-03-01,Expense,77,Coffee for clients,,15.75,-15.75
,2026-03-02,Deposit,78,Cash sale,200.00,,184.25
Total for Chequing,,,,,200.00,15.75,
Meals and Entertainment,,,,,,,
,2026-03-01,Expense,77,Coffee for clients,15.75,,15.75
Total for Meals and Entertainment,,,,,15.75,,
Sales of Product Income,,,,,,,
,2026-03-02,Deposit,78,Cash sale,,200.00,200.00
`;
	// A stand-in for Claude that answers with this detection.
	const prompts: string[] = [];
	const { createServer } = await import("node:http");
	const srv = createServer((req, res) => {
		let raw = "";
		req.on("data", (d) => (raw += d));
		req.on("end", () => {
			const body = JSON.parse(raw);
			prompts.push(body.messages[0].content);
			const answer = {
				kind: "general_ledger",
				confidence: 0.94,
				summary: "A general ledger report from QuickBooks Online, grouped by account, for March 2026.",
				software: "QuickBooks Online",
				header_row: 1,
				account_from_sections: true,
				date_format: "ymd",
				decimal_comma: false,
				currency: "CAD",
				columns: { date: "Date", account: null, debit: "Debit", credit: "Credit", amount: null, entry_id: "Num", description: "Description", reference: null, memo: null, currency: null, code: null, name: null, type: null, balance: "Balance", email: null, phone: null },
				accounts: [
					{ label: "Chequing", type: "asset", existing_code: null },
					{ label: "Meals and Entertainment", type: "expense", existing_code: null },
					{ label: "Sales of Product Income", type: "revenue", existing_code: "4000" },
				],
			};
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 900, output_tokens: 200 } }));
		});
	});
	await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
	t.after(() => srv.close());
	const base = `http://127.0.0.1:${(srv.address() as any).port}`;
	await mkdir(app.integrations.dir, { mode: 0o700 });
	expectStatus(await call("PUT", "/integrations/llm", { connections: [{ id: "main", name: "Claude", provider: "anthropic", api_key: "sk-test", base_url: base, uses: ["text"] }] }), 200);
	expectStatus(await call("POST", "/accounts", { code: "4000", name: "Sales", type: "revenue", currency: "CAD" }), 201);

	const r = await uploadMigration(ta, "General Ledger.csv", report);
	expectStatus(r, 201);
	const plan = r.json();
	assert.equal(plan.detection.source, "ai");
	assert.equal(plan.detection.software, "QuickBooks Online");
	assert.equal(plan.mapping.account_from_sections, true);
	assert.match(prompts[0]!, /File name: General Ledger\.csv/);
	assert.match(prompts[0]!, /4000, Sales, revenue/); // Ledger's accounts, for matching
	assert.deepEqual(plan.issues.filter((i: any) => i.level === "error"), []);
	const acc = Object.fromEntries(plan.accounts.map((a: any) => [a.label, [a.action, a.code, a.type, a.from]]));
	assert.deepEqual(acc["Sales of Product Income"], ["map", "4000", "revenue", "ledger"]); // the AI matched it
	assert.deepEqual(acc["Meals and Entertainment"].slice(2), ["expense", "ai"]);
	assert.equal(plan.entries.count, 2);
	// Nothing is written until the user imports.
	assert.equal(await ta.countRows("journal_entries"), 0);
	const res = await call("POST", `/migrations/${plan.id}/import`, { mapping: plan.mapping });
	expectStatus(res, 200);
	assert.equal(res.json().entries_created, 2);
	assert.equal(res.json().accounts_created, 2);
	// Without AI, the same file still gets a sensible guess.
	const noAi = (await uploadMigration(ta, "General Ledger.csv", report, false)).json();
	assert.equal(noAi.detection.source, "rules");
	assert.equal(noAi.mapping.account_from_sections, true);
});
