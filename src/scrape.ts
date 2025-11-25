import * as cheerio from "cheerio";
import { chromium, type Browser } from "playwright";

/** Shape consumed by index.ts */
export interface FGEvent {
  name: string;
  dateISO: string;   // ISO 8601
  location: string;
  url: string;
}

/* ---------------- JSON-LD helpers ---------------- */

type Json = any;

function parseJsonLdFrom(html: string): Json[] {
  const $ = cheerio.load(html);
  const blocks: Json[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text().trim();
    try {
      const parsed = JSON.parse(txt);
      blocks.push(parsed);
    } catch { /* ignore JSON parse errors */ }
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

      // Some feeds nest events as "subEvent"
      if (Array.isArray(node?.subEvent)) {
        for (const se of node.subEvent) {
          const tt = (se?.["@type"] || se?.type || "").toString();
          if (/Event$/i.test(tt) && typeof se.url === "string") {
            try { urls.add(new URL(se.url, base).toString()); } catch {}
          }
        }
      }
    }
  }
  return Array.from(urls);
}

/* ---------------- Event parsing ---------------- */

function parseSingleEvent(blobs: Json[], fallbackUrl: string): FGEvent | null {
  // Prefer Event with startDate; else check subEvent
  let best: any | null = null;

  for (const blob of blobs) {
    for (const node of walk(blob)) {
      const t = (node?.["@type"] || node?.type || "").toString();

      if (/Event$/i.test(t) && (node.startDate || node.endDate)) {
        best = node; break;
      }
      if (Array.isArray(node?.subEvent)) {
        const se = node.subEvent.find(
          (x: any) =>
            /Event$/i.test((x?.["@type"] || x?.type || "").toString()) &&
            (x.startDate || x.endDate)
        );
        if (se) { best = se; break; }
      }
    }
    if (best) break;
  }

  if (!best) return null;

  const name: string = (best.name ?? "").toString().trim() || "FloGrappling Event";

  // Normalize timezone if missing (assume UTC)
  const rawISO = (best.startDate ?? best.endDate ?? "").toString().trim();
  const dateISO = (/\dZ$/.test(rawISO) || /[+-]\d{2}:\d{2}$/.test(rawISO)) ? rawISO : rawISO + "Z";

  // Location may be object or string
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

/* ---------------- Browser helpers ---------------- */

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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await Promise.race([
      page.waitForSelector('script[type="application/ld+json"]', { timeout: 20_000 }),
      page.waitForLoadState("networkidle", { timeout: 20_000 }),
    ]).catch(() => {});
    const html = await page.content();
    await ctx.close();
    return html;
  });
}

/* ---------------- Public API for index.ts ---------------- */

/** Discover events across current + next 6 months (month tabs via ?date=YYYY-MM-01). */
export async function discoverEventUrls(): Promise<string[]> {
  const base = "https://www.flograppling.com";
  const urls = new Set<string>();

  const start = new Date(); start.setDate(1);
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setMonth(start.getMonth() + i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const indexUrl = `${base}/events?date=${y}-${m}-01`;

    const html = await getRenderedHtml(indexUrl);
    const blobs = parseJsonLdFrom(html);
    urlsFromJsonLd(blobs, base).forEach(u => urls.add(u));

    // Fallback: anchors (if JSON-LD is sparse)
    const $ = cheerio.load(html);
    $("a[href*='/events/']").each((_, a) => {
      const href = $(a).attr("href");
      if (!href) return;
      try {
        const u = new URL(href, base).toString();
        if (u.includes("/events/")) urls.add(u);
      } catch {}
    });
  }

  const list = Array.from(urls);
  console.log("Event URLs found:", list);
  return list.slice(0, 80); // safety cap
}

/** Scrape one event page: JSON-LD first; fallback to DOM/script if needed. */
export async function scrapeEvent(url: string): Promise<FGEvent | null> {
  try {
    const html = await getRenderedHtml(url);

    // Try JSON-LD
    const blobs = parseJsonLdFrom(html);
    const byLd = parseSingleEvent(blobs, url);
    if (byLd) return byLd;

    // Fallbacks when no JSON-LD with dates
    const $ = cheerio.load(html);

    const name =
      $('meta[property="og:title"]').attr("content")?.trim() ||
      $("h1").first().text().trim() ||
      "FloGrappling Event";

    // 1) <time datetime="...">
    let dateISO = $("time[datetime]").attr("datetime")?.trim() || "";

    // 2) ISO-like strings in scripts
    if (!dateISO) {
      const scripts = $("script")
        .map((_, s) => $(s).contents().text())
        .get()
        .join("\n");
      const m = scripts.match(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/
      );
      if (m) dateISO = m[0];
    }

    if (dateISO && !(/[Z]|[+-]\d{2}:\d{2}$/.test(dateISO))) dateISO += "Z";

    const location =
      $('[class*="location"], [data-testid*="location"]').first().text().trim() ||
      $('meta[property="og:site_name"]').attr("content")?.trim() ||
      "TBA";

    if (!dateISO) return null;
    return { name, dateISO, location, url };
  } catch (e) {
    console.error("scrapeEvent error:", url, e);
    return null;
  }
}

/** Orchestrate: discover, scrape, filter (past 30d…next 12mo), sort. */
export async function getAllEvents(): Promise<FGEvent[]> {
  const urls = await discoverEventUrls();
  const out: FGEvent[] = [];

  for (const u of urls) {
    console.log("Getting details from:", u);
    await new Promise((r) => setTimeout(r, 200)); // be polite
    const ev = await scrapeEvent(u);
    if (ev) {
      console.log("✅ Parsed:", ev.name, "→", ev.dateISO);
      out.push(ev);
    } else {
      console.log("⚠️ Skipped (no date):", u);
    }
  }

  // Window: keep past 30 days to next 365 days
  const now = Date.now();
  const kept = out.filter((e) => {
    const t = Date.parse(e.dateISO);
    return Number.isFinite(t) && t >= now - 30 * 24 * 3600 * 1000 && t <= now + 365 * 24 * 3600 * 1000;
  });

  kept.sort((a, b) => Date.parse(a.dateISO) - Date.parse(b.dateISO));
  console.log("✅ Retrieved", kept.length, "events after windowing.");
  return kept;
}
