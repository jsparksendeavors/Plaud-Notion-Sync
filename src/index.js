import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import { Client } from "@notionhq/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing required environment variable: ${name}`);
  return String(v).trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeDbId(input) {
  // Accepts raw 32 char id, or id with dashes
  const v = String(input).trim();
  const onlyHex = v.replace(/-/g, "");
  return onlyHex;
}

async function loadSyncedIds() {
  const fp = path.join(process.cwd(), "synced-recordings.json");
  try {
    const raw = await fs.readFile(fp, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.map(String));
    if (parsed && Array.isArray(parsed.ids)) return new Set(parsed.ids.map(String));
    return new Set();
  } catch {
    return new Set();
  }
}

async function saveSyncedIds(setOfIds) {
  const fp = path.join(process.cwd(), "synced-recordings.json");
  const ids = Array.from(setOfIds);
  await fs.writeFile(fp, JSON.stringify(ids, null, 2) + "\n", "utf8");
}

async function waitForAnySelector(page, selectors, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) return { selector: sel, element: el };
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for selectors: ${selectors.join(", ")}`);
}

async function typeInto(page, selectors, value) {
  const { element } = await waitForAnySelector(page, selectors, 20000);
  await element.click({ clickCount: 3 });
  await page.keyboard.type(value, { delay: 20 });
}

async function loginToPlaud(page, baseUrl, email, password) {
  console.log("Navigating to Plaud login...");
  await page.goto(baseUrl, { waitUntil: "networkidle2" });

  // Some apps land on home then redirect to login. Give it a moment.
  await sleep(1000);

  // Email field
  console.log("Waiting for email input...");
  await typeInto(
    page,
    [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="email" i]',
    ],
    email
  );

  // Password field
  console.log("Waiting for password input...");
  await typeInto(
    page,
    [
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
      'input[placeholder*="password" i]',
    ],
    password
  );

  // Submit without relying on a button selector
  console.log("Submitting login...");
  await page.keyboard.press("Enter");

  // Wait for either navigation or a clear post login signal
  // We do a race: either URL changes, or a known logged in element appears
  const loggedInSelectors = [
    'a[href*="record" i]',
    'a[href*="note" i]',
    'button[aria-label*="profile" i]',
    '[data-testid*="user" i]',
  ];

  try {
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }),
      (async () => {
        await waitForAnySelector(page, loggedInSelectors, 45000);
      })(),
    ]);
  } catch {
    // Not fatal yet. We will check for login failure.
  }

  // Detect obvious login failure messages
  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  const lower = bodyText.toLowerCase();
  if (lower.includes("incorrect") || lower.includes("invalid") || lower.includes("wrong password")) {
    throw new Error("Plaud login appears to have failed. Check PLAUD_EMAIL and PLAUD_PASSWORD.");
  }

  console.log("Login step completed. Proceeding...");
}

function extractRecordingsFromApiJson(json) {
  // We do not know Plaud schema exactly, so we check common shapes.
  // Return array of { id, title, createdAt, summary, sourceUrl, transcript }
  if (!json || typeof json !== "object") return [];

  const candidates = [];

  const maybeArrays = [];
  for (const k of Object.keys(json)) {
    if (Array.isArray(json[k])) maybeArrays.push(json[k]);
  }
  // Common nesting patterns
  if (Array.isArray(json.recordings)) maybeArrays.push(json.recordings);
  if (Array.isArray(json.data)) maybeArrays.push(json.data);
  if (json.data && Array.isArray(json.data.recordings)) maybeArrays.push(json.data.recordings);
  if (json.result && Array.isArray(json.result.recordings)) maybeArrays.push(json.result.recordings);

  for (const arr of maybeArrays) {
    for (const r of arr) {
      if (!r || typeof r !== "object") continue;
      const id = r.id ?? r.recordingId ?? r.uuid ?? r._id;
      if (!id) continue;

      const title = r.title ?? r.name ?? r.recordingName ?? "Plaud Recording";
      const createdAt = r.createdAt ?? r.created_at ?? r.time ?? r.date ?? null;
      const summary = r.summary ?? r.brief ?? r.aiSummary ?? "";
      const transcript = r.transcript ?? r.text ?? r.content ?? "";
      const sourceUrl = r.url ?? r.webUrl ?? r.shareUrl ?? "";

      candidates.push({
        id: String(id),
        title: String(title),
        createdAt,
        summary: summary ? String(summary) : "",
        transcript: transcript ? String(transcript) : "",
        sourceUrl: sourceUrl ? String(sourceUrl) : "",
      });
    }
  }

  // Deduplicate by id
  const map = new Map();
  for (const c of candidates) map.set(c.id, c);
  return Array.from(map.values());
}

async function getPlaudRecordings(page) {
  console.log("Opening Plaud app area...");
  // Try to nudge app to a recordings area. We do not assume exact route.
  // Most apps expose something like /recordings or /notes. We attempt both.
  const current = page.url();
  const base = new URL(current);
  const tryUrls = [
    new URL("/recordings", base).toString(),
    new URL("/notes", base).toString(),
    new URL("/app", base).toString(),
  ];

  let recordings = [];
  const apiPayloads = [];

  page.on("response", async (resp) => {
    const url = resp.url();
    // Heuristic: capture api responses that look like they contain recordings list
    if (!/api|record|note|transcript|meeting/i.test(url)) return;
    const json = await safeJson(resp);
    if (!json) return;

    const extracted = extractRecordingsFromApiJson(json);
    if (extracted.length) {
      apiPayloads.push(...extracted);
    }
  });

  for (const u of tryUrls) {
    try {
      await page.goto(u, { waitUntil: "networkidle2" });
      // Give network listeners time to capture
      await sleep(2000);
      recordings = apiPayloads;
      if (recordings.length) break;
    } catch {
      // Try next
    }
  }

  if (recordings.length) {
    console.log(`Captured ${recordings.length} recordings from Plaud network responses.`);
    return recordings;
  }

  // Fallback: basic DOM scrape for cards
  console.log("Falling back to DOM scrape...");
  await sleep(1500);

  const domResults = await page.evaluate(() => {
    const results = [];

    const pickText = (el) => (el && el.textContent ? el.textContent.trim() : "");

    // Try to find likely cards
    const cards = Array.from(document.querySelectorAll("[class*='card' i], [data-testid*='card' i]"));
    for (const card of cards) {
      const titleEl =
        card.querySelector("h1, h2, h3") ||
        card.querySelector("[class*='title' i]") ||
        card.querySelector("[data-testid*='title' i]");
      const title = pickText(titleEl) || "Plaud Recording";

      const idAttr =
        card.getAttribute("data-id") ||
        card.getAttribute("data-recording-id") ||
        card.getAttribute("data-testid") ||
        "";

      // Pull any obvious summary block
      const summaryEl =
        card.querySelector("[class*='summary' i]") ||
        card.querySelector("[data-testid*='summary' i]") ||
        null;
      const summary = pickText(summaryEl);

      results.push({
        id: idAttr || title, // weak fallback
        title,
        createdAt: null,
        summary,
        transcript: "",
        sourceUrl: "",
      });
    }

    // Deduplicate
    const map = new Map();
    for (const r of results) map.set(String(r.id), r);
    return Array.from(map.values()).slice(0, 100);
  });

  if (!domResults.length) {
    throw new Error("Could not find recordings from Plaud. Plaud UI likely changed. We need to adjust selectors.");
  }

  console.log(`DOM scrape found ${domResults.length} potential recordings.`);
  return domResults;
}

function toNotionDate(value) {
  // Try to coerce into ISO date
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function writeRecordingToNotion(notion, databaseId, rec) {
  // This expects a Notion database that has these properties:
  // Name (title), Date (date), Summary (rich_text), Source (rich_text or url)
  // If yours differs, we can adapt it.
  const props = {
    Name: {
      title: [{ type: "text", text: { content: rec.title || "Plaud Recording" } }],
    },
  };

  const iso = toNotionDate(rec.createdAt);
  if (iso) {
    props.Date = { date: { start: iso } };
  }

  if (rec.summary) {
    props.Summary = { rich_text: [{ type: "text", text: { content: rec.summary.slice(0, 1900) } }] };
  }

  // Source can be stored as rich text if you have that property, or url if you set it that way.
  // We default to rich_text because it is most common.
  if (rec.sourceUrl || rec.id) {
    const sourceText = rec.sourceUrl || `Plaud:${rec.id}`;
    props.Source = { rich_text: [{ type: "text", text: { content: sourceText.slice(0, 1900) } }] };
  }

  const children = [];
  if (rec.transcript) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "Transcript" } }] },
    });
    // Notion block text limit is strict, chunk it
    const t = rec.transcript;
    const chunkSize = 1800;
    for (let i = 0; i < t.length; i += chunkSize) {
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: t.slice(i, i + chunkSize) } }] },
      });
      if (children.length > 90) break;
    }
  }

  await notion.pages.create({
    parent: { database_id: databaseId },
    properties: props,
    children: children.length ? children : undefined,
  });
}

async function main() {
  console.log("Starting Plaud -> Notion sync...");

  const plaudEmail = requireEnv("PLAUD_EMAIL");
  const plaudPassword = requireEnv("PLAUD_PASSWORD");
  const notionApiKey = requireEnv("NOTION_API_KEY");
  const notionDatabaseId = normalizeDbId(requireEnv("NOTION_DATABASE_ID"));

  const baseUrl = process.env.PLAUD_BASE_URL ? String(process.env.PLAUD_BASE_URL).trim() : "https://web.plaud.ai";

  const synced = await loadSyncedIds();
  console.log(`Previously synced: ${synced.size} recordings`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    await loginToPlaud(page, baseUrl, plaudEmail, plaudPassword);

    const recordings = await getPlaudRecordings(page);

    const notion = new Client({ auth: notionApiKey });

    let created = 0;
    for (const rec of recordings) {
      if (!rec?.id) continue;
      if (synced.has(String(rec.id))) continue;

      console.log(`Writing to Notion: ${rec.title} (${rec.id})`);
      await writeRecordingToNotion(notion, notionDatabaseId, rec);
      synced.add(String(rec.id));
      created += 1;
    }

    await saveSyncedIds(synced);

    console.log(`Done. Created ${created} new Notion pages.`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Sync failed:", err?.stack || err?.message || err);
  process.exit(1);
});
