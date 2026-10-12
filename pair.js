import express from "express";
import fs from "fs";
import pino from "pino";
import crypto from "crypto";
import QRCode from "qrcode"; // npm install qrcode
import AdmZip from "adm-zip"; // npm install adm-zip
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";
import { sendWithBanner } from "./sendBanner.js";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

const API_PASSWORD = process.env.API_PASSWORD || "passcode2026";
const SESSION_PREFIX = "Emmy-Frosh-AI:~";
const BACKUPS_DIR = join(__dirname, "backups");
const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — zips older than this get swept

function ensureBackupsDir() {
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

// ✅ FIX: this used to base64-encode the ENTIRE creds.json and hand that
// whole blob back as the "session ID" — index.js's restore logic
// (restoreSessionFromServerZip) was ALREADY written expecting a short
// 32-hex-char ID that it looks up via GET /code/restore?id=..., but
// nothing here ever actually stored a backup server-side or served that
// route. This zips the whole session folder, saves it under a random
// 32-hex-char ID in BACKUPS_DIR, and returns just that short ID — which
// is what index.js can actually consume.
function createSessionBackup(sessionDir) {
    ensureBackupsDir();
    const backupId = crypto.randomBytes(16).toString("hex"); // 32 hex chars
    const zip = new AdmZip();
    zip.addLocalFolder(sessionDir);
    zip.writeZip(join(BACKUPS_DIR, `${backupId}.zip`));
    return backupId;
}

async function generateShortSession(sessionDir) {
    try {
        const backupId = createSessionBackup(sessionDir);
        return { sessionId: `${SESSION_PREFIX}${backupId}` };
    } catch (error) {
        console.error("Error generating short session:", error);
        return null;
    }
}

// Periodic sweep so old backup zips don't accumulate forever on disk —
// same pattern as index.js's tmp-folder cleanup.
setInterval(() => {
    try {
        if (!fs.existsSync(BACKUPS_DIR)) return;
        const now = Date.now();
        for (const file of fs.readdirSync(BACKUPS_DIR)) {
            const fp = join(BACKUPS_DIR, file);
            try {
                if (now - fs.statSync(fp).mtimeMs > BACKUP_MAX_AGE_MS) fs.rmSync(fp, { force: true });
            } catch {}
        }
    } catch {}
}, 60 * 60 * 1000); // hourly

/* ===== HELPERS ===== */
function rm(p) {
    try {
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    } catch (e) {
        console.log("Cleanup error:", e);
    }
}

// ✅ FIX: replaces every `process.exit()` call that used to run after a
// pairing finished (success OR failure). process.exit() kills the ENTIRE
// Node process — but pair.js's router is mounted inside index.js's
// Express app, so they share one process. Every successful pairing was
// silently taking the whole site down with it, which is why the site
// "went off" every single time someone paired. This just closes the one
// WhatsApp socket for this pairing session instead, leaving the server
// (and everyone else's ability to pair) untouched.
function closeSocket(sock) {
    try {
        sock?.ws?.close();
    } catch (e) {
        console.error("[SESSION] Error closing socket:", e.message);
    }
}

/* ===== SHARED: send session + bot-info messages once connected =====
   Used by BOTH the pair-code flow and the QR flow, so the fix only has
   to live in one place. Always resolves the JID from sock.user.id (the
   account Baileys actually confirms you're logged in as) instead of
   rebuilding it from a phone number — this is what was silently sending
   your session to the wrong/mismatched JID before, regardless of whether
   you connected via pairing code or QR scan.
*/
async function deliverSession(sock, dir) {
    // Give the socket time to finish registering keys before sending —
    // sending too soon after "open" can silently drop the message.
    await delay(3000);

    const sessionInfo = await generateShortSession(dir);
    if (!sessionInfo) {
        throw new Error("Failed to generate session");
    }

    const jid = jidNormalizedUser(sock.user.id);
    console.log("[SESSION] Sending session to JID:", jid);

    const sendResult = await sendWithBanner(sock, jid, sessionInfo.sessionId);
    console.log("[SESSION] Session message send result:", sendResult?.key?.id || sendResult);

    await delay(1000);

    const fakeVCardQuoted = {
        key: {
            fromMe: false,
            participant: "0@s.whatsapp.net",
            remoteJid: "status@broadcast"
        },
        message: {
            contactMessage: {
                displayName: "© EMMYFROSH-AI",
                vcard: `BEGIN:VCARD
VERSION:3.0
FN:© EMMYFROSH-AI
ORG:EmmyFrosh-AI Official;
TEL;type=CELL;type=VOICE;waid=13135550002:+13135550002
END:VCARD`
            }
        }
    };

    // ✅ Old info-caption and connected-banner messages removed — the
    // session ID (above) and this Next Steps message are sent now. This
    // message is sent as an image (hosted, not read from local disk — no
    // dependency on assets/ existing on whatever Railway/host container
    // happens to be running this) with the caption below, marked as
    // forwarded from the channel so it carries the "forwarded many
    // times" tag WhatsApp shows on real channel broadcasts.
    const CHANNEL_JID = "0029Vb7IMwt3wtbAKXyJxR1g@newsletter";

    const nextStepsText = `╭━「 🚀 *NEXT STEPS* 」━╮
┃
┃ 1️⃣ ✅ Join *Group & Channel*
┃ 2️⃣ 🎥 Get deployment tutorials in the group 
┃ 3️⃣ 🛠️ Get direct deployment help
┃
┃ 📢 *CHANNEL:*
┃ https://whatsapp.com/channel/0029Vb7IMwt3wtbAKXyJxR1g
┃
┃ 👥 *GROUP:*
┃ https://chat.whatsapp.com/FUReIHkwRYm5U9tQ2PIxc7?mode=gi_t
╰━━━━━━━━━━━━━━━━━━╯`;

    try {
        // ✅ FIX: removed the spoofed contextInfo.forwardedNewsletterMessageInfo
        // and the fake quoted vcard. That block was telling WhatsApp "this
        // was forwarded from newsletter <CHANNEL_JID>, message #143" — a
        // reference your account never actually received. Android renders
        // that loosely and shows the message anyway; iOS validates it more
        // strictly and was silently failing to render the message at all
        // when it couldn't resolve that fake reference. Keeping just the
        // "forwarded" tag (no fake newsletter pointer) is both more
        // reliable across platforms and doesn't misrepresent the source.
        const nextStepsResult = await sendWithBanner(sock, jid, nextStepsText, {
            contextInfo: { mentionedJid: [jid], isForwarded: true }
        });
        console.log("[SESSION] Next-steps message send result:", nextStepsResult?.key?.id || nextStepsResult);
    } catch (e) {
        // ✅ FIX: this used to fail silently — you'd get the session ID
        // and nothing else, with no visible error, if the hosted image
        // URL had expired OR if WhatsApp's spam filter quietly dropped
        // the message (it's spoofed as a forwarded channel broadcast
        // with forwardingScore 999, which can get server-side filtered
        // without Baileys ever throwing). Fall back to a plain text
        // version with the same links so you always get *something*.
        console.error("[SESSION] Failed to send styled next-steps message, falling back to plain text:", e.message);
        try {
            await sock.sendMessage(jid, { text: nextStepsText });
        } catch (e2) {
            console.error("[SESSION] Plain-text fallback also failed:", e2.message);
        }
    }

    // Give both sends real time to round-trip before the caller tears
    // the socket/process down.
    await delay(2000);
}

/* ===== RESTORE ROUTE: GET /restore =====
   Serves back the zipped session folder for a given 32-hex-char backup
   ID, exactly matching what index.js's restoreSessionFromServerZip()
   already calls: GET {pairSite}/code/restore?id=<32-hex-chars>, with a
   Bearer token equal to API_PASSWORD. Mount this router at "/code" in
   your main app (app.use("/code", pairRouter)) so this resolves to the
   /code/restore path index.js expects.
*/
router.get("/restore", (req, res) => {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${API_PASSWORD}`) {
        return res.status(401).send({ code: "Unauthorized" });
    }

    const id = String(req.query.id || "");
    if (!/^[a-f0-9]{32}$/i.test(id)) {
        return res.status(400).send({ code: "Invalid id" });
    }

    const zipPath = join(BACKUPS_DIR, `${id}.zip`);
    if (!fs.existsSync(zipPath)) {
        return res.status(404).send({ code: "Session ID expired or not found" });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${id}.zip"`);
    fs.createReadStream(zipPath).pipe(res);
});

