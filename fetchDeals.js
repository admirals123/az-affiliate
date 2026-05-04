/**
 * DealHunt Bot — Amazon Product Advertising API 5.0
 * Fetches deals across all categories and saves them to deals.json
 *
 * Setup:
 *   1. Sign up at https://affiliate-program.amazon.com
 *   2. Once approved, go to Tools → Product Advertising API
 *   3. Generate Access Key + Secret Key
 *   4. Fill in your credentials in .env
 */

import crypto from "crypto";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";

// ─── Config ────────────────────────────────────────────────────────────────
const CONFIG = {
  accessKey:   process.env.AMAZON_ACCESS_KEY,
  secretKey:   process.env.AMAZON_SECRET_KEY,
  partnerTag:  process.env.AMAZON_PARTNER_TAG, // your-tag-20
  host:        "webservices.amazon.ca",         // .ca for Canada, .com for US
  region:      "ca-central-1",                  // ca-central-1 for Canada
  outputFile:  path.resolve("./data/deals.json"),
  minDiscount: 20,   // Only keep deals with at least 20% off
  maxResults:  100,  // Items per category fetch
};

// Categories to search — PA API BrowseNode IDs for amazon.ca
const CATEGORIES = [
  { name: "Electronics",     browseNodeId: "667823011" },
  { name: "Kitchen",         browseNodeId: "2404990011" },
  { name: "Home",            browseNodeId: "2404991011" },
  { name: "Fashion",         browseNodeId: "2206275011" },
  { name: "Sports",          browseNodeId: "2206234011" },
  { name: "Toys",            browseNodeId: "2206549011" },
  { name: "Books",           browseNodeId: "916520" },
  { name: "Health & Beauty", browseNodeId: "2206631011" },
  { name: "Tools",           browseNodeId: "3561352011" },
  { name: "Pet Supplies",    browseNodeId: "2402551011" },
];

// ─── AWS Signature V4 ──────────────────────────────────────────────────────
function sign(key, msg) {
  return crypto.createHmac("sha256", key).update(msg).digest();
}

function getSignatureKey(secretKey, dateStamp, regionName, serviceName) {
  const kDate    = sign(`AWS4${secretKey}`, dateStamp);
  const kRegion  = sign(kDate, regionName);
  const kService = sign(kRegion, serviceName);
  return sign(kService, "aws4_request");
}

