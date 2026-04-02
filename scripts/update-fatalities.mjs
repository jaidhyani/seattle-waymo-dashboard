#!/usr/bin/env node

/**
 * Updates src/data/fatalities.json with current Seattle data.
 *
 * Unlike DC's version, Seattle doesn't have a convenient open data API
 * for fatal crashes. This script:
 * - Updates the permit timeline months-waiting count for Seattle
 * - Updates the last timeline entry's cumulative death count and date
 * - Projects current year fatalities based on YTD if manually updated
 *
 * Fatality data should be manually updated from SDOT Vision Zero reports.
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_PATH = join(__dirname, "..", "src", "data", "fatalities.json");

function monthsSince(dateStr) {
  const start = new Date(dateStr + "-01");
  const now = new Date();
  return (
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth())
  );
}

function currentMonthLabel() {
  const now = new Date();
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[now.getMonth()]} ${now.getFullYear()}`;
}

async function main() {
  const data = JSON.parse(readFileSync(DATA_PATH, "utf-8"));
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth();
  let changed = false;

  // Update permit timeline months for Seattle
  const seaPermit = data.permitTimeline.find(
    (p) => p.city === "Seattle, WA"
  );
  if (seaPermit && seaPermit.testStart) {
    const newMonths = monthsSince(seaPermit.testStart);
    if (newMonths !== seaPermit.months) {
      console.log(
        `Updating Seattle permit months: ${seaPermit.months} -> ${newMonths}`
      );
      seaPermit.months = newMonths;
      changed = true;
    }
  }

  // Update the last timeline entry with current date and cumulative deaths
  const lastEvent = data.timeline[data.timeline.length - 1];
  const delayStartYear = parseInt(data.seattleFatalities.delayStart.split("-")[0], 10);

  let cumulative = 0;
  for (const entry of data.seattleFatalities.byYear) {
    if (entry.year < delayStartYear) continue;
    if (entry.year < currentYear) {
      cumulative += entry.deaths;
    } else if (entry.year === currentYear) {
      cumulative += Math.round(entry.deaths * ((currentMonth + 1) / 12));
    }
  }

  const newDateLabel = currentMonthLabel();
  if (
    lastEvent.date !== newDateLabel ||
    lastEvent.cumulativeDeaths !== cumulative
  ) {
    console.log(
      `Updating last timeline entry: "${lastEvent.date}" (${lastEvent.cumulativeDeaths}) -> "${newDateLabel}" (${cumulative})`
    );
    lastEvent.date = newDateLabel;
    lastEvent.cumulativeDeaths = cumulative;
    changed = true;
  }

  if (changed) {
    writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
    console.log("fatalities.json updated.");
  } else {
    console.log("No changes needed.");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