/* ===== PAIR-CODE ROUTE: GET / ===== */
router.get("/", async (req, res) => {
    let num = (req.query.number || "").replace(/[^0-9]/g, "");
    if (!num) return res.status(400).send({ code: "Number required" });

    const phone = pn("+" + num);
    if (!phone.isValid()) return res.status(400).send({ code: "Invalid number" });
    num = phone.getNumber("e164").replace("+", "");

    const dir = "./session" + num;
    rm(dir);

    async function start() {
        const { state, saveCreds } = await useMultiFileAuthState(dir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            // Bumped from "fatal" so send failures show up in your console.
            // Drop back to "fatal"/"silent" once delivery is confirmed working.
            logger: pino({ level: "warn" }),
            browser: Browsers.windows("Chrome"),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
            if (connection === "open") {
                try {
                    await deliverSession(sock, dir);
                    rm(dir);
                    // ✅ FIX: was process.exit(0) — that killed the whole
                    // site, not just this pairing. Close only this socket.
                    setTimeout(() => closeSocket(sock), 1000);
                } catch (err) {
                    console.error("❌ Error in pairing process:", err);
                    rm(dir);
                    try {
                        const jid = jidNormalizedUser(sock.user?.id || (num + "@s.whatsapp.net"));
                        await sock.sendMessage(jid, { text: "❌ Error generating session. Please try again." });
                    } catch (e) {
                        console.error("[SESSION] Failed to even send the error notice:", e);
                    }
                    // ✅ FIX: was process.exit(1) — same problem, just on
                    // the error path instead of the success path.
                    closeSocket(sock);
                }
            }

            if (connection === "close") {
                const c = lastDisconnect?.error?.output?.statusCode;
                console.log("[SESSION] Connection closed, statusCode:", c);
                if (c !== 401) {
                    setTimeout(() => start(), 2000);
                }
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(3000);
            try {
                let code = await sock.requestPairingCode(num);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                if (!res.headersSent) {
                    res.send({
                        success: true,
                        code: code,
                        message: "Scan QR code or use pairing code to connect"
                    });
                }
            } catch (err) {
                console.error("Pairing error:", err);
                if (!res.headersSent) {
                    res.status(503).send({ code: "PAIR_FAIL", error: err.message });
                }
                rm(dir);
                // ✅ FIX: was process.exit(1) — this ran on every failed
                // pairing-code request (e.g. bad number), taking the whole
                // site down each time. Just close this one socket attempt.
                closeSocket(sock);
            }
        }
    }

    start();
});

/* ===== QR ROUTE: GET /qr =====
   Matches what your pair.html frontend already expects from this
   endpoint: { qr: "<data URL>", instructions: [ ...lines ] }.
   Uses a random per-session folder since there's no phone number yet
   at QR-scan time.
*/
router.get("/qr", async (req, res) => {
    const sessionKey = Math.random().toString(36).substring(2, 10);
    const dir = "./sessionqr" + sessionKey;
    rm(dir);

    let responded = false;

    async function start() {
        const { state, saveCreds } = await useMultiFileAuthState(dir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            logger: pino({ level: "warn" }),
            browser: Browsers.windows("Chrome"),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
            if (qr && !responded) {
                try {
                    const qrDataUrl = await QRCode.toDataURL(qr);
                    if (!res.headersSent) {
                        responded = true;
                        res.send({
                            qr: qrDataUrl,
                            instructions: [
                                "Open WhatsApp on your phone",
                                "Tap Settings > Linked Devices",
                                "Tap 'Link a Device'",
                                "Scan this QR code"
                            ]
                        });
                    }
                } catch (e) {
                    console.error("QR generation error:", e);
                    if (!res.headersSent) {
                        responded = true;
                        res.status(500).send({ code: "QR_FAIL", error: e.message });
                    }
                }
            }

            if (connection === "open") {
                try {
                    // ✅ Same fix as the pair-code route: sock.user.id is the
                    // real, confirmed identity after a QR scan. There is no
                    // phone number to rebuild a JID from in this flow at
                    // all, so this matters even more here — a hand-built
                    // JID isn't just risky, it's not even possible correctly.
                    await deliverSession(sock, dir);
                    rm(dir);
                    // ✅ FIX: was process.exit(0) — killed the whole site.
                    setTimeout(() => closeSocket(sock), 1000);
                } catch (err) {
                    console.error("❌ Error in QR pairing process:", err);
                    rm(dir);
                    try {
                        const jid = jidNormalizedUser(sock.user.id);
                        await sock.sendMessage(jid, { text: "❌ Error generating session. Please try again." });
                    } catch (e) {
                        console.error("[SESSION] Failed to even send the error notice:", e);
                    }
                    // ✅ FIX: was process.exit(1) — killed the whole site.
                    closeSocket(sock);
                }
            }

            if (connection === "close") {
                const c = lastDisconnect?.error?.output?.statusCode;
                console.log("[SESSION] QR connection closed, statusCode:", c);
                if (c !== 401 && !responded) {
                    setTimeout(() => start(), 2000);
                }
            }
        });

        // Timeout the QR request if nothing gets scanned in time.
        setTimeout(() => {
            if (!responded) {
                responded = true;
                if (!res.headersSent) {
                    res.status(408).send({ code: "QR_TIMEOUT", error: "QR code was not generated in time" });
                }
                rm(dir);
            }
        }, 20000);
    }

    start();
});

/* ===== SAFETY ===== */
process.on("uncaughtException", (err) => {
    const e = String(err);
    console.error("[uncaughtException]", e);
    if (e.includes("conflict") || e.includes("not-authorized") || e.includes("Timed Out")) return;
    console.error("Crash:", err);
});

process.on("unhandledRejection", (err) => {
    console.error("Unhandled Rejection:", err);
});

export default router;

//coded by EmmyFrosh
