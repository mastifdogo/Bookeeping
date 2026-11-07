// Ledger loads this file at startup and calls register(ctx).
// API: docs/MODULE_LLM_CONTEXT.md in the Ledger repository.

/** @param {any} ctx */
export default async function register(ctx) {
	const items = `${ctx.schema}.items`; // tables live in the module's own schema

	// GET /api/v1/m/__ID__/items
	ctx.route("GET", "/items", async () => {
		const { rows } = await ctx.db.query(`SELECT id, name, created_by, created_at FROM ${items} ORDER BY id DESC LIMIT 100`);
		return { data: rows };
	});

	// POST /api/v1/m/__ID__/items  {"name": "..."}
	ctx.route("POST", "/items", async (req) => {
		const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
		if (name === "" || name.length > 200) throw new ctx.HttpError(422, "name must be 1-200 characters");
		const { rows } = await ctx.db.query(`INSERT INTO ${items} (name, created_by) VALUES ($1, $2) RETURNING id, name, created_by, created_at`, [
			name,
			req.user.username,
		]);
		return ctx.response(201, rows[0]);
	});

	// DELETE /api/v1/m/__ID__/items/:id
	ctx.route("DELETE", "/items/:id", async (req) => {
		if (!/^\d+$/.test(req.params.id)) throw new ctx.HttpError(404, "no such item");
		const { rowCount } = await ctx.db.query(`DELETE FROM ${items} WHERE id = $1`, [req.params.id]);
		if (rowCount === 0) throw new ctx.HttpError(404, "no such item");
	});

	ctx.log.info("__ID__ module ready");
}