function buildAuthHeaders(payload) {
  const now        = new Date();
  const amzDate    = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp  = amzDate.slice(0, 8);
  const service    = "ProductAdvertisingAPI";
  const target     = "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems";
  const endpoint   = `https://${CONFIG.host}/paapi5/searchitems`;

  const bodyHash = crypto.createHash("sha256").update(payload).digest("hex");

  const canonicalHeaders = [
    `content-encoding:amz-1.0`,
    `content-type:application/json; charset=UTF-8`,
    `host:${CONFIG.host}`,
    `x-amz-date:${amzDate}`,
    `x-amz-target:${target}`,
  ].join("\n");

  const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";

  const canonicalRequest = [
    "POST",
    "/paapi5/searchitems",
    "",
    canonicalHeaders + "\n",
    signedHeaders,
    bodyHash,
  ].join("\n");

  const credScope    = `${dateStamp}/${CONFIG.region}/${service}/aws4_request`;
  const strToSign    = `AWS4-HMAC-SHA256\n${amzDate}\n${credScope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const signingKey   = getSignatureKey(CONFIG.secretKey, dateStamp, CONFIG.region, service);
  const signature    = crypto.createHmac("sha256", signingKey).update(strToSign).digest("hex");

  return {
    "content-encoding": "amz-1.0",
    "content-type": "application/json; charset=UTF-8",
    "host": CONFIG.host,
    "x-amz-date": amzDate,
    "x-amz-target": target,
    "Authorization": `AWS4-HMAC-SHA256 Credential=${CONFIG.accessKey}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ─── Fetch one category ────────────────────────────────────────────────────
async function fetchCategory({ name, browseNodeId }) {
  const payload = JSON.stringify({
    PartnerTag:     CONFIG.partnerTag,
    PartnerType:    "Associates",
    Marketplace:    "www.amazon.ca",
    BrowseNodeId:   browseNodeId,
    SearchIndex:    "All",
    ItemCount:      10,           // 1–10 per request (PA API limit)
    Resources: [
      "Images.Primary.Medium",
      "ItemInfo.Title",
      "Offers.Listings.Price",
      "Offers.Listings.SavingBasis",
      "Offers.Listings.DeliveryInfo.IsPrimeEligible",
      "Offers.Summaries.LowestPrice",
      "CustomerReviews.StarRating",
      "CustomerReviews.Count",
      "ItemInfo.ByLineInfo",
    ],
    SortBy: "Featured",
  });

  const headers = buildAuthHeaders(payload);

  const res = await fetch(`https://${CONFIG.host}/paapi5/searchitems`, {
    method: "POST",
    headers,
    body: payload,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PA API error for ${name}: ${res.status} — ${text}`);
  }

  const data = await res.json();
  return parseItems(data, name);
}

// ─── Parse API response into our deal format ───────────────────────────────
function parseItems(data, catName) {
  const items = data?.SearchResult?.Items ?? [];
  const deals = [];

  for (const item of items) {
    try {
      const listing   = item?.Offers?.Listings?.[0];
      const priceObj  = listing?.Price;
      const basisObj  = listing?.SavingBasis;

      if (!priceObj?.Amount || !basisObj?.Amount) continue;

      const price = priceObj.Amount;
      const was   = basisObj.Amount;

      if (price >= was) continue; // no discount
      const discountPct = Math.round((1 - price / was) * 100);
      if (discountPct < CONFIG.minDiscount) continue;

      const asin  = item.ASIN;
      const title = item?.ItemInfo?.Title?.DisplayValue ?? "Unknown Product";
      const image = item?.Images?.Primary?.Medium?.URL ?? null;
      const prime = listing?.DeliveryInfo?.IsPrimeEligible ?? false;

      const starRaw    = item?.CustomerReviews?.StarRating?.DisplayValue;
      const reviewsRaw = item?.CustomerReviews?.Count?.DisplayValue;
      const rating     = starRaw  ? parseFloat(starRaw)  : null;
      const reviews    = reviewsRaw ? parseInt(reviewsRaw.replace(/,/g, ""), 10) : null;

      deals.push({
        asin,
        title,
        cat: catName,
        image,
        price: +price.toFixed(2),
        was:   +was.toFixed(2),
        discount: discountPct,
        savings: +(was - price).toFixed(2),
        prime,
        rating,
        reviews,
        url: `https://www.amazon.ca/dp/${asin}?tag=${CONFIG.partnerTag}`,
        fetchedAt: new Date().toISOString(),
      });
    } catch (_) {
      continue;
    }
  }

  return deals;
}

// ─── Rate-limit helper (PA API allows 1 req/sec) ──────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Main ─────────────────────────────────────────────────────────────────
async function run() {
  console.log("🤖  DealHunt Bot starting…");

  if (!CONFIG.accessKey || !CONFIG.secretKey || !CONFIG.partnerTag) {
    console.error("❌  Missing credentials. Check your .env file.");
    process.exit(1);
  }

  const allDeals = [];

  for (const cat of CATEGORIES) {
    try {
      console.log(`  ↳ Fetching ${cat.name}…`);
      const deals = await fetchCategory(cat);
      allDeals.push(...deals);
      console.log(`    ✓ ${deals.length} deals found`);
    } catch (err) {
      console.error(`    ✗ ${cat.name}: ${err.message}`);
    }
    await sleep(1100); // 1 req/sec limit
  }

  // Sort by discount descending
  allDeals.sort((a, b) => b.discount - a.discount);

  await fs.mkdir(path.dirname(CONFIG.outputFile), { recursive: true });
  await fs.writeFile(CONFIG.outputFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    count: allDeals.length,
    deals: allDeals,
  }, null, 2));

  console.log(`\n✅  Done! ${allDeals.length} deals saved to ${CONFIG.outputFile}`);
}

run().catch((err) => { console.error(err); process.exit(1); });
