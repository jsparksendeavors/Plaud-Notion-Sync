import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import { Client } from "@notionhq/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLAUD_DEBUG = String(process.env.PLAUD_DEBUG || "false").toLowerCase() === "true";

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

function recordingDisplayName(rec) {
  const raw = String(rec?.title || "").trim();
  if (raw && !/^plaud\s*recording$/i.test(raw)) return raw;

  const d = toNotionDate(rec?.createdAt);
  if (d) return `Plaud recording ${d.slice(0, 10)}`;

  const shortId = String(rec?.id || "").slice(0, 8);
  return shortId ? `Plaud recording ${shortId}` : "Plaud recording";
}

function buildPlaudRecordingUrl(baseUrl, rec) {
  if (rec?.sourceUrl && /^https?:\/\//i.test(rec.sourceUrl)) return rec.sourceUrl;
  const cleanedBase = String(baseUrl || "https://web.plaud.ai").replace(/\/$/, "");
  if (!rec?.id) return cleanedBase;
  // Best-effort deep link format used by Plaud web routes.
  return `${cleanedBase}/recordings/${encodeURIComponent(String(rec.id))}`;
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

function firstNonEmptyString(values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function flattenText(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((v) => flattenText(v))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof value === "object") {
    // Only read explicit text-bearing keys. Do NOT recursively flatten arbitrary objects,
    // which can pull unrelated UI/template metadata into summaries.
    const likely = [
      value.text,
      value.content,
      value.value,
      value.summary,
      value.brief,
      value.transcript,
      value.description,
      value.markdown,
      value.plain,
    ];
    return firstNonEmptyString(likely);
  }
  return "";
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
      const id = r.id ?? r.recordingId ?? r.recording_id ?? r.uuid ?? r._id;
      if (!id) continue;

      const title = firstNonEmptyString([
        r.title,
        r.name,
        r.recordingName,
        r.recordingTitle,
        r.record_title,
        r.fileName,
        r.filename,
        r.subject,
      ]) || "Plaud Recording";

      const createdAt =
        r.createdAt ??
        r.created_at ??
        r.createTime ??
        r.createdTime ??
        r.time ??
        r.date ??
        null;

      const summary = firstNonEmptyString([
        flattenText(r.summary),
        flattenText(r.brief),
        flattenText(r.aiSummary),
        flattenText(r.ai_summary),
        flattenText(r.abstract),
        flattenText(r.notes),
      ]);

      const transcript = firstNonEmptyString([
        flattenText(r.transcript),
        flattenText(r.text),
        flattenText(r.content),
        flattenText(r.fullText),
        flattenText(r.full_text),
      ]);

      const sourceUrl = firstNonEmptyString([r.url, r.webUrl, r.shareUrl, r.link]);

      const summaryCandidates = [
        flattenText(r.summary),
        flattenText(r.brief),
        flattenText(r.aiSummary),
        flattenText(r.ai_summary),
        flattenText(r.abstract),
        flattenText(r.notes),
      ];
      const transcriptCandidates = [
        flattenText(r.transcript),
        flattenText(r.text),
        flattenText(r.content),
        flattenText(r.fullText),
        flattenText(r.full_text),
      ];

      candidates.push({
        id: String(id),
        title: String(title),
        createdAt,
        summary,
        transcript,
        sourceUrl: sourceUrl ? String(sourceUrl) : "",
        _debug: PLAUD_DEBUG
          ? {
              rawKeys: Object.keys(r).slice(0, 40),
              summaryLens: summaryCandidates.map((x) => (x || "").length),
              transcriptLens: transcriptCandidates.map((x) => (x || "").length),
            }
          : undefined,
      });
    }
  }

  // Deduplicate by id, preferring the richest record when duplicates appear
  const map = new Map();
  for (const c of candidates) {
    const prev = map.get(c.id);
    if (!prev) {
      map.set(c.id, c);
      continue;
    }

    const prevScore = (prev.summary || "").length + (prev.transcript || "").length + (prev.title || "").length;
    const nextScore = (c.summary || "").length + (c.transcript || "").length + (c.title || "").length;
    if (nextScore >= prevScore) map.set(c.id, c);
  }
  return Array.from(map.values());
}

function mergeRecording(baseRec, enrichRec) {
  if (!enrichRec) return baseRec;
  return {
    ...baseRec,
    title: firstNonEmptyString([enrichRec.title, baseRec.title]) || "Plaud Recording",
    createdAt: enrichRec.createdAt ?? baseRec.createdAt,
    summary: firstNonEmptyString([enrichRec.summary, baseRec.summary]),
    transcript: firstNonEmptyString([enrichRec.transcript, baseRec.transcript]),
    sourceUrl: firstNonEmptyString([enrichRec.sourceUrl, baseRec.sourceUrl]),
  };
}

