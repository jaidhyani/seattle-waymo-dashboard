#!/usr/bin/env node

/**
 * Fetches DC traffic fatality data from the Open Data DC API
 * and updates src/data/fatalities.json with current numbers.
 *
 * The script:
 * - Queries all fatal crashes from the DC OCTO/DDOT crash dataset
 * - Counts fatalities by year
 * - For completed years, keeps the existing manually-vetted values
 *   (the API consistently undercounts vs official sources)
 * - For the current year, uses API YTD count and projects a full-year estimate
 * - Updates the permit timeline months-waiting count
 * - Updates the last timeline entry's cumulative death count and date
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_PATH = join(__dirname, "..", "src", "data", "fatalities.json");

const API_BASE =
  "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Public_Safety_WebMercator/MapServer/24/query";

const FATAL_FIELDS = [
  "FATAL_DRIVER",
  "FATAL_BICYCLIST",
  "FATAL_PEDESTRIAN",
  "FATALPASSENGER",
];

async function queryFatalCrashes(field) {
  const records = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      where: `${field}>0`,
      outFields: `REPORTDATE,CRIMEID,${FATAL_FIELDS.join(",")}`,
      orderByFields: "REPORTDATE DESC",
      resultRecordCount: "1000",
      resultOffset: String(offset),
      f: "json",
    });

    const resp = await fetch(`${API_BASE}?${params}`);
    const data = await resp.json();

    if (data.error) {
      console.error(`API error querying ${field}:`, data.error.message);
      break;
    }

    const features = data.features || [];
    if (features.length === 0) break;

    for (const f of features) {
      records.push(f);
    }

    if (!data.exceededTransferLimit) break;
    offset += 1000;
  }

  return records;
}

function dedup(records) {
  const seen = new Map();
  for (const r of records) {
    const attrs = r.attributes;
    const geom = r.geometry || {};
    // Dedup by date + location
    const key = `${attrs.REPORTDATE}_${geom.x}_${geom.y}`;
    if (!seen.has(key)) {
      seen.set(key, attrs);
    }
  }
  return [...seen.values()];
}

function countByYear(records) {
  const yearly = {};
  for (const attrs of records) {
    const ts = attrs.REPORTDATE;
    if (ts == null) continue;
    const year = new Date(ts).getFullYear();
    const total =
      (attrs.FATAL_DRIVER || 0) +
      (attrs.FATAL_BICYCLIST || 0) +
      (attrs.FATAL_PEDESTRIAN || 0) +
      Math.floor(attrs.FATALPASSENGER || 0);
    yearly[year] = (yearly[year] || 0) + total;
  }
  return yearly;
}

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
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[now.getMonth()]} ${now.getFullYear()}`;
}

async function main() {
  console.log("Fetching fatal crash data from DC Open Data API...");

  // Query all fatal crash types
  const allRecords = [];
  for (const field of FATAL_FIELDS) {
    const records = await queryFatalCrashes(field);
    allRecords.push(...records);
    console.log(`  ${field}: ${records.length} records`);
  }

  const unique = dedup(allRecords);
  console.log(`Total unique fatal crashes: ${unique.length}`);

  const apiCounts = countByYear(unique);
  console.log("API fatality counts by year:", apiCounts);

  // Read existing data
  const data = JSON.parse(readFileSync(DATA_PATH, "utf-8"));
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth(); // 0-indexed
  let changed = false;

  // Update byYear entries — only update the current year's projection
  for (const entry of data.dcFatalities.byYear) {
    const apiCount = apiCounts[entry.year];
    if (apiCount == null) continue;

    if (entry.year === currentYear) {
      // For current year: use API count for YTD, project full year
      const monthFraction = (currentMonth + 1) / 12;
      const projected = Math.round(apiCount / monthFraction);
      if (projected !== entry.deaths) {
        console.log(
          `Updating ${entry.year}: ${entry.deaths} -> ${projected} (projected from ${apiCount} YTD through month ${currentMonth + 1})`
        );
        entry.deaths = projected;
        entry.note = `Projected from ${apiCount} YTD`;
        changed = true;
      }
    }
  }

  // Check if we need to add a new year entry
  if (!data.dcFatalities.byYear.find((e) => e.year === currentYear)) {
    const apiCount = apiCounts[currentYear] || 0;
    const monthFraction = (currentMonth + 1) / 12;
    const projected = Math.round(apiCount / monthFraction);
    data.dcFatalities.byYear.push({
      year: currentYear,
      deaths: projected,
      note: `Projected from ${apiCount} YTD`,
    });
    changed = true;
    console.log(`Added ${currentYear}: ${projected} (projected from ${apiCount} YTD)`);
  }

  // Update permit timeline months for DC
  const dcPermit = data.permitTimeline.find(
    (p) => p.city === "Washington, DC"
  );
  if (dcPermit && dcPermit.testStart) {
    const newMonths = monthsSince(dcPermit.testStart);
    if (newMonths !== dcPermit.months) {
      console.log(
        `Updating DC permit months: ${dcPermit.months} -> ${newMonths}`
      );
      dcPermit.months = newMonths;
      changed = true;
    }
  }

  // Update the last timeline entry with current date and cumulative deaths
  const lastEvent = data.timeline[data.timeline.length - 1];
  // Parse delay start year directly to avoid timezone issues
  const delayStartYear = parseInt(data.dcFatalities.delayStart.split("-")[0], 10);

  // Calculate cumulative deaths since delay start
  let cumulative = 0;
  for (const entry of data.dcFatalities.byYear) {
    if (entry.year < delayStartYear) continue;
    if (entry.year < currentYear) {
      cumulative += entry.deaths;
    } else if (entry.year === currentYear) {
      // Partial year: interpolate based on current month
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
