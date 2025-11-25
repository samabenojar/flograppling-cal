import * as cheerio from "cheerio";
import { chromium, type Browser } from "playwright";

/** Event shape consumed by index.ts */
export interface FGEvent {
  name: string;
  dateISO: string;
  location: string;
  url: string;
}

/* ---------- JSON-LD helpers ---------- */
type Json = any;

function parseJsonLdFrom(html: string): Json[] {
  const $ = cheerio.load(html);
  const blocks: Json[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text().trim();
    try {
      const parsed = JSON.parse(txt);
      blocks.push(parsed);
    } catch { /* ignore */ }
  });
  return blocks;
}

function* walk(obj: any): Generator<any> {
  if (obj && typeof obj === "object") {
    yield obj;
    if (Array.isArray(obj)) {
      for (const it of obj) yield* walk(it);
    } else {
      for (const v of Object.values(obj)) yield* walk(v);
    }
  }
}

function urlsFromJsonLd(blobs: Json[], base = "https://www.flograppling.com"): string[] {
  const urls = new Set<string>();
  for (const blob of blobs) {
    for (const node of walk(blob)) {
      const t = (node?.["@type"] || node?.type || "").toString();
      // Direct Event
      if (/Event$/i.test(t) && typeof node.url === "string") {
        try { urls.add(new URL(node.url, base).toString()); } catch {}
      }
      // ItemList (events index)
      if (/ItemList$/i.test(t)) {
        const items = node.itemListElement ?? node.item ?? [];
        const arr = Array.isArray(items) ? items : [items];
        for (const it of arr) {
          const maybe = it?.url ?? it?.item?.url ?? it?.["@id"];
          if (typeof maybe === "string") {
            try {
              const u = new URL(maybe, base).toString();
              if (u.includes("/events/")) urls.add(u);
            } catch {}
          }
        }
      }
    }
  }
  return Array.from(urls);
}

function parseSingleEvent(blobs: Json[], fallbackUrl: string): FGEvent | null {
  let best: any | null = null;
  for (const blob of blobs) {
    for (const node of walk(blob)) {
      const t = (node?.["@type"] || node?.type || "").toString();
      if (/Event$/i.test(t) && (node.startDate || node.endDate)) {
        best = node; break;
      }
    }
    if (best) break;
  }
  if (!best) return null;

  const name: string = (best.name ?? "").toString().trim() || "FloGrappling Event";
  const dateISO: string = (best.startDate ?? best.endDate ?? "").toString().trim();
  let location = "TBA";
  const loc = best.location ?? best.locationName ?? {};
  if (typeof loc === "string") {
    location = loc.trim() || "TBA";
  } else if (typeof loc === "object") {
    const parts = [
      loc.name,
      loc.address?.addressLocality,
      loc.address?.addressRegion,
      loc.address?.addressCountry,
    ].filter(Boolean).map((s: any) => String(s).trim());
    if (parts.length) location = parts.join(", ");
  }

  let url = best.url ?? best["@id"] ?? fallbackUrl;
  try { url = new URL(url, "https://www.flograppling.com").toString(); } catch { url = fallbackUrl; }

  if (!dateISO) return null;
  return { name, dateISO, location, url };
}

/* ---------- Browser helpers ---------- */
async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try { return await fn(browser); }
  finally { await browser.close(); }
}

async function getRenderedHtml(url: string): Promise<string> {
  return withBrowser(async (browser) => {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) FloCalBot/1.0 Chrome/122 Safari/537.36",
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // Give client-side JS a moment to inject JSON-LD / content
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    const html = await page.content();
    await ctx.close();
    return html;
  });
}

/* ---------- Public API for index.ts ---------- */

export async function discoverEventUrls(): Promise<string[]> {
  const base = "https://www.flograppling.com";
  const indexUrl = `${base}/events`;

  // render the index page to let JS populate it
  const html = await getRenderedHtml(indexUrl);
  const blobs = parseJsonLdFrom(html);
  let urls = urlsFromJsonLd(blobs, base);

  // Fallback: also scan visible anchors
  if (urls.length === 0) {
    const $ = cheerio.load(html);
    const set = new Set<string>();
    $("a[href*='/events/']").each((_, a) => {
      const href = $(a).attr("href");
      if (!href) return;
      try {
        const u = new URL(href, base).toString();
        if (u.includes("/events/")) set.add(u);
      } catch {}
    });
    urls = Array.from(set);
  }

  // keep it reasonable
  return urls.slice(0, 40);
}

export async function scrapeEvent(url: string): Promise<FGEvent | null> {
  try {
    const html = await getRenderedHtml(url);
    const blobs = parseJsonLdFrom(html);
    return parseSingleEvent(blobs, url);
  } catch (e) {
    console.error("scrapeEvent error:", url, e);
    return null;
  }
}

export async function getAllEvents(): Promise<FGEvent[]> {
  const urls = await discoverEventUrls();
  console.log("Event URLs found:", urls);
  const out: FGEvent[] = [];

  for (const u of urls) {
    // be a little polite
    await new Promise((r) => setTimeout(r, 200));
    const ev = await scrapeEvent(u);
    if (ev) out.push(ev);
  }

    // keep a wider window: past 30d … next 365d
  const now = Date.now();
  const windowPastMs = 30 * 24 * 3600 * 1000;
  const windowFutureMs = 365 * 24 * 3600 * 1000;

  const kept = out.filter((e) => {
    const t = Date.parse(e.dateISO);
    return Number.isFinite(t) && t >= (now - windowPastMs) && t <= (now + windowFutureMs);
  });

  kept.sort((a, b) => Date.parse(a.dateISO) - Date.parse(b.dateISO));
  console.log("✅ Retrieved", kept.length, "events after windowing.");
  return kept;
}

