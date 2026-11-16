import { api, unwrapLoad } from "#lib/api/client.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch }) => {
  return { actions: unwrapLoad(await api(fetch).GET("/root-actions")).data };
};
