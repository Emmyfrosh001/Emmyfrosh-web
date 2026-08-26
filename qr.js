import express from "express";
import fs from "fs";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { upload } from "./mega.js";

const router = express.Router();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

function getMegaFileId(url) {
    try {
        const match = url.match(/\/file\/([^#]+#[^\/]+)/);
        return match ? match[1] : null;
    } catch (error) {
        return null;
    }
}

router.get("/", async (req, res) => {
    const sessionId =
        Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const dirs = `./qr_sessions/session_${sessionId}`;

    if (!fs.existsSync("./qr_sessions")) {
        fs.mkdirSync("./qr_sessions", { recursive: true });
    }

    await removeFile(dirs);

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version, isLatest } = await fetchLatestBaileysVersion();

            let responseSent = false;

            const KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "fatal" }).child({ level: "fatal" }),
                    ),
                },
                printQRInTerminal: false,
                // Bumped from "fatal" so real connection problems show up in
                // your console instead of vanishing. Drop back once things
                // are confirmed working end-to-end.
                logger: pino({ level: "warn" }).child({ level: "warn" }),
                browser: Browsers.windows("Chrome"),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, isNewLogin, isOnline, qr } =
                    update;

                if (qr && !responseSent) {
                    console.log(
                        "🟢 QR Code Generated! Scan it with your WhatsApp app.",
                    );

                    try {
                        const qrDataURL = await QRCode.toDataURL(qr, {
                            errorCorrectionLevel: "M",
                            type: "image/png",
                            quality: 0.92,
                            margin: 1,
                            color: {
                                dark: "#000000",
                                light: "#FFFFFF",
                            },
                        });

                        if (!responseSent) {
                            responseSent = true;
                            console.log("QR Code sent to client");
                            res.send({
                                qr: qrDataURL,
                                message:
                                    "QR Code Generated! Scan it with your WhatsApp app.",
                                instructions: [
                                    "1. Open WhatsApp on your phone",
                                    "2. Go to Settings > Linked Devices",
                                    '3. Tap "Link a Device"',
                                    "4. Scan the QR code above",
                                ],
                            });
                        }
                    } catch (qrError) {
                        console.error("Error generating QR code:", qrError);
                        if (!responseSent) {
                            responseSent = true;
                            res.status(500).send({
                                code: "Failed to generate QR code",
                            });
                        }
                    }
                }

                if (connection === "open") {
                    console.log("✅ Connected successfully!");
                    console.log("📱 Uploading session to MEGA...");

                    // Resolve the JID up front so we can still reach the
                    // user on WhatsApp even if the MEGA upload itself fails.
                    const userJid = jidNormalizedUser(
                        KnightBot.authState.creds.me?.id || "",
                    );

                    try {
                        const credsPath = dirs + "/creds.json";
                        const megaUrl = await upload(
                            credsPath,
                            `creds_qr_${sessionId}.json`,
                        );
                        // ✅ Log the raw URL MEGA actually returned. If the
                        // regex below ever fails to match, this line tells
                        // you exactly what format you're dealing with.
                        console.log("[MEGA] Upload returned URL:", megaUrl);

                        const megaFileId = getMegaFileId(megaUrl);

                        if (megaFileId) {
                            console.log(
                                "✅ Session uploaded to MEGA. File ID:",
                                megaFileId,
                            );

                            if (userJid) {
                                // Small buffer before sending — avoids
                                // sending the instant "open" fires, before
                                // the socket has fully settled.
                                await delay(2000);
                                const sendResult = await KnightBot.sendMessage(userJid, {
                                    text: `${megaFileId}`,
                                });
                                console.log(
                                    "📄 MEGA file ID sent:",
                                    sendResult?.key?.id || sendResult,
                                );
                            } else {
                                console.log("❌ Could not determine user JID");
                            }
                        } else {
                            // ✅ Previously this only logged server-side and
                            // the user got nothing at all. Now it also
                            // tells them on WhatsApp that something broke,
                            // instead of silence.
                            console.log(
                                "❌ Failed to extract file ID from MEGA URL:",
                                megaUrl,
                            );
                            if (userJid) {
                                await KnightBot.sendMessage(userJid, {
                                    text: "❌ Session uploaded to MEGA but the file link couldn't be parsed. Check server logs.",
                                }).catch(() => {});
                            }
                        }

                        console.log("🧹 Cleaning up session...");
                        await delay(1000);
                        removeFile(dirs);
                        console.log("✅ Session cleaned up successfully");
                        console.log("🎉 Process completed successfully!");

                        console.log("🛑 Shutting down application...");
                        await delay(2000);
                        process.exit(0);
                    } catch (error) {
                        // ✅ Root-cause visibility: this is where a bad
                        // MEGA login (wrong email/password), quota issues,
                        // or network failures surface. Previously this was
                        // console-only — now it also DMs the user so they
                        // know pairing didn't actually complete.
                        console.error("❌ Error uploading to MEGA:", error);
                        if (userJid) {
                            await KnightBot.sendMessage(userJid, {
                                text: `❌ Couldn't finish pairing: session upload to MEGA failed (${error?.message || "unknown error"}). Please check the MEGA credentials configured on the server.`,
                            }).catch(() => {});
                        }
                        removeFile(dirs);
                        await delay(2000);
                        process.exit(1);
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via QR code");
                }

                if (isOnline) {
                    console.log("📶 Client is online");
                }

                if (connection === "close") {
                    const statusCode =
                        lastDisconnect?.error?.output?.statusCode;

                    if (statusCode === 401) {
                        console.log(
                            "❌ Logged out from WhatsApp. Need to generate new QR code.",
                        );
                    } else {
                        console.log("🔁 Connection closed — restarting...");
                        initiateSession();
                    }
                }
            });

            KnightBot.ev.on("creds.update", saveCreds);

            setTimeout(() => {
                if (!responseSent) {
                    responseSent = true;
                    res.status(408).send({ code: "QR generation timeout" });
                    removeFile(dirs);
                    setTimeout(() => process.exit(1), 2000);
                }
            }, 30000);
        } catch (err) {
            console.error("Error initializing session:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            removeFile(dirs);
            setTimeout(() => process.exit(1), 2000);
        }
    }

    await initiateSession();
});

process.on("uncaughtException", (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (
        e.includes("Stream Errored") ||
        e.includes("Stream Errored (restart required)")
    )
        return;
    if (e.includes("statusCode: 515") || e.includes("statusCode: 503")) return;
    console.log("Caught exception: ", err);
    process.exit(1);
});

export default router;