async function enrichRecordingFromDetailPage(page, baseUrl, rec) {
  if (!rec?.id) return rec;

  const detailCandidates = [];
  const onResp = async (resp) => {
    try {
      const url = resp.url();
      if (!/api|record|note|transcript|meeting/i.test(url)) return;
      const json = await safeJson(resp);
      if (!json) return;
      const extracted = extractRecordingsFromApiJson(json);
      for (const e of extracted) {
        if (String(e.id) === String(rec.id)) detailCandidates.push(e);
      }
    } catch {
      // ignore noisy responses
    }
  };

  page.on("response", onResp);
  try {
    await page.goto(buildPlaudRecordingUrl(baseUrl, rec), { waitUntil: "networkidle2" });
    await sleep(1800);
  } catch {
    // ignore navigation failures and return original record
  } finally {
    page.off("response", onResp);
  }

  let best = rec;
  for (const c of detailCandidates) {
    best = mergeRecording(best, c);
  }

  return best;
}

async function getPlaudRecordings(page, baseUrl) {
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
    // Enrich low-signal records by visiting detail pages for better summary/transcript fields.
    const needsEnrichment = recordings.filter((r) => !hasUsefulContent(r));
    if (needsEnrichment.length) {
      console.log(`Enriching ${needsEnrichment.length} low-signal recordings from detail pages...`);
      const byId = new Map(recordings.map((r) => [String(r.id), r]));
      for (const rec of needsEnrichment) {
        const enriched = await enrichRecordingFromDetailPage(page, baseUrl, rec);
        byId.set(String(rec.id), mergeRecording(rec, enriched));
      }
      recordings = Array.from(byId.values());
    }

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
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function isTemplateNoise(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  const markers = [
    "account_circle_rounded",
    "task_alt_rounded",
    "detailed summary",
    "full transcript (for external use)",
    "faithful and complete audio transcription",
    "extract meeting tasks and decisions",
  ];
  return markers.some((m) => t.includes(m));
}

function hasUsefulContent(rec) {
  const summary = (rec.summary || "").trim();
  const summaryLen = summary.length;
  const transcriptLen = (rec.transcript || "").trim().length;
  const goodSummary = summaryLen >= 40 && !isTemplateNoise(summary);
  return goodSummary || transcriptLen >= 120;
}

function shouldUpsert(rec) {
  // Always upsert if we have any identity/title/date/link value at all.
  // This guarantees Name/Date/Plaud-link improvements apply even before summaries/transcripts are ready.
  return Boolean(rec?.id || rec?.title || rec?.createdAt || rec?.sourceUrl);
}

function pickSummaryPropertyName(dbProperties = {}) {
  const candidates = ["Summary", "Meeting Minutes", "Meeting Notes", "Notes"];
  for (const name of candidates) {
    if (dbProperties?.[name]?.type === "rich_text") return name;
  }
  // fallback: first rich_text property that isn't Source
  for (const [name, meta] of Object.entries(dbProperties || {})) {
    if (name !== "Source" && meta?.type === "rich_text") return name;
  }
  return null;
}

function buildNotionProperties(rec, baseUrl, dbProperties = {}) {
  const props = {
    Name: {
      title: [{ type: "text", text: { content: recordingDisplayName(rec) } }],
    },
  };

  // Always set Date so records are sortable even when Plaud omits createdAt.
  const iso = toNotionDate(rec.createdAt) || new Date().toISOString();
  props.Date = { date: { start: iso } };

  const summaryPropName = pickSummaryPropertyName(dbProperties);
  if (summaryPropName) {
    if (rec.summary) {
      props[summaryPropName] = {
        rich_text: [{ type: "text", text: { content: rec.summary.slice(0, 1900) } }],
      };
    } else if (rec._clearSummary === true) {
      // Explicitly clear known-bad template noise from prior runs.
      props[summaryPropName] = { rich_text: [] };
    }
  }

  // Stable source marker + direct Plaud link for dedupe and navigation.
  const plaudUrl = buildPlaudRecordingUrl(baseUrl, rec);
  if (rec.id) {
    const sourceType = dbProperties?.Source?.type;
    const sourceText = `Plaud:${rec.id} | ${plaudUrl}`;

    if (sourceType === "url") {
      props.Source = { url: plaudUrl };
    } else {
      // Default/fallback to rich_text for backwards compatibility.
      props.Source = { rich_text: [{ type: "text", text: { content: sourceText.slice(0, 1900) } }] };
    }
  }

  return props;
}

function filterPropertiesForDatabase(properties, databasePropertyNames) {
  const filtered = {};
  for (const [k, v] of Object.entries(properties || {})) {
    if (databasePropertyNames.has(k)) filtered[k] = v;
  }
  return filtered;
}

function buildTranscriptChildren(rec, baseUrl) {
  const children = [];

  const plaudUrl = buildPlaudRecordingUrl(baseUrl, rec);
  children.push({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        { type: "text", text: { content: "Open in Plaud: " } },
        { type: "text", text: { content: plaudUrl, link: { url: plaudUrl } } },
      ],
    },
  });

  if (rec.summary) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "Summary" } }] },
    });

    const s = rec.summary;
    const chunkSize = 1800;
    for (let i = 0; i < s.length; i += chunkSize) {
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: s.slice(i, i + chunkSize) } }] },
      });
      if (children.length > 50) break;
    }
  }

  if (!rec.transcript) return children;

  children.push({
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content: "Transcript" } }] },
  });

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

  return children;
}

