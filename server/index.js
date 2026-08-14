import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { visitHandler, seenHandler, fameHandler } from "./visits.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BLESSINGS_DIR = process.env.BLESSINGS_DIR ?? "/data/blessings";

const app = express();

app.get("/api/visit", visitHandler);
app.post("/api/seen/:id", seenHandler);
app.get("/api/fame", fameHandler);
// daily generation runs as an Edge execute cronjob (agent/run.js) —
// no HTTP trigger endpoint, no token, nothing to protect.

// agent output (volume on Edge, local dir in dev) — served live, no redeploy
app.use("/blessings", express.static(BLESSINGS_DIR, { fallthrough: true }));
app.get("/blessings/blessings.json", (_req, res) => res.json({ raccoons: [] }));

app.use(express.static(path.join(ROOT, "public")));

const port = Number(process.env.PORT ?? 8642);
app.listen(port, () => console.log(`🦝 blessing on http://localhost:${port}`));
