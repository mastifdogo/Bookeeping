// Login rate limiting, in memory. Three limits apply: per client IP +
// username, per username from any address (so a short PIN cannot be guessed
// by spreading attempts over many devices), and per address whatever the
// username (so one client cannot work through a list of names).
//
// An attempt is counted from the moment it starts (begin), not when its
// password check finishes: requests sent all at once cannot each slip under
// the limit while the others are still being checked.

export const LOGIN_MAX_FAILURES = 10; // per IP + username
export const LOGIN_MAX_FAILURES_PER_USER = 30; // per username, all addresses
export const LOGIN_MAX_FAILURES_PER_IP = 100; // per address, all usernames
export const LOGIN_WINDOW_MS = 15 * 60_000;
/** Password checks running at once, server-wide: each takes real CPU time. */
export const LOGIN_MAX_CONCURRENT = 8;

export class LoginLimiter {
	private failures = new Map<string, number[]>();
	/** Attempts whose password is still being checked. */
	private pending = new Map<string, number>();
	private readonly max: number;

	constructor(max = LOGIN_MAX_FAILURES) {
		this.max = max;
	}

	private recent(key: string, now: number): number[] {
		const kept = (this.failures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
		if (kept.length === 0) this.failures.delete(key);
		else this.failures.set(key, kept);
		return kept;
	}

	allowed(key: string): boolean {
		return this.recent(key, Date.now()).length + (this.pending.get(key) ?? 0) < this.max;
	}

	/** Starts an attempt if the limit allows it: its place is taken until end(). */
	begin(key: string): boolean {
		if (!this.allowed(key)) return false;
		this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
		return true;
	}

	/** Finishes an attempt begun with begin(): "failed" counts against the limit, "ok" clears it. */
	end(key: string, outcome: "failed" | "ok" | "error"): void {
		const n = (this.pending.get(key) ?? 1) - 1;
		if (n > 0) this.pending.set(key, n);
		else this.pending.delete(key);
		if (outcome === "failed") this.fail(key);
		else if (outcome === "ok") this.reset(key);
	}

	fail(key: string): void {
		const now = Date.now();
		this.failures.set(key, [...this.recent(key, now), now]);
		// Bound memory if someone sprays many usernames.
		if (this.failures.size > 10_000) {
			for (const k of [...this.failures.keys()]) this.recent(k, now);
		}
	}

	reset(key: string): void {
		this.failures.delete(key);
	}
}
