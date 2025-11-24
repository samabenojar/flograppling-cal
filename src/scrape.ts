import * as cheerio from "cheerio";
import { setTimeout as wait } from "node:timers/promises";

/**
 * Event shape used by index.ts
 */
export interface FGEvent {
  name: string;
  dateISO: string;     // ISO 8601 date time string
  location: string;    // "Venue, City, Country" or "TBA"
  url: string;         // canonical URL
}

// -------- HTTP helper (polite with headers) --------
async function get(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; FloGrapplingCal/1.0; +https://github.com/samabenojar/flograppling-cal)",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return await res.text();
}

// -------- JSON-LD utilities --------
type Json = any;

function safeParse(jsonText: string): Json | null {
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function* walk(obj: Json): Generator<Json> {
  if (obj && typeof obj === "object") {
    yield obj;
    if (Array.isArray(obj)) {
      for (const it of obj) yield* walk(it);
    } else {
      for (const v of Object.values(obj)) yield* walk(v);
    }
  }
}

/**
 * Extract JSON-LD blocks from an HTML string.
 */
function extractJsonLd(html: string): Json[] {
  const $ = cheerio.load(html);
  const blocks: Json[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text().trim();
    const parsed = safeParse(txt);
    if (parsed) blocks.push(parsed);
  });
  return blocks;
}

/**
 * From any JSON-LD blob(s), collect URLs that look like event pages.
 * Supports ItemList (list pages) and Event objects.
 */
function discoverUrlsFromJsonLd(blobs: Json[], base = "https://www.flograppling.com"): string[] {
  const urls = new Set<string>();

  for (const blob of blobs) {
    for (const node of walk(blob)) {
      const type = (node?.["@type"] || node?.type || "").toString();

      // Direct Event objects
      if (/Event$/i.test(type) && typeof node.url === "string") {
        try {
          urls.add(new URL(node.url, base).toString());
        } catch { /* ignore */ }
      }

      // ItemList of events (common on index pages)
      if (/ItemList$/i.test(type)) {
        const items = node.itemListElement ?? node.item ?? [];
        const arr = Array.isArray(items) ? items : [items];
        for (const it of arr) {
          const maybe = it?.url ?? it?.item?.url ?? it?.["@id"];
          if (typeof maybe === "string") {
            try {
              const u = new URL(maybe, base).toString();
              if (u.includes("/events/")) urls.add(u);
            } catch { /* ignore */ }
          }
        }
      }
    }
  }

  return Array.from(urls);
}

/**
 * Parse a single Event object from JSON-LD on an event page.
 */
function parseEventFromJsonLd(blobs: Json[], fallbackUrl: string): FGEvent | null {
  let best: any | null = null;

  for (const blob of blobs) {
    for (const node of walk(blob)) {
      const type = (node?.["@type"] || node?.type || "").toString();
      if (/Event$/i.test(type)) {
        // Prefer nodes with startDate
        if (node.startDate) {
          best = node;
          break;
        }
      }
    }
    if (best) break;
  }

  if (!best) return null;

  const name: string =
    (best.name ?? "").toString().trim() || "FloGrappling Event";

  // Prefer startDate; fallback to endDate if needed
  const dateISO: string =
    (best.startDate ?? best.endDate ?? "").toString().trim();

  // Location can be an object with nested fields
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
    ]
      .filter(Boolean)
      .map((s: string) => s.toString().trim());
    if (parts.length) location = parts.join(", ");
  }

  let url = best.url ?? best["@id"] ?? fallbackUrl;
  try {
    url = new URL(url, "https://www.flograppling.com").toString();
  } catch {
    url = fallbackUrl;
  }

  if (!dateISO) return null; // require a date

  return { name, dateISO, location, url };
}

// -------- Public API (used by index.ts) --------

/**
 * Discover candidate event URLs from the events index using JSON-LD.
 * Fallback to anchors if needed.
 */
export async function discoverEventUrls(): Promise<string[]> {
  const base = "https://www.flograppling.com";
  const indexUrl = `${base}/events`;
  const html = await get(indexUrl);

  // 1) JSON-LD discovery (preferred)
  const jsonld = extractJsonLd(html);
  const fromLd = discoverUrlsFromJsonLd(jsonld, base);

  // 2) Fallback: basic anchor discovery
  const $ = cheerio.load(html);
  const fromAnchors = new Set<string>();
  $("a[href*='/events/']").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    try {
      const u = new URL(href, base).toString();
      if (u.includes("/events/")) fromAnchors.add(u);
    } catch { /* ignore */ }
  });

  const urls = new Set<string>([...fromLd, ...fromAnchors]);
  // Keep it sane
  return Array.from(urls).slice(0, 40);
}

/**
 * Scrape a single event page by reading its JSON-LD.
 */
export async function scrapeEvent(url: string): Promise<FGEvent | null> {
  try {
    await wait(200); // be polite
    const html = await get(url);
    const blobs = extractJsonLd(html);
    const ev = parseEventFromJsonLd(blobs, url);
    return ev;
  } catch (e) {
    console.error("scrapeEvent error:", url, e);
    return null;
  }
}

/**
 * Main entry used by index.ts: find, fetch, normalize, sort, and filter.
 */
export async function getAllEvents(): Promise<FGEvent[]> {
  const urls = await discoverEventUrls();

  // If the index returns nothing (dynamic day), try a known collection page
  // You can add more discovery URLs here if needed.
  if (urls.length === 0) {
    console.warn("No events found on /events; trying fallback collection pages");
    // Example fallback(s). Add/remove as you learn their structure.
    const fallbacks = [
      "https://www.flograppling.com/collections", // sometimes lists upcoming
    ];
    for (const fb of fallbacks) {
      try {
        const html = await get(fb);
        const blobs = extractJsonLd(html);
        const more = discoverUrlsFromJsonLd(blobs, "https://www.flograppling.com");
        more.forEach((u) => urls.push(u));
      } catch { /* ignore */ }
    }
  }

  const out: FGEvent[] = [];
  for (const u of urls) {
    const ev = await scrapeEvent(u);
    if (ev) out.push(ev);
  }

  // Normalize & filter
  const now = Date.now();
  const upcoming = out.filter((e) => {
    const t = Date.parse(e.dateISO);
    return Number.isFinite(t) && t >= now - 3 * 24 * 3600 * 1000; // keep a 3-day tolerance
  });

  // sort ascending by start
  upcoming.sort((a, b) => Date.parse(a.dateISO) - Date.parse(b.dateISO));
  return upcoming;
}
