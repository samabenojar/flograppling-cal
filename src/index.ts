import fs from "fs";
import path from "path";
import { createEvents, type DateArray, type EventAttributes } from "ics";
import { getAllEvents, type FGEvent } from "./scrape.js";

function toDateArray(iso: string): DateArray {
  const d = new Date(iso);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
}

function toIcsEvent(e: FGEvent, calName = "FloGrappling"): EventAttributes {
  return {
    start: toDateArray(e.dateISO),
    duration: { hours: 3 },
    title: e.name,
    description: `${e.url}\n\nAccurate as of ${new Date().toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "numeric",
      timeZone: "America/Toronto", timeZoneName: "short",
    })}`,
    location: e.location,
    uid: e.url,
    calName,
    alarms: [
      {
        action: "display",
        description: `${e.name} starting soon!`,
        trigger: { minutes: 30, before: true },
      },
    ],
  };
}

async function main() {
  try {
    console.log("🟢 Fetching FloGrappling events…");
    const events = await getAllEvents();
    console.log(`✅ Retrieved ${events.length} events.`);

    const all = events.map((e) => toIcsEvent(e, "FloGrappling"));
    const { error, value } = createEvents(all);
    if (error) throw error;

    const out = path.join(process.cwd(), "FloGrappling.ics");
    fs.writeFileSync(out, value!, "utf8");
    console.log(`✅ Wrote ${out} (${Buffer.byteLength(value!, "utf8")} bytes)`);

    console.log("🎯 Done.");
  } catch (e) {
    console.error("❌ Error generating ICS:", e);
    process.exitCode = 1;
  }
}

main();
