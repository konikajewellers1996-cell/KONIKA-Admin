import prisma from "../db.server";
import { syncAllProductPricesToShopify } from "./shopify-catalog.server";

// Scrape live 22K gold rate from sources with fallbacks
export async function fetchLiveGoldRate(): Promise<number | null> {
  // 1. Try KJPL (Primary)
  try {
    console.log("[Gold Rate Cron] Fetching from KJPL...");
    const res = await fetch("http://www.kjpl.in/", { signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    const match = html.match(/<span class="gold-rate">(\d+)<\/span>/);
    if (match) {
      const rate = Number(match[1]);
      if (Number.isFinite(rate) && rate > 0) {
        console.log(`[Gold Rate Cron] KJPL Success: ${rate}`);
        return rate;
      }
    }
  } catch (e: any) {
    console.error(`[Gold Rate Cron] KJPL Down/Error: ${e.message}`);
  }

  // 2. Try GRT (Fallback 1)
  try {
    console.log("[Gold Rate Cron] Fetching from GRT...");
    const res = await fetch("https://www.grtjewellers.com/", { signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    const matches = html.match(/22\s*KT[^\d]*amount[^\d]*(\d{4,5})/i) || html.match(/22\s*KT[^\d]*(\d{4,5})/i);
    if (matches) {
      const rate = Number(matches[1]);
      if (Number.isFinite(rate) && rate > 0) {
        console.log(`[Gold Rate Cron] GRT Success: ${rate}`);
        return rate;
      }
    }
  } catch (e: any) {
    console.error(`[Gold Rate Cron] GRT Down/Error: ${e.message}`);
  }

  // 3. Try Lalitha (Fallback 2)
  try {
    console.log("[Gold Rate Cron] Fetching from Lalitha...");
    const rateRes = await fetch(
      "https://api.lalithaajewellery.com/public/pricings/latest?state_id=df30f5aa-75b6-4766-8317-25cf4eaf43a6",
      { signal: AbortSignal.timeout(10000) }
    );
    const rateData: any = await rateRes.json();
    const rate = Number(rateData?.data?.prices?.gold_22kt?.price);
    if (Number.isFinite(rate) && rate > 0) {
      console.log(`[Gold Rate Cron] Lalitha Success: ${rate}`);
      return rate;
    }
  } catch (e: any) {
    console.error(`[Gold Rate Cron] Lalitha Down/Error: ${e.message}`);
  }

  return null;
}

// Update DB setting and push new prices to all connected Shopify stores
export async function runGoldRateSync(newRate: number) {
  // Update local settings in database
  await prisma.appSetting.upsert({
    where: { id: "default" },
    update: { goldPricePerGram: newRate },
    create: { id: "default", goldPricePerGram: newRate },
  });
  console.log(`[Gold Rate Cron] Saved new gold price to DB: ${newRate}`);

  // Fetch all active offline Shopify store sessions
  const sessions = await prisma.session.findMany({
    where: { isOnline: false },
  });

  // Dynamically import shopify to avoid circular dependencies during module loading
  const shopify = (await import("../shopify.server")).default;

  for (const session of sessions) {
    try {
      console.log(`[Gold Rate Cron] Syncing prices to shop: ${session.shop}`);
      const { admin } = await shopify.unauthenticated.admin(session.shop);
      await syncAllProductPricesToShopify(admin.graphql, newRate);
      console.log(`[Gold Rate Cron] Finished syncing prices to shop: ${session.shop}`);
    } catch (e: any) {
      console.error(`[Gold Rate Cron] Error syncing prices to shop ${session.shop}: ${e.message}`);
    }
  }
}

// Main Cron Runner
export async function runGoldRateCronCycle() {
  console.log("[Gold Rate Cron] Starting cron cycle...");
  const liveRate = await fetchLiveGoldRate();
  if (liveRate) {
    // Check if the gold rate has actually changed
    const currentSettings = await prisma.appSetting.findUnique({
      where: { id: "default" },
    });
    const currentRate = currentSettings?.goldPricePerGram ?? 0;

    if (liveRate !== currentRate) {
      console.log(`[Gold Rate Cron] Gold rate changed from ${currentRate} to ${liveRate}. Updating products...`);
      await runGoldRateSync(liveRate);
    } else {
      console.log(`[Gold Rate Cron] Gold rate remains unchanged at ${currentRate}. Skipping sync.`);
    }
  } else {
    console.log("[Gold Rate Cron] Failed to fetch live gold rate from any source. Keeping last updated rate.");
  }
}

// Initialize the 2-hour interval
export function initGoldRateCron() {
  if (typeof global !== "undefined") {
    const globalObj = global as any;
    if (globalObj.__goldRateIntervalInitialized) {
      return;
    }
    globalObj.__goldRateIntervalInitialized = true;
    console.log("[Gold Rate Cron] Initializing gold rate scheduler...");

    // Run first cycle in the background after 10 seconds of startup
    setTimeout(() => {
      runGoldRateCronCycle().catch(err => {
        console.error("[Gold Rate Cron] Error in initial cycle:", err);
      });
    }, 10000);

    // Set recurring 2-hour interval (7,200,000 milliseconds)
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    setInterval(() => {
      runGoldRateCronCycle().catch(err => {
        console.error("[Gold Rate Cron] Error in recurring cycle:", err);
      });
    }, TWO_HOURS);
  }
}
