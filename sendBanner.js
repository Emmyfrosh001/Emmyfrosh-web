import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BANNER_PATH = join(__dirname, "assets", "banner.jpg");

let bannerBuffer = null;
function getBanner() {
    if (bannerBuffer) return bannerBuffer;
    try {
        bannerBuffer = fs.readFileSync(BANNER_PATH);
    } catch (e) {
        console.error("[BANNER] Could not read", BANNER_PATH, "-", e.message);
    }
    return bannerBuffer;
}

/* Sends `caption` as the caption of the EmmyFrosh AI picture.
   If the picture is missing or the image send fails, it falls back to a
   plain text message so the session ID / info always arrives. */
export async function sendWithBanner(sock, jid, caption, extra = {}) {
    const image = getBanner();
    if (image) {
        try {
            return await sock.sendMessage(jid, { image, caption, ...extra });
        } catch (e) {
            console.error("[BANNER] Image send failed, falling back to text:", e.message);
        }
    }
    return sock.sendMessage(jid, { text: caption, ...extra });
}
