// Recall Dial relay
// Reads bk's saved things from three Notion databases and hands the R1 one
// "window" of saves per day: a random day from the past, plus everything saved
// within a few days of it.
//
// Env:
//   NOTION_TOKEN  secret  Notion internal integration token
//   DIAL_KEY      secret  shared key the R1 page sends as ?k=
//   START_DATE    var     earliest day to draw from (YYYY-MM-DD)
//   TIMEZONE      var     used to decide what "today" is

const NOTION_VERSION = "2025-09-03";
const VERSION = "5-cache-by-version";

export const SOURCES = [
  { id: "0eed1994-1465-4248-8e88-d1935d2f5932", label: "Stuff" },
  { id: "5ee081b8-c7fa-4d86-99f5-d1ad2b66257b", label: "Commonplace" },
  { id: "a60d1955-e1a6-463d-8b80-8d5712f7d6e4", label: "Resources" },
];

const WINDOW_DAYS = 10; // saves within ±10 days of the drawn day
const MIN_AGE_DAYS = 30; // never surface something saved this month
const PER_SOURCE = 25; // max saves per database in the window
const MIN_ITEMS = 3; // fewer than this in the window → use nearest saves instead
const NEAR_EACH = 5; // nearest saves per database per side
const NEAR_KEEP = 12;
const BODY_BATCH = 3; // page-body lookups at a time (Notion allows ~3 requests/sec)
const LINK_BATCH = 6; // saved-link lookups at a time

