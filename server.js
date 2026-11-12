// خادم مقطع: يقدّم صفحة التطبيق، ويجلب نص يوتيوب، ويكلّم Claude للترجمة.
// بدون أي مكتبات خارجية. يحتاج Node.js 18 أو أحدث.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const ACCESS_CODE = process.env.ACCESS_CODE || ""; // اختياري: رمز يمنع الغرباء من استهلاك مفتاحك
const PUBLIC = require("fs").existsSync(path.join(__dirname, "public")) ? path.join(__dirname, "public") : __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

/* ---------- نص يوتيوب ---------- */
function parseJson3(data) {
  const out = [];
  for (const ev of (data && data.events) || []) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    out.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 0) / 1000, text });
  }
  // الترجمة التلقائية تكرر أحياناً نفس السطر، نشيل التكرار المتتالي
  return out.filter((s, i) => i === 0 || s.text !== out[i - 1].text);
}

function pickTrack(tracks) {
  const en = tracks.filter((t) => (t.languageCode || "").startsWith("en"));
  return en.find((t) => t.kind !== "asr") || en[0] || null;
}

async function getTranscript(id) {
  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
    },
    body: JSON.stringify({
      context: { client: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30, hl: "en", gl: "US" } },
      videoId: id,
    }),
  });
  if (!res.ok) throw Object.assign(new Error("fetch_failed"), { code: "fetch_failed" });
  const info = await res.json();
  const tracks = (((info.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks) || [];
  const track = pickTrack(tracks);
  if (!track) throw Object.assign(new Error("no_captions"), { code: "no_captions" });
  const url = track.baseUrl.replace(/&fmt=[^&]*/, "") + "&fmt=json3";
  const cr = await fetch(url);
  if (!cr.ok) throw Object.assign(new Error("fetch_failed"), { code: "fetch_failed" });
  const body = await cr.text();
  if (!body) throw Object.assign(new Error("fetch_failed"), { code: "fetch_failed" });
  const segments = parseJson3(JSON.parse(body));
  if (!segments.length) throw Object.assign(new Error("no_captions"), { code: "no_captions" });
  return { title: ((info.videoDetails || {}).title) || "", auto: track.kind === "asr", segments };
}

/* ---------- Claude ---------- */
async function askClaude(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw Object.assign(new Error("claude_failed"), { code: "claude_failed", status: r.status });
  const j = await r.json();
  return (j.content || []).map((b) => b.text || "").join("");
}

/* ---------- HTTP ---------- */
function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 200000) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("too_big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function authorized(req) { return !ACCESS_CODE || req.headers["x-code"] === ACCESS_CODE; }

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/transcript" && req.method === "GET") {
      if (!authorized(req)) return send(res, 401, { error: "auth" });
      const id = u.searchParams.get("v") || "";
      if (!/^[\w-]{11}$/.test(id)) return send(res, 400, { error: "bad_id" });
      try { return send(res, 200, await getTranscript(id)); }
      catch (e) { return send(res, 502, { error: e.code || "fetch_failed" }); }
    }
    if (u.pathname === "/api/ask" && req.method === "POST") {
      if (!authorized(req)) return send(res, 401, { error: "auth" });
      if (!API_KEY) return send(res, 500, { error: "no_key" });
      const body = JSON.parse((await readBody(req)) || "{}");
      if (typeof body.prompt !== "string" || !body.prompt || body.prompt.length > 60000) return send(res, 400, { error: "bad_prompt" });
      try { return send(res, 200, { text: await askClaude(body.prompt) }); }
      catch (e) { return send(res, 502, { error: e.code || "claude_failed" }); }
    }
    if (u.pathname === "/api/status") return send(res, 200, { ok: true, key: !!API_KEY, code: !!ACCESS_CODE });

    // ملفات الصفحة
    let p = decodeURIComponent(u.pathname); if (p === "/") p = "/index.html";
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC) || /(^|[\\/])(server\.js|package\.json)$/.test(file)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  } catch (e) { send(res, 500, { error: "server_error" }); }
});

if (require.main === module) {
  server.listen(PORT, () => console.log("مقطع شغّال على المنفذ " + PORT + (API_KEY ? "" : "  (تنبيه: ما حطيت ANTHROPIC_API_KEY)")));
}
module.exports = { parseJson3, pickTrack, server };
