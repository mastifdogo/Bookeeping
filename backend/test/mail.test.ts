// The mail clients over STARTTLS with a certificate the server made itself,
// which is how Proton Mail Bridge offers IMAP and SMTP.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import tls from "node:tls";
import { ImapClient, smtpCheck, smtpSend } from "../src/mail-client.ts";

function selfSigned(): { key: Buffer; cert: Buffer } | null {
	const dir = mkdtempSync(path.join(tmpdir(), "ledger-cert-"));
	try {
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=127.0.0.1", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore" });
		return { key: readFileSync(path.join(dir, "k.pem")), cert: readFileSync(path.join(dir, "c.pem")) };
	} catch {
		return null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A line-based server that switches to TLS when asked; `answer` returns the reply to each line. */
async function startTlsServer(t: TestContext, pem: { key: Buffer; cert: Buffer }, greeting: string, answer: (line: string, secure: boolean) => string | "tls:" | `tls:${string}`): Promise<number> {
	const server = net.createServer((plain) => {
		let sock: net.Socket = plain;
		let secure = false;
		let buf = "";
		const onData = (d: Buffer) => {
			buf += d.toString("latin1");
			let i;
			while ((i = buf.indexOf("\r\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				const reply = answer(line, secure);
				if (reply.startsWith("tls:")) {
					plain.removeListener("data", onData);
					plain.write(reply.slice(4));
					sock = new tls.TLSSocket(plain, { isServer: true, key: pem.key, cert: pem.cert });
					sock.on("data", onData);
					sock.on("error", () => undefined);
					secure = true;
				} else sock.write(reply);
			}
		};
		plain.on("data", onData);
		plain.on("error", () => undefined);
		plain.write(greeting);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	t.after(() => new Promise((r) => server.close(() => r(undefined))));
	return (server.address() as AddressInfo).port;
}

test("IMAP and SMTP over STARTTLS with a self-made certificate", async (t) => {
	const pem = selfSigned();
	if (!pem) return t.skip("openssl is not installed");

	const imapPort = await startTlsServer(t, pem, "* OK ready\r\n", (line, secure) => {
		const [tag, cmd] = line.split(" ");
		if (cmd === "STARTTLS") return `tls:${tag} OK begin TLS\r\n`;
		if (!secure) return `${tag} BAD use STARTTLS first\r\n`;
		if (cmd === "LOGIN") return line.endsWith('"me@proton.me" "bridge-pass"') ? `${tag} OK in\r\n` : `${tag} NO wrong\r\n`;
		if (cmd === "EXAMINE") return `* 3 EXISTS\r\n${tag} OK [UIDVALIDITY 11] [READ-ONLY] done\r\n`;
		if (cmd === "LOGOUT") return `* BYE\r\n${tag} OK bye\r\n`;
		return `${tag} BAD unknown\r\n`;
	});
	const server = { host: "127.0.0.1", port: imapPort, security: "starttls" as const, timeoutMs: 5000 };
	// The certificate isn't signed by anyone: refused unless the admin said to trust it.
	const strict = new ImapClient(server);
	await assert.rejects(strict.connect(), /could not secure the connection/);
	strict.close();
	const imap = new ImapClient({ ...server, trustCertificate: true });
	await imap.connect();
	await assert.rejects(imap.login("me@proton.me", "nope"), /refused the login/);
	await imap.login("me@proton.me", "bridge-pass");
	assert.deepEqual(await imap.examine("INBOX"), { uidvalidity: 11, exists: 3 });
	await imap.logout();
	imap.close();

	const got: string[] = [];
	let data = false;
	const smtpPort = await startTlsServer(t, pem, "220 ready\r\n", (line, secure) => {
		if (data) {
			if (line !== ".") {
				got.push(line);
				return "";
			}
			data = false;
			return "250 queued\r\n";
		}
		if (line.startsWith("EHLO")) return secure ? "250-hi\r\n250 AUTH LOGIN\r\n" : "250-hi\r\n250 STARTTLS\r\n";
		if (line === "STARTTLS") return "tls:220 go\r\n";
		if (!secure) return "530 use STARTTLS first\r\n";
		if (line === "AUTH LOGIN") return "334 VXNlcm5hbWU6\r\n";
		if (line === Buffer.from("me@proton.me").toString("base64")) return "334 UGFzc3dvcmQ6\r\n";
		if (line === Buffer.from("bridge-pass").toString("base64")) return "235 ok\r\n";
		if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) return "250 ok\r\n";
		if (line === "DATA") {
			data = true;
			return "354 go\r\n";
		}
		if (line === "QUIT") return "221 bye\r\n";
		return "535 no\r\n";
	});
	const smtp = { host: "127.0.0.1", port: smtpPort, security: "starttls" as const, trustCertificate: true, timeoutMs: 5000 };
	await smtpCheck(smtp, "me@proton.me", "bridge-pass");
	await assert.rejects(smtpCheck(smtp, "me@proton.me", "nope"), /refused the login/);
	await assert.rejects(smtpCheck({ ...smtp, trustCertificate: false }, "me@proton.me", "bridge-pass"), /could not secure the connection/);
	await smtpSend(smtp, "me@proton.me", "bridge-pass", "me@proton.me", ["Ann <ann@example.com>"], Buffer.from("Subject: hi\r\n\r\nline\r\n.starts with a dot\r\n"));
	assert.deepEqual(got, ["Subject: hi", "", "line", "..starts with a dot"]);
});
