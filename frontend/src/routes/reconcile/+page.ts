import { redirect } from "@sveltejs/kit";
import { api, unwrapLoad } from "#lib/api/client.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, url }) => {
  const client = api(fetch);
  const [accounts, recs, statements] = await Promise.all([
    client.GET("/accounts").then(unwrapLoad),
    client.GET("/reconciliations").then(unwrapLoad),
    client
      .GET("/documents", {
        params: { query: { kind: "statement", limit: 200 } },
      })
      .then(unwrapLoad),
  ]);
  const q = url.searchParams;
  // With a reconciliation in progress the tab opens on the most recently started one; "?list" shows this page.
  if (!q.has("list") && !q.has("finished") && !q.has("account")) {
    const open = recs.data
      .filter((r) => r.status === "open")
      .sort(
        (a, b) =>
          String(b.created_at).localeCompare(String(a.created_at)) ||
          b.id - a.id,
      )[0];
    if (open) redirect(307, `/reconcile/${open.id}`);
  }
  return {
    accounts: accounts.data.filter((a) => !a.hidden),
    reconciliations: recs.data,
    statements: statements.data,
    preselect: q.get("account") ?? "",
    finished: Number(q.get("finished")) || null,
  };
};
