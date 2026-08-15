// iNSEQUENCE — Portal video pipeline (runs on GitHub Actions).
// For every NEW video on the Client Portal Files board it:
//   1. extracts the frame at 25% (poster)         -> <aid>.jpg
//   2. transcodes a light 1080p H.264 copy         -> <aid>.mp4
// and uploads both as assets on a GitHub Release tagged by job code
// (job-26-1004), so the portal serves them from GitHub's CDN. The 4K master
// stays on Monday, untouched. state.json tracks what's done so nothing repeats.
//
// Env: MONDAY_TOKEN (repo secret), GH_TOKEN (auto), GITHUB_REPOSITORY (auto).
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";

const MONDAY = process.env.MONDAY_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY; // "owner/repo"
const BOARD = "18426360670";
const JOBCODE_COL = "text_mm66gsk3";
const STATE = "state.json";

// known image/doc extensions — anything NOT here (and with a file) is treated as a video.
// catches mp4/mov/m4v/webm AND mis-parsed extensions like ".26".
const IMGDOC = /^(jpe?g|png|gif|webp|bmp|svg|avif|hei[cf]|pdf|docx?|xlsx?|pptx?|txt|csv|rtf|pages|numbers|key|zip)$/i;

const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).toString();
const shq = (c) => { try { return sh(c); } catch (e) { return ""; } };

// job code -> release tag, e.g. "26 - 1004" -> "job-26-1004". MUST match the portal render's builder.
const tagFor = (jc) => "job-" + String(jc || "misc").replace(/[^0-9a-zA-Z]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();

async function monday(query) {
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: MONDAY },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors) throw new Error("monday: " + JSON.stringify(j.errors));
  return j.data;
}

let state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { done: [] };
const done = new Set((state.done || []).map(String));

const data = await monday(
  `query { boards(ids:${BOARD}){ items_page(limit:500){ items{ id column_values(ids:["${JOBCODE_COL}"]){ text } assets{ id file_extension public_url } } } } }`
);
const items = (data.boards[0].items_page.items) || [];
const todo = [];
for (const it of items) {
  const jc = (it.column_values[0] && it.column_values[0].text) || "";
  for (const a of it.assets || []) {
    const ext = String(a.file_extension || "").replace(/^\./, "").toLowerCase();
    const isVideo = ext && !IMGDOC.test(ext);
    if (isVideo && a.public_url && !done.has(String(a.id))) {
      todo.push({ aid: String(a.id), jc, url: a.public_url });
    }
  }
}
console.log(`new videos: ${todo.length}`);
mkdirSync("work", { recursive: true });

const ensuredTags = new Set();
const processed = [];
for (const v of todo) {
  const tag = tagFor(v.jc);
  const src = `work/${v.aid}.src`;
  const jpg = `work/${v.aid}.jpg`;
  const mp4 = `work/${v.aid}.mp4`;
  try {
    if (!ensuredTags.has(tag)) {
      if (!shq(`gh release view ${tag} --repo ${REPO}`)) {
        sh(`gh release create ${tag} --repo ${REPO} --title ${JSON.stringify(v.jc || tag)} --notes "iNSEQUENCE portal media"`);
      }
      ensuredTags.add(tag);
    }
    // download the source (Actions runners have open internet; Monday URL is valid ~1h)
    execSync(`curl -sSL -o ${src} ${JSON.stringify(v.url)}`, { stdio: ["ignore", "ignore", "pipe"] });

    // 25% poster
    let dur = parseFloat(shq(`ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 ${src}`).trim()) || 0;
    let ss = dur > 0 ? (dur * 0.25).toFixed(2) : 1;
    sh(`ffmpeg -y -ss ${ss} -i ${src} -frames:v 1 -vf "scale='min(1280,iw)':-2" -q:v 3 ${jpg}`);

    // light 1080p (downscale only if taller than 1080; never upscale)
    sh(`ffmpeg -y -i ${src} -vf "scale=-2:'min(1080,ih)'" -c:v libx264 -crf 23 -preset veryfast -c:a aac -b:a 128k -movflags +faststart ${mp4}`);

    sh(`gh release upload ${tag} ${jpg} ${mp4} --repo ${REPO} --clobber`);
    processed.push(v.aid);
    console.log(`ok ${v.aid} -> ${tag}`);
  } catch (e) {
    console.log(`FAIL ${v.aid}: ${String(e.message || e).slice(0, 200)}`);
  } finally {
    execSync(`rm -f ${src} ${jpg} ${mp4}`, { stdio: "ignore" });
  }
}

state.done = [...done, ...processed];
writeFileSync(STATE, JSON.stringify(state));
console.log(`processed ${processed.length}, total done ${state.done.length}`);
