// Ledger loads this file at startup and calls register(ctx).
// The API it gets is described in docs/MODULES.md.

/** @param {import("../../../backend/src/module-host.ts").ModuleContext} ctx */
export default async function register(ctx) {
	const notes = `${ctx.schema}.notes`; // tables live in the module's own schema

	// GET /api/v1/m/hello/summary
	ctx.route("GET", "/summary", async () => {
		const accounts = await ctx.ledger.listAccounts();
		const tb = await ctx.ledger.trialBalance();
		return {
			accounts: accounts.length,
			// Money is integer cents (bigint); it is sent as exact JSON numbers.
			totals: tb.totals.map((t) => ({ currency: t.currency, debit_cents: t.debit_cents })),
		};
	});

	// GET /api/v1/m/hello/notes
	ctx.route("GET", "/notes", async () => {
		const { rows } = await ctx.db.query(`SELECT id, body, created_by, created_at FROM ${notes} ORDER BY id DESC LIMIT 50`);
		return { data: rows };
	});

	// POST /api/v1/m/hello/notes  {"body": "..."}
	ctx.route("POST", "/notes", async (req) => {
		const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
		if (body === "" || body.length > 500) throw new ctx.HttpError(422, "body must be 1-500 characters");
		const { rows } = await ctx.db.query(`INSERT INTO ${notes} (body, created_by) VALUES ($1, $2) RETURNING id, body, created_by, created_at`, [
			body,
			req.user.username,
		]);
		// Tick off the to-do posted below, and tell the dashboard. The same key
		// replaces the previous notification instead of piling them up.
		await ctx.dashboard.complete("first-note");
		await ctx.dashboard.notify({ key: "latest-note", title: `${req.user.username} wrote a note`, body, link: "/apps/hello" });
		return ctx.response(201, rows[0]);
	});

	// DELETE /api/v1/m/hello/notes/:id
	ctx.route("DELETE", "/notes/:id", async (req) => {
		const { rowCount } = await ctx.db.query(`DELETE FROM ${notes} WHERE id = $1`, [req.params.id]);
		if (rowCount === 0) throw new ctx.HttpError(404, "no such note");
	});

	// A to-do on Ledger's dashboard until the first note is written.
	const { rows } = await ctx.db.query(`SELECT count(*)::int AS n FROM ${notes}`);
	if (rows[0].n === 0) await ctx.dashboard.todo({ key: "first-note", title: "Write your first note in the Hello module", link: "/apps/hello" });

	ctx.log.info("hello module ready");
}