const IMAGE_PROPS = ["Image", "Cover", "Files & media"];
const LINK_PROPS = ["URL", "Link", "Via", "Instagram"];
const WHY_PROP = "🤔 Why is this interesting?";
const NOTE_PROPS = ["Description", "Notes"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/today") return handleToday(url, env, ctx);
    if (url.pathname === "/api/health") return json({ ok: true, version: VERSION });
    if (url.pathname === "/api/preview") {
      // Debug: what does a saved link's site send back to the relay?
      if (!env.DIAL_KEY || url.searchParams.get("k") !== env.DIAL_KEY) return json({ error: "bad key" }, 401);
      const target = url.searchParams.get("u");
      if (!target) return json({ error: "add &u=<link>" }, 400);
      const trace = [];
      const image = await previewImage(target, trace).catch((e) => (trace.push("threw " + e.message), null));
      return json({ target, image, trace });
    }
    // Everything else falls through to static assets (index.html, install.html)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};

async function handleToday(url, env, ctx) {
  if (!env.DIAL_KEY || url.searchParams.get("k") !== env.DIAL_KEY) {
    return json({ error: "bad key" }, 401);
  }
  if (!env.NOTION_TOKEN) return json({ error: "NOTION_TOKEN not set" }, 500);

  const tz = env.TIMEZONE || "America/New_York";
  const today = url.searchParams.get("date") || localDate(new Date(), tz);

  // Cache per day for 45 min. Notion file links expire after an hour.
  const cache = typeof caches !== "undefined" ? caches.default : null;
  // Keyed by version so a new deploy never serves an older build's results
  const cacheKey = new Request(`https://cache.recall-dial/${VERSION}/${today}`);
  if (cache && !url.searchParams.has("fresh")) {
    const hit = await cache.match(cacheKey);
    if (hit) return withCors(hit);
  }

  try {
    const payload = await buildDay(today, env);
    const res = json(payload, 200, { "Cache-Control": "max-age=2700" });
    if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (err) {
    return json({ error: String(err.message || err) }, 502);
  }
}

export async function buildDay(today, env) {
  const rng = seeded(today);
  const start = Date.parse((env.START_DATE || "2019-01-01") + "T00:00:00Z");
  const end = Date.parse(today + "T00:00:00Z") - MIN_AGE_DAYS * 864e5;
  if (!(end > start)) throw new Error("START_DATE is too recent");

  const anchor = start + Math.floor(rng() * ((end - start) / 864e5)) * 864e5;
  const from = new Date(anchor - WINDOW_DAYS * 864e5).toISOString();
  const to = new Date(anchor + (WINDOW_DAYS + 1) * 864e5).toISOString();
  const token = env.NOTION_TOKEN;

  let items = (await Promise.all(
    SOURCES.map((s) => querySource(s, { from, to }, token))
  )).flat();

  // Sparse stretch: take the nearest saves on either side of the drawn day
  if (items.length < MIN_ITEMS) {
    const at = new Date(anchor).toISOString();
    const near = (await Promise.all(
      SOURCES.flatMap((s) => [
        querySource(s, { from: at }, token, "ascending", NEAR_EACH),
        querySource(s, { to: at }, token, "descending", NEAR_EACH),
      ])
    )).flat();
    const seen = new Set();
    items = near
      .filter((it) => (seen.has(it.id) ? false : seen.add(it.id)))
      .sort((a, b) => Math.abs(Date.parse(a.saved) - anchor) - Math.abs(Date.parse(b.saved) - anchor))
      .slice(0, NEAR_KEEP);
  }

  items.sort((a, b) => a.saved.localeCompare(b.saved));
  if (!items.length) return { today, anchor: null, index: 0, items: [] };

  // Most saves keep their picture in the page body, not a property
  await fillBodyImages(items, token);
  // Still nothing: use the preview image the saved link's site publishes
  await fillLinkImages(items);

  // Start on the save closest to the drawn day
  let index = 0;
  let best = Infinity;
  items.forEach((it, i) => {
    const d = Math.abs(Date.parse(it.saved) - anchor);
    if (d < best) { best = d; index = i; }
  });

  return {
    today,
    anchor: new Date(anchor).toISOString().slice(0, 10),
    index,
    items,
  };
}

async function querySource(source, range, token, direction = "ascending", size = PER_SOURCE) {
  const and = [];
  if (range.from) and.push({ timestamp: "created_time", created_time: { on_or_after: range.from } });
  if (range.to) and.push({ timestamp: "created_time", created_time: { before: range.to } });
  const res = await fetch(
    `https://api.notion.com/v1/data_sources/${source.id}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page_size: size,
        filter: and.length === 1 ? and[0] : { and },
        sorts: [{ timestamp: "created_time", direction }],
      }),
    }
  );
  if (res.status === 404) {
    throw new Error(`${source.label} not shared with the integration`);
  }
  if (!res.ok) throw new Error(`${source.label}: Notion ${res.status}`);
  const data = await res.json();
  return (data.results || [])
    .filter((p) => !p.in_trash && !p.archived)
    .map((p) => toItem(p, source.label))
    .filter((it) => it.title);
}

async function fillBodyImages(items, token) {
  const todo = items.filter((it) => !it.image);
  for (let i = 0; i < todo.length; i += BODY_BATCH) {
    await Promise.all(
      todo.slice(i, i + BODY_BATCH).map(async (it) => {
        try { it.image = await firstBodyImage(it.id, token); } catch (e) { /* leave as text card */ }
      })
    );
  }
}

async function firstBodyImage(pageId, token) {
  const res = await fetch(
    `https://api.notion.com/v1/blocks/${pageId}/children?page_size=30`,
    { headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  for (const b of data.results || []) {
    if (b.type === "image") return fileUrl(b.image);
  }
  return null;
}

async function fillLinkImages(items) {
  const todo = items.filter((it) => !it.image && (it.link || /^https?:\/\//.test(it.title)));
  for (let i = 0; i < todo.length; i += LINK_BATCH) {
    await Promise.all(
      todo.slice(i, i + LINK_BATCH).map(async (it) => {
        try { it.image = await previewImage(it.link || it.title); } catch (e) { /* leave as text card */ }
      })
    );
  }
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export async function previewImage(pageUrl, trace = []) {
  // Shopify shops: the product's JSON is public and rarely blocked
  const shop = await shopifyImage(pageUrl, trace);
  if (shop) return shop;
  const page = await metaImage(pageUrl, trace);
  if (page) return page;
  // Last resort: a link-preview service that renders the page like a browser
  return microlinkImage(pageUrl, trace);
}

async function shopifyImage(pageUrl, trace) {
  let u;
  try { u = new URL(pageUrl); } catch (e) { return null; }
  if (!/\/products\/[^/]+\/?$/.test(u.pathname)) return null;
  const jsonUrl = `${u.origin}${u.pathname.replace(/\/$/, "")}.js`;
  const res = await timedFetch(jsonUrl, { headers: { ...BROWSER_HEADERS, Accept: "application/json" } });
  trace.push(`shopify ${res ? res.status : "timeout"}`);
  if (!res || !res.ok) return null;
  try {
    const p = await res.json();
    const src = p.featured_image || (p.images && p.images[0]);
    return src ? new URL(src.startsWith("//") ? "https:" + src : src, u.origin).href : null;
  } catch (e) { return null; }
}

async function microlinkImage(pageUrl, trace) {
  const res = await timedFetch(`https://api.microlink.io/?url=${encodeURIComponent(pageUrl)}`, {}, 8000);
  trace.push(`microlink ${res ? res.status : "timeout"}`);
  if (!res || !res.ok) return null;
  try {
    const d = await res.json();
    return (d.data && d.data.image && d.data.image.url) || null;
  } catch (e) { return null; }
}

async function timedFetch(url, init = {}, ms = 5000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal, redirect: "follow" }); }
  catch (e) { return null; }
  finally { clearTimeout(timer); }
}

async function metaImage(pageUrl, trace) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(pageUrl, { signal: ctl.signal, redirect: "follow", headers: BROWSER_HEADERS });
    trace.push(`page ${res.status} ${res.headers.get("content-type") || ""}`);
    if (!res.ok || !(res.headers.get("content-type") || "").includes("html")) return null;
    // Only the <head> matters; stop reading after ~300 KB
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let html = "";
    while (html.length < 300000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    const found = findPreview(html, res.url || pageUrl);
    trace.push(`page read ${html.length} chars, ${found ? "found image" : "no preview tag"}`);
    return found;
  } catch (e) {
    trace.push("page " + (e.name === "AbortError" ? "timeout" : e.message));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function findPreview(html, base) {
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  const want = ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"];
  for (const key of want) {
    for (const tag of metas) {
      const name = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (!name || name.toLowerCase() !== key) continue;
      const content = (tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (content) {
        try { return new URL(content.replace(/&amp;/g, "&"), base).href; } catch (e) {}
      }
    }
  }
  return null;
}

export function toItem(page, label) {
  const props = page.properties || {};
  let title = "";
  for (const v of Object.values(props)) {
    if (v && v.type === "title") { title = plain(v.title); break; }
  }
  let image = null;
  for (const name of IMAGE_PROPS) {
    const f = props[name];
    if (f && f.type === "files" && f.files && f.files.length) {
      image = fileUrl(f.files.find(isImageFile) || f.files[0]);
      if (image) break;
    }
  }
  if (!image && page.cover) image = fileUrl(page.cover);

  let link = null;
  for (const name of LINK_PROPS) {
    const p = props[name];
    if (p && p.type === "url" && p.url) { link = p.url; break; }
  }
  const why = props[WHY_PROP] ? plain(props[WHY_PROP].rich_text) : "";
  let note = "";
  for (const name of NOTE_PROPS) {
    if (props[name] && props[name].type === "rich_text") {
      note = plain(props[name].rich_text);
      if (note) break;
    }
  }
  return {
    id: page.id,
    source: label,
    title: title.trim(),
    image,
    link,
    why,
    note,
    saved: page.created_time,
    notionUrl: page.url,
  };
}

function isImageFile(f) {
  const u = fileUrl(f) || "";
  return /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(u) || !/\.(pdf|mp4|mov|zip)(\?|$)/i.test(u);
}

function fileUrl(f) {
  if (!f) return null;
  if (f.type === "file" && f.file) return f.file.url;
  if (f.type === "external" && f.external) return f.external.url;
  return null;
}

function plain(rich) {
  return (rich || []).map((r) => r.plain_text || "").join("");
}

export function localDate(d, tz) {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

export function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function () {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extra,
    },
  });
}

function withCors(res) {
  const r = new Response(res.body, res);
  r.headers.set("Access-Control-Allow-Origin", "*");
  return r;
}
