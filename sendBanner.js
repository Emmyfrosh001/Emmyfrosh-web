import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// banner.jpg lives in the project root (next to this file). We also check
// assets/ and the working directory so it is found wherever it is placed.
const BANNER_PATHS = [
    join(__dirname, "banner.jpg"),
    join(__dirname, "assets", "banner.jpg"),
    join(process.cwd(), "banner.jpg"),
    join(process.cwd(), "assets", "banner.jpg"),
];

let bannerBuffer = null;
function getBanner() {
    if (bannerBuffer) return bannerBuffer;
    for (const p of BANNER_PATHS) {
        try {
            if (fs.existsSync(p)) {
                bannerBuffer = fs.readFileSync(p);
                console.log("[BANNER] Loaded banner from", p);
                return bannerBuffer;
            }
        } catch (e) {
            console.error("[BANNER] Could not read", p, "-", e.message);
        }
    }
    console.error("[BANNER] banner.jpg not found. Looked in:", BANNER_PATHS.join(", "));
    return null;
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
