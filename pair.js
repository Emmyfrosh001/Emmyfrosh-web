import express from "express";
import fs from "fs";
import pino from "pino";
import QRCode from "qrcode"; // npm install qrcode
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

/* ===== SHORT SESSION ID GENERATOR WITH BASE64 ENCODING ===== */
async function generateShortSession(credsPath) {
    try {
        const credsData = fs.readFileSync(credsPath, 'utf-8');
        const base64Creds = Buffer.from(credsData).toString('base64');
        const sessionId = `EMMYFROSH-AI~`;
        return {
            sessionId: sessionId,
            encodedData: base64Creds
        };
    } catch (error) {
        console.error("Error generating short session:", error);
        return null;
    }
}

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

    const credsPath = join(dir, 'creds.json');
    const sessionInfo = await generateShortSession(credsPath);
    if (!sessionInfo) {
        throw new Error("Failed to generate session");
    }

    const jid = jidNormalizedUser(sock.user.id);
    console.log("[SESSION] Sending session to JID:", jid);

    const completeSession = `${sessionInfo.sessionId}${sessionInfo.encodedData}`;
    const sendResult = await sock.sendMessage(jid, { text: `${completeSession}` });
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

    // Give both sends real time to round-trip before the caller tears
    // the socket/process down.
    await delay(5000);
}

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