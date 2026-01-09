// geo_service.js
// External service: IP -> GeoLite2 (lat/lon) -> Nominatim reverse -> full address
// Started automatically from main.js as child process.

const http = require("http");
const url = require("url");
const path = require("path");
const fs = require("fs");
const maxmind = require("maxmind");

const PORT = process.env.GEO_PORT ? Number(process.env.GEO_PORT) : 8787;
const HOST = "127.0.0.1";

const DB_PATH = process.env.MMDB_PATH || path.join(__dirname, "GeoLite2-City.mmdb");
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || "youremail@example.com";
const USER_AGENT = process.env.NOMINATIM_UA || "MyBrowser/1.0 (contact: youremail@example.com)";

let reader = null;
const cache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let lastNominatimAt = 0;
async function throttle(ms = 1100) {
  const now = Date.now();
  const wait = Math.max(0, (lastNominatimAt + ms) - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastNominatimAt = Date.now();
}

function okJson(res, obj) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(obj));
}

function errJson(res, code, msg) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify({ ok: false, error: msg }));
}

function pickName(names) {
  return names?.en || names?.fr || names?.ar || "";
}

function safePickCity(rec) { return pickName(rec?.city?.names); }
function safePickCountry(rec) { return pickName(rec?.country?.names); }
function safePickRegion(rec) {
  const subs = rec?.subdivisions;
  if (Array.isArray(subs) && subs.length) return pickName(subs[0]?.names);
  return "";
}

async function reverseNominatim(lat, lon) {
  await throttle(1100);

  const params = new URLSearchParams({
    format: "jsonv2",
    lat: String(lat),
    lon: String(lon),
    addressdetails: "1",
    email: NOMINATIM_EMAIL
  });

  const r = await fetch("https://nominatim.openstreetmap.org/reverse?" + params.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json"
    }
  });

  if (!r.ok) throw new Error("Nominatim failed: " + r.status);
  const j = await r.json();
  const addr = j.address || {};

  return {
    display_name: j.display_name || "",
    address: {
      house_number: addr.house_number || "",
      road: addr.road || addr.pedestrian || addr.residential || addr.neighbourhood || "",
      suburb: addr.suburb || addr.neighbourhood || "",
      city: addr.city || addr.town || addr.village || "",
      state: addr.state || addr.county || "",
      postcode: addr.postcode || "",
      country: addr.country || "",
      country_code: addr.country_code || ""
    }
  };
}

async function ensureReader() {
  if (reader) return;
  if (!fs.existsSync(DB_PATH)) {
    throw new Error("GeoLite2 DB not found at: " + DB_PATH);
  }
  reader = await maxmind.open(DB_PATH);
  console.log("[GEO] Loaded mmdb:", DB_PATH);
}

async function enrichIp(ip) {
  const cached = cache.get(ip);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return { ok: true, cached: true, ...cached.data };
  }

  await ensureReader();

  const rec = reader.get(ip);
  if (!rec) {
    const data = { ip, geo: null, nominatim: null };
    cache.set(ip, { ts: Date.now(), data });
    return { ok: true, cached: false, ...data };
  }

  const lat = rec?.location?.latitude;
  const lon = rec?.location?.longitude;

  const geo = {
    city: safePickCity(rec),
    region: safePickRegion(rec),
    country: safePickCountry(rec),
    postal: rec?.postal?.code || "",
    latitude: typeof lat === "number" ? lat : null,
    longitude: typeof lon === "number" ? lon : null,
    timezone: rec?.location?.time_zone || ""
  };

  let nominatim = null;
  if (typeof geo.latitude === "number" && typeof geo.longitude === "number") {
    try {
      nominatim = await reverseNominatim(geo.latitude, geo.longitude);
    } catch (e) {
      nominatim = { error: String(e?.message || e) };
    }
  }

  const data = { ip, geo, nominatim };
  cache.set(ip, { ts: Date.now(), data });
  return { ok: true, cached: false, ...data };
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      return res.end();
    }

    if (parsed.pathname === "/health") return okJson(res, { ok: true });

    if (parsed.pathname === "/enrich") {
      const ip = String(parsed.query.ip || "").trim();
      if (!ip) return errJson(res, 400, "Missing ip");
      const out = await enrichIp(ip);
      return okJson(res, out);
    }

    return errJson(res, 404, "Not found");
  } catch (e) {
    return errJson(res, 500, String(e?.message || e));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[GEO] service running on http://${HOST}:${PORT}`);
});
