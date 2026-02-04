// src/index.js
// Plaud to Notion sync
// Expects these GitHub Secrets or env vars:
// PLAUD_EMAIL
// PLAUD_PASSWORD
// NOTION_TOKEN
// NOTION_DATABASE_ID
//
// Optional:
// PLAUD_LOGIN_URL (default below)
// PLAUD_APP_URL (default below)

import fs from "fs";
import path from "path";
import process from "process";
import puppeteer from "puppeteer";
import { Client as NotionClient } from "@notionhq/client";

const PLAUD_LOGIN_URL = process.env.PLAUD_LOGIN_URL || "https://app.plaud.ai/login";
const PLAUD_APP_URL = process.env.PLAUD_APP_URL || "https://app.plaud.ai";

const REQUIRED_ENV = ["PLAUD_EMAIL", "PLAUD_PASSWORD", "NOTION_TOKEN", "NOTION_DATABASE_ID"];
for (const k of REQUIRED_ENV) {
  if (!process.env[k] || String(process.env[k]).trim() === "") {
    throw new Error(`Missing required environment variable: ${k}`);
  }
}

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });

function normalizeNotionId(input) {
  // Accepts:
  // 2fdf8297bca080b88f84cee29988a2d6
  // 2fdf8297-bca0-80b8-8f84-cee29988a2d6
  // https://www.notion.so/Some-Name-2fdf8297bca080b88f84cee29988a2d6
  const raw = String(input).trim();
  const hex32 = raw.match(/[0-9a-fA-F]{32}/)?.[0];
  if (!hex32) return raw;
  const h = hex32.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function safeText(v, max = 1900) {
  const s = v == null ? "" : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function loadSyncedIds(filePath) {
  try {
    const txt = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(txt);
    if (Array.isArray(parsed)) return new Set(parsed.map(String));
    if (parsed && Array.isArray(parsed.ids)) return new Set(parsed.ids.map(String));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveSyncedIds(filePath, idSet) {
  const arr = Array.from(idSet);
  arr.sort();
  fs.writeFileSync(filePath, JSON.stringify({ ids: arr, updatedAt: new Date().toISOString() }, null, 2));
}

function pickRecordingFields(r) {
  // This is defensive because Plaud payload fields can vary
  const id =
    r?.id ||
    r?.noteId ||
    r?.recordingId ||
    r?.uuid ||
    r?._id ||
    r?.data?.id;

  const title =
    r?.title ||
    r?.name ||
    r?.topic ||
    r?.summaryTitle ||
    r?.data?.title ||
    r?.data?.name;

  const summary =
    r?.summary ||
    r?.abstract ||
    r?.overview ||
    r?.data?.summary ||
    r?.data?.abstract ||
    r?.data?.overview ||
    "";

  const createdAt =
    r?.createdAt ||
    r?.created_at ||
    r?.startTime ||
    r?.start_time ||
    r?.timestamp ||
    r?.data?.createdAt ||
    r?.data?.created_at;

  const audioUrl =
    r?.audioUrl ||
    r?.audio_url ||
    r?.audioURL ||
    r?.audio ||
    r?.mediaUrl ||
    r?.media_url ||
    r?.data?.audioUrl ||
    r?.data?.audio_url ||
    "";

  return {
    id: id ? String(id) : "",
    title: title ? String(title) : "",
    summary: summary ? String(summary) : "",
    createdAt,
    audioUrl: audioUrl ? String(audioUrl) : ""
  };
}

async function loginToPlaud(page) {
  await page.goto(PLAUD_LOGIN_URL, { waitUntil: "domcontentloaded" });

  // Wait for email and password fields
  const emailSelector = 'input[type="email"], input[name="email"], input[autocomplete="email"]';
  const passSelector = 'input[type="password"], input[name="password"], input[autocomplete="current-password"]';

  await page.waitForSelector(emailSelector, { timeout: 30000 });
  await page.waitForSelector(passSelector, { timeout: 30000 });

  await page.click(emailSelector, { clickCount: 3 });
  await page.type(emailSelector, process.env.PLAUD_EMAIL, { delay: 10 });

  await page.click(passSelector, { clickCount: 3 });
  await page.type(passSelector, process.env.PLAUD_PASSWORD, { delay: 10 });

  // Click Log in button
  // The login button text on your screenshot is "Log in"
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const target = buttons.find(b => (b.textContent || "").trim().toLowerCase() === "log in");
    if (target) {
      target.click();
      return true;
    }
    return false;
  });

  if (!clicked) {
    // Fallback: submit the form
    await page.keyboard.press("Enter");
  }

  // Wait for navigation into app
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
  if (!page.url().startsWith(PLAUD_APP_URL)) {
    await page.goto(PLAUD_APP_URL, { waitUntil: "networkidle2" }).catch(() => {});
  }
}

async function captureRecordingsFromNetwork(page, ms = 20000) {
  const recordings = [];
  const seenPayloads = new Set();

  const handler = async (response) => {
    try {
      const url = response.url();
      const ct = response.headers()?.["content-type"] || "";

      if (!ct.includes("application/json")) return;

      // Heuristics for likely endpoints
      const looksRelevant =
        url.toLowerCase().includes("record") ||
        url.toLowerCase().includes("note") ||
        url.toLowerCase().includes("meeting");

      if (!looksRelevant) return;

      const json = await response.json().catch(() => null);
      if (!json) return;

      const sig = JSON.stringify(json).slice(0, 5000);
      if (seenPayloads.has(sig)) return;
      seenPayloads.add(sig);

      const candidates = [];

      if (Array.isArray(json)) candidates.push(...json);

      if (json && Array.isArray(json.items)) candidates.push(...json.items);
      if (json && Array.isArray(json.data)) candidates.push(...json.data);
      if (json && json.data && Array.isArray(json.data.items)) candidates.push(...json.data.items);
      if (json && json.result && Array.isArray(json.result)) candidates.push(...json.result);
      if (json && json.result && Array.isArray(json.result.items)) candidates.push(...json.result.items);

      for (const c of candidates) {
        const rec = pickRecordingFields(c);
        if (rec.id) recordings.push(rec);
      }
    } catch {
      // ignore
    }
  };

  page.on("response", handler);

  // Try to trigger list load
  // If the app uses a single page, this often pulls the list automatically after login
  await page.waitForTimeout(1000);
  await page.mouse.wheel({ deltaY: 800 }).catch(() => {});
  await page.waitForTimeout(ms);

  page.off("response", handler);

  // De dupe by id
  const map = new Map();
  for (const r of recordings) {
    if (!r.id) continue;
    if (!map.has(r.id)) map.set(r.id, r);
  }
  return Array.from(map.values());
}

async function writeRecordingToNotion(recording) {
  const dbId = normalizeNotionId(process.env.NOTION_DATABASE_ID);

  const title = recording.title?.trim() || "Untitled";
  const summary = recording.summary || "";
  const audioUrl = recording.audioUrl || "";
  const created = recording.createdAt ? new Date(recording.createdAt) : new Date();
  const createdISO = isNaN(created.getTime()) ? new Date().toISOString() : created.toISOString();

  // Properties assume your database has these columns:
  // Name (title), Date (date), Summary (rich text), Audio (url), Source (rich text), ID (rich text)
  // If any are missing, Notion will throw a validation error.
  const properties = {
    Name: {
      title: [{ text: { content: safeText(title, 200) } }]
    },
    Date: {
      date: { start: createdISO }
    },
    Summary: {
      rich_text: summary ? [{ text: { content: safeText(summary) } }] : []
    },
    Audio: {
      url: audioUrl || null
    },
    Source: {
      rich_text: [{ text: { content: `Plaud:${recording.id}` } }]
    },
    ID: {
      rich_text: [{ text: { content: safeText(recording.id, 200) } }]
    }
  };

  const children = [];

  if (summary) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "Summary" } }] }
    });
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: safeText(summary) } }] }
    });
  }

  if (audioUrl) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "Audio" } }] }
    });

    // Notion does not let you upload a binary audio file directly via the public API
    // This embeds the link and keeps it in the Audio column as well
    children.push({
      object: "block",
      type: "embed",
      embed: { url: audioUrl }
    });
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          { type: "text", text: { content: "Audio link: " } },
          { type: "text", text: { content: audioUrl, link: { url: audioUrl } } }
        ]
      }
    });
  }

  const page = await notion.pages.create({
    parent: { database_id: dbId },
    properties,
    children
  });

  return page?.id || "";
}

async function main() {
  console.log("Starting Plaud to Notion sync...");
  console.log("Previously synced: tracking via synced-recordings.json");

  const syncFile = path.resolve(process.cwd(), "synced-recordings.json");
  const synced = loadSyncedIds(syncFile);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  try {
    console.log("Navigating to Plaud login...");
    await loginToPlaud(page);

    console.log("Opening Plaud app area...");
    await page.waitForTimeout(2000);

    console.log("Capturing recordings from Plaud network responses...");
    const recordings = await captureRecordingsFromNetwork(page, 25000);

    console.log(`Captured ${recordings.length} recordings from Plaud`);

    const newOnes = recordings.filter(r => r.id && !synced.has(r.id));
    console.log(`New recordings to write: ${newOnes.length}`);

    for (const r of newOnes) {
      console.log(`Writing to Notion: ${r.title || "Untitled"} (${r.id})`);
      await writeRecordingToNotion(r);
      synced.add(r.id);
    }

    saveSyncedIds(syncFile, synced);

    console.log("Sync completed.");
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

await main();
