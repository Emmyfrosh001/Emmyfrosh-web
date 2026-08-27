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
    await delay(6000);

    const sessionInfo = await generateShortSession(dir);
    if (!sessionInfo) {
        throw new Error("Failed to generate session");
    }

    const jid = jidNormalizedUser(sock.user.id);
    console.log("[SESSION] Sending session to JID:", jid);

    const sendResult = await sock.sendMessage(jid, { text: sessionInfo.sessionId });
    console.log("[SESSION] Session message send result:", sendResult?.key?.id || sendResult);

    await delay(2000);

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

    const caption = `
╭━〔 *EMMYFROSH-AI* 〕━··๏
┃★╭──────────────
┃★│ 👑 Owner : *EMMYFROSH-AI*
┃★│ 🤖 Baileys : *Multi Device*
┃★│ 💻 Type : *NodeJs*
┃★│ 🚀 Platform : *Render*
┃★│ ⚙️ Mode : *Public*
┃★│ 🔣 Prefix : *[ . ]*
┃★│ 🏷️ Version : *1.0.0*
┃★╰──────────────
╰━━━━━━━━━━━━━━┈⊷`;

    const infoResult = await sock.sendMessage(
        jid,
        {
            image: { url: "https://h.uguu.se/KhEaGXJR.jpg" },
            caption,
            contextInfo: {
                mentionedJid: [jid],
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: "0029Vb7IMwt3wtbAKXyJxR1g@newsletter",
                    newsletterName: "❀༒★[emmyfrosh-ai]★༒❀",
                    serverMessageId: 143
                }
            }
        },
        { quoted: fakeVCardQuoted }
    );
    console.log("[SESSION] Info message send result:", infoResult?.key?.id || infoResult);

    await delay(2000);

    // ✅ Third message — the branded "connected" banner, sent with a
    // group-join link and the same channel forward card as the info
    // message above. The banner is bundled locally (assets/connected-
    // banner.png) and read from disk rather than depending on a
    // third-party image host staying up.
    const GROUP_LINK = "https://chat.whatsapp.com/FUReIHkwRYm5U9tQ2PIxc7?mode=gi_t";
    const CHANNEL_JID = "0029Vb7IMwt3wtbAKXyJxR1g@newsletter";

    const connectedCaption = `┌───「 ⚡ *EMMYFROSH-AI* 」───
│ 
│ 🟢 *System:* Connected (v1.0.0)
│ 📌 *Notice:* Join channel & group for 
│    the deployment video! 🌝💔
│
└──────────────────────────

👥 *Group:* ${GROUP_LINK}`;

    try {
        const bannerPath = join(__dirname, "assets", "connected-banner.png");
        if (!fs.existsSync(bannerPath)) {
            console.warn("[SESSION] assets/connected-banner.png not found — skipping banner message");
            throw new Error("banner asset missing");
        }
        const bannerBuffer = fs.readFileSync(bannerPath);

        const connectedResult = await sock.sendMessage(
            jid,
            {
                image: bannerBuffer,
                caption: connectedCaption,
                contextInfo: {
                    mentionedJid: [jid],
                    forwardingScore: 999,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                        newsletterJid: CHANNEL_JID,
                        newsletterName: "❀༒★[emmyfrosh-ai]★༒❀",
                        serverMessageId: 143
                    }
                }
            },
            { quoted: fakeVCardQuoted }
        );
        console.log("[SESSION] Connected-banner message send result:", connectedResult?.key?.id || connectedResult);
    } catch (e) {
        console.error("[SESSION] Failed to send connected-banner message:", e.message);
    }

    // Give both sends real time to round-trip before the caller tears
    // the socket/process down.
    await delay(5000);
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
                    setTimeout(() => process.exit(0), 1000);
                } catch (err) {
                    console.error("❌ Error in pairing process:", err);
                    rm(dir);
                    try {
                        const jid = jidNormalizedUser(sock.user?.id || (num + "@s.whatsapp.net"));
                        await sock.sendMessage(jid, { text: "❌ Error generating session. Please try again." });
                    } catch (e) {
                        console.error("[SESSION] Failed to even send the error notice:", e);
                    }
                    process.exit(1);
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
                process.exit(1);
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
                    setTimeout(() => process.exit(0), 1000);
                } catch (err) {
                    console.error("❌ Error in QR pairing process:", err);
                    rm(dir);
                    try {
                        const jid = jidNormalizedUser(sock.user.id);
                        await sock.sendMessage(jid, { text: "❌ Error generating session. Please try again." });
                    } catch (e) {
                        console.error("[SESSION] Failed to even send the error notice:", e);
                    }
                    process.exit(1);
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