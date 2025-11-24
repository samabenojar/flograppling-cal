import * as cheerio from "cheerio";
import { setTimeout as wait } from "node:timers/promises";

// Simple fetch wrapper with backoff
async function get(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; EventCalendarBot/1.0)",
      "accept": "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return await res.text();
}

export interface FGEvent {
  name: string;
  dateISO: string;          // e.g. "2025-10-18T23:00:00Z"
  location: string;
  url: string;
}

// Discover a handful of upcoming events from /events
export async function discoverEventUrls(): Promise<string[]> {
  const html = await get("https://www.flograppling.com/events");
  const $ = cheerio.load(html);

  // Heuristic: anchor tags under cards that look like events
  const urls = new Set<string>();
  $("a[href*='/events/']").each((_, a) => {
    const href = $(a).attr("href");
    if (href && /^\/events\/\d+/.test(href)) urls.add(new URL(href, "https://www.flograppling.com").toString());
  });

  return Array.from(urls).slice(0, 30); // cap for safety
}

// Scrape minimal structured data from an event page
export async function scrapeEvent(url: string): Promise<FGEvent | null> {
  try {
    await wait(200); // be polite
    const html = await get(url);
    const $ = cheerio.load(html);

    // Title
    const name =
      $('meta[property="og:title"]').attr("content")?.trim() ||
      $("h1").first().text().trim() ||
      "FloGrappling Event";

    // Location (best-effort; adjust selectors as needed)
    const location =
      $('meta[property="og:site_name"]').attr("content")?.trim() ||
      $('[class*="location"], [data-testid*="location"]').first().text().trim() ||
      "TBA";

    // Start date/time – try structured data first
    let dateISO =
      $('meta[property="article:published_time"]').attr("content") ||
      $('time[datetime]').attr("datetime") ||
      "";

    // Fallback: try to parse a visible date string (you may refine this)
    if (!dateISO) {
      const dateTxt =
        $('[class*="date"], [data-testid*="date"]').first().text().trim();
      // TODO: parse with a date lib if needed
    }

    // If we still couldn't find a date, skip
    if (!dateISO) return null;

    return { name, dateISO, location, url };
  } catch (e) {
    console.error("scrapeEvent error:", url, e);
    return null;
  }
}

export async function getAllEvents(): Promise<FGEvent[]> {
  const urls = await discoverEventUrls();
  console.log("Event URLs found:", urls);
  const results: FGEvent[] = [];
  for (const u of urls) {
    const e = await scrapeEvent(u);
    if (e) results.push(e);
  }
  // sort ascending by date
  results.sort((a, b) => +new Date(a.dateISO) - +new Date(b.dateISO));
  return results;
}
