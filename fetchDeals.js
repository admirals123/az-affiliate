/**
 * DealHunt Scraper — amazon.ca/deals & amazon.ca/gp/goldbox
 * No Amazon PA API required. Runs via: node fetchDeals.js
 *
 * Requires: npm install puppeteer
 */

import puppeteer from "puppeteer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  partnerTag:   process.env.AMAZON_PARTNER_TAG || "",
  outputFile:   path.resolve(__dirname, "data/deals.json"),
  minDiscount:  20,
  scrollPasses: 8,   // scroll passes to trigger lazy-loaded deal cards
};

// Pages to scrape in order
const SOURCES = [
  { url: "https://www.amazon.ca/deals",      label: "Today's Deals" },
  { url: "https://www.amazon.ca/gp/goldbox", label: "Gold Box"      },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Scroll to the bottom incrementally so lazy-loaded cards appear
async function autoScroll(page) {
  await page.evaluate(async (passes) => {
    for (let i = 0; i < passes; i++) {
      window.scrollBy(0, window.innerHeight * 1.5);
      await new Promise(r => setTimeout(r, 1200));
    }
    window.scrollTo(0, 0);
  }, CONFIG.scrollPasses);
}

// Run inside the page context to pull structured deal data out of the DOM.
// Amazon changes class names frequently, so we use multiple fallback selectors
// at every step rather than relying on a single fragile path.
function extractDealsFromDOM(partnerTag) {
  const results = [];
  const seen    = new Set();

  // Broad card selectors covering both the /deals React layout and /gp/goldbox
  const cardSelectors = [
    '[data-testid="deal-card"]',
    '[class*="DealCard"]',
    '[class*="dealItem"]',
    ".GB-CARD",
    ".a-section.octopus-dlp-asin-section",
  ];
  const cards = cardSelectors.flatMap(s => [...document.querySelectorAll(s)]);

  for (const card of cards) {
    try {
      // ── ASIN ── (required — derived from the product link)
      const link  = card.querySelector("a[href*='/dp/'], a[href*='/gp/product/']");
      if (!link) continue;
      const asinM = link.href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
      if (!asinM) continue;
      const asin  = asinM[1];
      if (seen.has(asin)) continue;
      seen.add(asin);

      // ── Title ──
      const titleEl = card.querySelector(
        '[data-testid="deal-title"], [class*="dealTitle"], [class*="DealTitle"], ' +
        ".a-size-base-plus, .a-text-normal, .a-size-medium"
      );
      const title = titleEl?.textContent?.trim() || "Unknown Product";

      // ── Current price ── (.a-offscreen is the screen-reader text "$12.99")
      const priceSpan = card.querySelector(
        '.a-price:not([data-a-strike="true"]) .a-offscreen'
      );
      const price = priceSpan
        ? parseFloat(priceSpan.textContent.replace(/[^0-9.]/g, ""))
        : null;
      if (!price) continue;

      // ── Was / list price ──
      const wasSpan = card.querySelector(
        '.a-price[data-a-strike="true"] .a-offscreen, ' +
        ".a-text-strike .a-offscreen, " +
        ".a-text-strike"
      );
      const was = wasSpan
        ? parseFloat(wasSpan.textContent.replace(/[^0-9.]/g, ""))
        : null;
      if (!was || was <= price) continue;

      // ── Discount % (badge first, computed fallback) ──
      const badgeEl   = card.querySelector(
        '[class*="badgeLabel"], [class*="badge-label"], ' +
        ".savingsPercentage, [data-testid='deal-badge']"
      );
      const badgeNum  = badgeEl ? parseInt(badgeEl.textContent.replace(/[^0-9]/g, ""), 10) : NaN;
      const discount  = Number.isFinite(badgeNum) && badgeNum > 0
        ? badgeNum
        : Math.round((1 - price / was) * 100);

      // ── Image ──
      const imgEl = card.querySelector("img");
      const image = imgEl?.src || imgEl?.getAttribute("data-src") || null;

      // ── Prime badge ──
      const prime = !!(
        card.querySelector(".a-icon-prime") ||
        card.querySelector('[aria-label*="Prime"]') ||
        card.querySelector('[class*="prime" i]')
      );

      // ── Category ──
      const catEl = card.querySelector(
        '[class*="category" i], [data-testid*="category"], [class*="Category"]'
      );
      const cat = catEl?.textContent?.trim() || "General";

      results.push({
        asin,
        title,
        cat,
        image,
        price:    Math.round(price * 100) / 100,
        was:      Math.round(was   * 100) / 100,
        discount,
        savings:  Math.round((was - price) * 100) / 100,
        prime,
        rating:   null,
        reviews:  null,
        url:      `https://www.amazon.ca/dp/${asin}${partnerTag ? "?tag=" + partnerTag : ""}`,
        fetchedAt: new Date().toISOString(),
      });
    } catch (_) { /* skip malformed card */ }
  }

  return results;
}

async function scrapePage(page, source, partnerTag) {
  await page.goto(source.url, { waitUntil: "networkidle2", timeout: 60_000 });
  await sleep(2000);
  await autoScroll(page);
  await sleep(1000);
  return page.evaluate(extractDealsFromDOM, partnerTag);
}

async function run() {
  console.log("🤖  DealHunt scraper starting…");
  if (!CONFIG.partnerTag) {
    console.warn("⚠️   AMAZON_PARTNER_TAG not set — affiliate links will have no tag");
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = await browser.newPage();

  // Mimic a real desktop Chrome session
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-CA,en;q=0.9" });
  // Hide the automation flag that some bot-detection scripts check
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const allDeals = [];

  for (const source of SOURCES) {
    try {
      console.log(`  ↳ Scraping ${source.label} (${source.url})…`);
      const deals = await scrapePage(page, source, CONFIG.partnerTag);
      allDeals.push(...deals);
      console.log(`    ✓ ${deals.length} deals found`);
    } catch (err) {
      console.error(`    ✗ ${source.label}: ${err.message}`);
    }
    // Polite delay between pages
    await sleep(3000 + Math.random() * 2000);
  }

  await browser.close();

  // Deduplicate across pages, filter weak discounts, sort by discount
  const seen = new Set();
  const unique = allDeals.filter(d => {
    if (seen.has(d.asin)) return false;
    seen.add(d.asin);
    return true;
  });

  const filtered = unique
    .filter(d => d.discount >= CONFIG.minDiscount)
    .sort((a, b) => b.discount - a.discount);

  await fs.mkdir(path.dirname(CONFIG.outputFile), { recursive: true });
  await fs.writeFile(CONFIG.outputFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    count:     filtered.length,
    deals:     filtered,
  }, null, 2));

  console.log(`\n✅  Done! ${filtered.length} deals saved to ${CONFIG.outputFile}`);
}

run().catch(err => { console.error(err); process.exit(1); });
