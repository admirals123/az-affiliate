/**
 * DealHunt API Server
 * Serves cached deals.json to the React frontend
 * Run: node server/index.js
 */

import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { CronJob } from "cron";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEALS_FILE = path.resolve(__dirname, "data/deals.json");
const BOT_SCRIPT = path.resolve(__dirname, "fetchDeals.js");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Cache in memory to avoid disk reads per request ──────────────────────
let cache = null;

async function loadDeals() {
  try {
    const raw = await fs.readFile(DEALS_FILE, "utf8");
    cache = JSON.parse(raw);
    console.log(`📦  Loaded ${cache.count} deals from disk (updated ${cache.updatedAt})`);
  } catch {
    console.warn("⚠️   No deals.json found yet. Run the bot first.");
    cache = { updatedAt: null, count: 0, deals: [] };
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────
// GET / — serve React frontend
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// GET /api/deals  — return all deals (with optional filtering)
app.get("/api/deals", (req, res) => {
  if (!cache) return res.status(503).json({ error: "Loading…" });

  let { cat, minDiscount, maxPrice, prime, sort, q, limit } = req.query;
  let deals = [...cache.deals];

  if (cat && cat !== "All")   deals = deals.filter(d => d.cat === cat);
  if (minDiscount)            deals = deals.filter(d => d.discount >= +minDiscount);
  if (maxPrice)               deals = deals.filter(d => d.price <= +maxPrice);
  if (prime === "true")       deals = deals.filter(d => d.prime);
  if (q) {
    const lq = q.toLowerCase();
    deals = deals.filter(d => d.title.toLowerCase().includes(lq) || d.cat.toLowerCase().includes(lq));
  }

  // Sorting
  const SORTS = {
    discount:   (a, b) => b.discount - a.discount,
    "price-asc":(a, b) => a.price - b.price,
    "price-desc":(a,b) => b.price - a.price,
    rating:     (a, b) => (b.rating ?? 0) - (a.rating ?? 0),
    savings:    (a, b) => b.savings - a.savings,
    newest:     (a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt),
  };
  if (SORTS[sort]) deals.sort(SORTS[sort]);

  if (limit) deals = deals.slice(0, +limit);

  res.json({
    updatedAt: cache.updatedAt,
    count: deals.length,
    deals,
  });
});

// GET /api/deals/categories — unique categories
app.get("/api/deals/categories", (_req, res) => {
  if (!cache) return res.status(503).json({ error: "Loading…" });
  const cats = ["All", ...Array.from(new Set(cache.deals.map(d => d.cat))).sort()];
  res.json({ categories: cats });
});

// GET /api/deals/:asin — single deal
app.get("/api/deals/:asin", (req, res) => {
  if (!cache) return res.status(503).json({ error: "Loading…" });
  const deal = cache.deals.find(d => d.asin === req.params.asin);
  if (!deal) return res.status(404).json({ error: "Not found" });
  res.json(deal);
});

// POST /api/bot/run — manually trigger the bot (protect with a secret in prod)
app.post("/api/bot/run", async (req, res) => {
  const secret = req.headers["x-bot-secret"];
  if (secret !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  console.log("🤖  Manual bot trigger received…");
  res.json({ message: "Bot started. Check server logs." });
  try {
    await execFileAsync("node", [BOT_SCRIPT]);
    await loadDeals();
    console.log("✅  Manual bot run complete.");
  } catch (err) {
    console.error("Bot error:", err.message);
  }
});

// ─── Scheduled bot run (every 4 hours) ────────────────────────────────────
const cronJob = new CronJob("0 */4 * * *", async () => {
  console.log("⏰  Scheduled bot run starting…");
  try {
    await execFileAsync("node", [BOT_SCRIPT]);
    await loadDeals();
    console.log("✅  Scheduled bot run complete.");
  } catch (err) {
    console.error("Scheduled bot error:", err.message);
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────
await loadDeals();
cronJob.start();

app.listen(PORT, () => {
  console.log(`🚀  DealHunt API running at http://localhost:${PORT}`);
  console.log(`    Bot scheduled every 4 hours`);
});
