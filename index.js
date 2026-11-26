import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { fileURLToPath } from "url";
import path from "path";

import pairRouter from "./pair.js";
import qrRouter from "./qr.js";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8000;

import("events").then((events) => {
  events.EventEmitter.defaultMaxListeners = 500;
});

/* ✅ CORS — MUST BE BEFORE ROUTES */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
/* 🔒 Never serve source code, secrets, saved data or session backups.
   (express.static(__dirname) below publishes this whole folder, so these must be blocked first.) */
app.use((req, res, next) => {
  let p = "";
  try { p = decodeURIComponent(req.path).toLowerCase(); } catch { return res.status(400).end(); }
  if (
    /^\/(backups|data|deploy-defaults|node_modules|\.git)(\/|$)/.test(p) ||
    /\.(js|mjs|cjs|json|txt|md|yaml|yml|env|lock)$/.test(p) ||
    p.includes("..")
  ) {
    return res.status(404).send("Not found");
  }
  next();
});

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "pair.html"));
});

/* ✅ ROUTES */
app.use("/pair", pairRouter);
app.use("/qr", qrRouter);

/* ✅ FIX: the bot's handler (restoreSessionFromServerZip in main.js) calls
   GET {pairSite}/code/restore?id=<id> — but pairRouter (which owns the
   /restore route) was only ever mounted at /pair, so /code/restore never
   resolved and every restore attempt from the bot hit a dead route
   (surfacing as a 502/failed request on the bot's side). Mounting the
   same router at /code too — alongside the existing /pair mount used by
   pair.html's own pairing UI — makes /code/restore resolve without
   touching any of the existing frontend behavior. */
app.use("/code", pairRouter);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