async function findExistingPageByPlaudId(notion, databaseId, plaudId, dbProperties = {}, baseUrl = "https://web.plaud.ai") {
  if (!plaudId) return null;

  try {
    const sourceType = dbProperties?.Source?.type;
    let filter = null;

    if (sourceType === "url") {
      filter = {
        property: "Source",
        url: {
          equals: buildPlaudRecordingUrl(baseUrl, { id: plaudId }),
        },
      };
    } else {
      filter = {
        property: "Source",
        rich_text: {
          contains: `Plaud:${plaudId}`,
        },
      };
    }

    const resp = await notion.databases.query({
      database_id: databaseId,
      filter,
      page_size: 1,
    });

    return resp.results?.[0] || null;
  } catch {
    // If database schema differs (e.g. no Source field), fail open.
    return null;
  }
}

async function writeRecordingToNotion(notion, databaseId, rec, baseUrl, dbPropertyNames, dbProperties) {
  const properties = filterPropertiesForDatabase(buildNotionProperties(rec, baseUrl, dbProperties), dbPropertyNames);
  const children = buildTranscriptChildren(rec, baseUrl);

  const existing = await findExistingPageByPlaudId(notion, databaseId, rec.id, dbProperties, baseUrl);
  if (existing?.id) {
    await notion.pages.update({
      page_id: existing.id,
      properties,
    });

    // If transcript exists, append once only when we don't already have lots of blocks.
    if (children.length) {
      const oldBlocks = await notion.blocks.children.list({ block_id: existing.id, page_size: 10 });
      if ((oldBlocks.results || []).length < 3) {
        await notion.blocks.children.append({ block_id: existing.id, children });
      }
    }

    return "updated";
  }

  await notion.pages.create({
    parent: { database_id: databaseId },
    properties,
    children: children.length ? children : undefined,
  });
  return "created";
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

    const recordings = await getPlaudRecordings(page, baseUrl);

    if (PLAUD_DEBUG) {
      console.log(`DEBUG: extracted ${recordings.length} recordings`);
      for (const rec of recordings.slice(0, 8)) {
        const d = rec._debug || {};
        console.log(
          `DEBUG_REC id=${rec.id} title=${JSON.stringify(rec.title)} summaryLen=${(rec.summary || "").length} transcriptLen=${(rec.transcript || "").length}`
        );
        if (d.rawKeys) console.log(`DEBUG_KEYS ${rec.id}: ${d.rawKeys.join(",")}`);
        if (d.summaryLens) console.log(`DEBUG_SUMMARY_LENS ${rec.id}: ${d.summaryLens.join(",")}`);
        if (d.transcriptLens) console.log(`DEBUG_TRANSCRIPT_LENS ${rec.id}: ${d.transcriptLens.join(",")}`);
      }
    }

    const notion = new Client({ auth: notionApiKey });
    const db = await notion.databases.retrieve({ database_id: notionDatabaseId });
    const dbProperties = db.properties || {};
    const dbPropertyNames = new Set(Object.keys(dbProperties));

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let lowSignal = 0;

    // Safety: if one bad summary string appears repeatedly, don't propagate it.
    const seenSummaries = new Map();

    for (const rec of recordings) {
      if (!shouldUpsert(rec)) {
        skipped += 1;
        continue;
      }

      const normalizedSummary = (rec.summary || "").trim();
      if (normalizedSummary) {
        if (isTemplateNoise(normalizedSummary)) {
          rec.summary = "";
          rec._clearSummary = true;
        } else {
          const count = (seenSummaries.get(normalizedSummary) || 0) + 1;
          seenSummaries.set(normalizedSummary, count);
          // If same summary appears for many recordings in one run, treat as bad extraction.
          if (count >= 3) {
            rec.summary = "";
            rec._clearSummary = true;
          }
        }
      }

      const useful = hasUsefulContent(rec);
      if (!useful) lowSignal += 1;

      console.log(`Upserting Notion: ${rec.title || "(untitled)"} (${rec.id || "no-id"})`);
      const mode = await writeRecordingToNotion(notion, notionDatabaseId, rec, baseUrl, dbPropertyNames, dbProperties);
      if (rec?.id) synced.add(String(rec.id));
      if (mode === "created") created += 1;
      if (mode === "updated") updated += 1;
    }

    await saveSyncedIds(synced);

    console.log(`Done. Created ${created}, updated ${updated}, low-signal ${lowSignal}, skipped ${skipped}.`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Sync failed:", err?.stack || err?.message || err);
  process.exit(1);
});
