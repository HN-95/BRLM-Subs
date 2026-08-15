const express = require('express');
const cors = require('cors');
const iconv = require('iconv-lite');
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const parser = require("srt-parser-2").default;
const srtParser = new parser();
const AdmZip = require("adm-zip");
const { createExtractorFromData } = require('node-unrar-js');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 🔥 INITIALIZE SQLITE DATABASE
// Use Railway's persistent volume if available, otherwise use the local directory
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const dbPath = path.join(dataDir, 'brlm_users.sqlite');

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    osKey TEXT,
    subdlKey TEXT,
    subsourceKey TEXT,
    targetLang TEXT DEFAULT 'ar',
    panelLang TEXT DEFAULT 'en',
    stripTags INTEGER DEFAULT 0,
    includeStats INTEGER DEFAULT 1,
    removeSdh INTEGER DEFAULT 1,
    maxSubs INTEGER DEFAULT 5,
    engineStrength INTEGER DEFAULT 3,
    useOs INTEGER DEFAULT 1,
    useSubdl INTEGER DEFAULT 1,
    useSubsource INTEGER DEFAULT 1,
    allowRouteA INTEGER DEFAULT 1,
    allowRouteB INTEGER DEFAULT 1,
    allowRouteC INTEGER DEFAULT 1,
    strict4k INTEGER DEFAULT 0,
    autoFetchNext INTEGER DEFAULT 1,
    matchCut INTEGER DEFAULT 0,
    matchCutDirector INTEGER DEFAULT 1,
    matchCutTheatrical INTEGER DEFAULT 1,
    matchCutExtended INTEGER DEFAULT 1
  )
`);

// 🔥 AUTO-MIGRATOR: Smartly updates the table without deleting existing users
try {
    db.prepare('SELECT targetLang FROM users LIMIT 1').get();
} catch (e) {
    console.log("⚠️ Updating database schema to include Multi-Language & Custom Keys...");
    try { 
        db.exec('ALTER TABLE users ADD COLUMN subdlKey TEXT');
        db.exec('ALTER TABLE users ADD COLUMN subsourceKey TEXT');
        db.exec('ALTER TABLE users ADD COLUMN targetLang TEXT DEFAULT "ar"');
        db.exec('ALTER TABLE users ADD COLUMN panelLang TEXT DEFAULT "en"');
    } catch(err) {}
}

// 🔥 AUTO-MIGRATOR #2: Adds the "Match subtitles with the movie's cut" toggle
try {
    db.prepare('SELECT matchCut FROM users LIMIT 1').get();
} catch (e) {
    console.log("⚠️ Updating database schema to include Cut Matching toggle...");
    try {
        db.exec('ALTER TABLE users ADD COLUMN matchCut INTEGER DEFAULT 0');
    } catch(err) {}
}

// 🔥 AUTO-MIGRATOR #3: Adds per-cut sub-toggles (Director's/Theatrical/
// Extended) for the Cut Matching feature. Default to ON (1) so anyone who
// already enabled matchCut keeps today's exact strict-for-all-3 behavior
// until they explicitly dial a specific cut back in the new panel.
try {
    db.prepare('SELECT matchCutDirector FROM users LIMIT 1').get();
} catch (e) {
    console.log("⚠️ Updating database schema to include per-cut Match Cut toggles...");
    try {
        db.exec('ALTER TABLE users ADD COLUMN matchCutDirector INTEGER DEFAULT 1');
        db.exec('ALTER TABLE users ADD COLUMN matchCutTheatrical INTEGER DEFAULT 1');
        db.exec('ALTER TABLE users ADD COLUMN matchCutExtended INTEGER DEFAULT 1');
    } catch(err) {}
}
// ═════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════
// ⚙️ THE MASTER CONFIGURATION HUB
// Change these variables to tune the entire engine.
// ═════════════════════════════════════════════════════════════════════════════
const CONFIG = {
    // ─── BRANDING & IDENTITY ──────────────────────────────────────────────────
    ADDON_NAME: "BRLM Subs", // Changes Stremio Manifest, Watermarks, and Web UI
    ADDON_VERSION: "1.4.4",

    // ─── API KEYS ─────────────────────────────────────────────────────────────
   
    // ─── SEARCH & FETCH LIMITS ────────────────────────────────────────────────
    ARABIC_CANDIDATE_LIMIT: 30,        // Max Arabic subtitles to fetch per provider
    MOVIE_BASELINE_LIMIT: 100,           // Max English baselines to check per provider (Movies)
    TV_BASELINE_FETCH_POOL: 80,        // How deep to dig into OS to find distinct TV cuts
    TV_DISTINCT_CUTS_LIMIT: 3,         // How many distinct TV baselines to lock and test against

    // ─── MATH ENGINE TUNING ───────────────────────────────────────────────────
    MATH_CHUNKS: 5,                    // Test Points: Number of segments to split the movie into for drift calculation
    MIN_ACCEPTABLE_DELAY_MS: 50,       // Any delay smaller than this will NOT trigger an auto-shift
    DISTINCT_CUT_THRESHOLD_SEC: 2.2,   // Minimum seconds of difference needed to treat a TV baseline as a "New Cut"
    MIN_PASSING_ALIGNMENT_PCT: 40,     // If a subtitle scores below this %, it is immediately trashed
    Min_Arabic_Letters: 100,  // This variable is used to eliminate fake arabic subtitles. 
    // ─── DRIFT PENALTIES (If drift > X ms, subtract Y %) ──────────────────────
    PENALTY_SEVERE_MS: 2500,   PENALTY_SEVERE_PCT: 40,
    PENALTY_MODERATE_MS: 1200, PENALTY_MODERATE_PCT: 20,
    PENALTY_LIGHT_MS: 750,     PENALTY_LIGHT_PCT: 10,

   // ─── ENGINE STRICTNESS LEVELS (Minimum Alignment % required to pass) ──────
    STRICTNESS_LEVELS: {
        0: 0,   // Level 0: Raw Bypass (No math, passes everything)
        1: 20,  // Level 1: Very Forgiving
        2: 30,  // Level 2: Forgiving
        3: 40,  // Level 3: Balanced (Default)
        4: 60,  // Level 4: Strict
        5: 80   // Level 5: Highly Strict (Also enforces Director's Cut matching)
    },

    // ─── ONSCREEN RATINGS & LABELS ────────────────────────────────────────────
    RATINGS: {
        ACCURATE:   { minPct: 90, maxDriftMs: 500,  label: "Accurate 💎" },
        STABLE:     { minPct: 75, maxDriftMs: 1500, label: "Stable ✅" },
        POOR:       { minPct: 50,                   label: "A bit off ⚠️" },
        UNRELIABLE: {                               label: "Unreliable 🔴" },
        UNVERIFIED: {                               label: "Unverified ⚠️" },
        DIAGNOSTIC: {                               label: "Master Ruler 👑" }
    },

    // ─── NETWORK TIMEOUTS ─────────────────────────────────────────────────────
    FETCH_TIMEOUT_MS: 6000,            // Standard API timeout
    SRT_FETCH_TIMEOUT_MS: 8000,        // Subtitle file download timeout
	
	
	// ─── SEARCH & FETCH LIMITS ────────────────────────────────────────────────
    STRICT_TYPE_MATCHING: true,        // Force baselines to match stream type (WEB/BluRay/HDTV) 
	CLONE_SAMPLE_SIZE: 400,            // Number of pure Arabic characters to sample for shift-invariant clone detection

    // ─── 🔥 DEFAULT USER SETTINGS ─────────────────────────────────────────────
    // Single source of truth for the "Reset to Default Settings" button.
    // Change any value here and every future reset uses the new value —
    // no other file needs touching. API keys are deliberately NOT listed:
    // a reset must never wipe the keys a user pasted in.
    DEFAULT_SETTINGS: {
        targetLang: 'en',
        stripTags: 0,
        includeStats: 0,
        removeSdh: 1,
        maxSubs: 5,
        engineStrength: 3,
        useOs: 1,
        useSubdl: 1,
        useSubsource: 1,
        allowRouteA: 1,
        allowRouteB: 1,
        allowRouteC: 1,
        strict4k: 0,
        autoFetchNext: 1,
        matchCut: 1,
        matchCutDirector: 1,
        matchCutTheatrical: 0,
        matchCutExtended: 1
    }
};
// ═════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 7000;
const HOST = (process.env.HOST || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const subtitleCache = new Map();

// 🔥 NEW: Caches the final calculated subtitle list for 2 hours to prevent API burn
const responseCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 2;

// 🔥 PER-USER PROVIDER STATUS TRACKER (in-memory)
// Reflects the outcome of the most recent REAL request made to each
// provider for a given user — never a synthetic ping — so checking it never
// costs extra API quota and always matches what's actually happening.
const providerStatus = new Map();
function setProviderStatus(username, provider, status) {
    if (!username) return;
    providerStatus.set(`${username.toLowerCase()}:${provider}`, { status, updatedAt: Date.now() });
}
function recordProviderHttpStatus(username, provider, httpStatus) {
    let status = 'ok';
    if (httpStatus === 429) status = 'limited';
    else if (httpStatus === 401 || httpStatus === 403) status = 'invalid';
    else if (httpStatus && httpStatus >= 400) status = 'error';
    setProviderStatus(username, provider, status);
}

// 🔥 RELIABILITY #1 — CIRCUIT BREAKER: if a provider JUST told us (via a
// real request) that it's rate-limited or the key is invalid, skip it for
// a short cooldown instead of waiting out a full 6-8s timeout on a request
// that's essentially guaranteed to fail again. This is a fast-fail, not a
// permanent block — cooldowns are short so a provider that recovers (rate
// limit window passes) or gets a fresh key isn't stuck "off" for long.
const PROVIDER_COOLDOWN_MS = { limited: 60 * 1000, invalid: 5 * 60 * 1000, error: 30 * 1000 };
function isProviderCoolingDown(username, provider) {
    if (!username) return false;
    const entry = providerStatus.get(`${username.toLowerCase()}:${provider}`);
    if (!entry) return false;
    const cooldown = PROVIDER_COOLDOWN_MS[entry.status];
    if (!cooldown) return false;
    return (Date.now() - entry.updatedAt) < cooldown;
}

// 🔥 RELIABILITY #2 — BOUNDED-CONCURRENCY PREFETCH: downloads several
// candidates' subtitle text in small parallel batches instead of one at a
// time, cutting real wall-clock wait time. Deliberately capped (not "fetch
// everything at once") so a single request never opens dozens of
// simultaneous outbound connections — that would spike memory holding many
// response bodies at once AND risk tripping a provider's own rate limit,
// which is exactly the kind of self-inflicted slowdown this is meant to
// avoid. This only changes WHEN the download happens (earlier, in
// parallel) — every candidate is still evaluated in its original order
// afterward, so none of the existing selection/scoring/math logic changes.
const PREFETCH_BATCH_SIZE = 4;
async function prefetchInBatches(candidates, batchSize = PREFETCH_BATCH_SIZE) {
    for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        await Promise.all(batch.map(async c => {
            try { c._prefetched = await c.fetchFn(); } catch { c._prefetched = null; }
        }));
    }
}

// 🔥 RELIABILITY #3 — subtitleCache previously had no eviction at all:
// every generated .srt lived in memory for the life of the process. Map
// preserves insertion order, so we can safely trim the OLDEST entries once
// the cache grows past a sane size — zero changes needed at any of the
// existing .set() call sites throughout the file. Checked infrequently
// (every 15 min) since it's a maintenance sweep, not something that needs
// to run on the request hot path.
const MAX_SUBTITLE_CACHE_ENTRIES = 1500;
setInterval(() => {
    if (subtitleCache.size <= MAX_SUBTITLE_CACHE_ENTRIES) return;
    const excess = subtitleCache.size - MAX_SUBTITLE_CACHE_ENTRIES;
    const it = subtitleCache.keys();
    for (let i = 0; i < excess; i++) {
        const oldestKey = it.next().value;
        if (oldestKey === undefined) break;
        subtitleCache.delete(oldestKey);
    }
    console.log(`🧹 [Cache Sweep] Trimmed ${excess} oldest subtitle cache entries (cap: ${MAX_SUBTITLE_CACHE_ENTRIES}).`);
}, 15 * 60 * 1000);

// 🔥 RELIABILITY #5 — IN-FLIGHT REQUEST COALESCING: if two requests for the
// same user+title arrive while the first is still running (e.g. the
// background autoFetchNext pre-cacher overlapping with a real foreground
// request for the same episode, or Stremio firing a duplicate call), the
// second one just awaits the first's result instead of running the entire
// fetch-and-sync pipeline — and burning provider API quota — a second time
// for identical work.
const inFlightRequests = new Map();
// ─────────────────────────────────────────────────────────────────────────────
// MANIFEST
// ─────────────────────────────────────────────────────────────────────────────
const manifest = {
    id: "org.brlm." + CONFIG.ADDON_NAME.replace(/[^a-z0-9]/gi, '').toLowerCase(),
    version: CONFIG.ADDON_VERSION,
    name: CONFIG.ADDON_NAME,
    description: "Perfectly Synced Arabic Subtitles",
    types: ["movie", "series"],
    catalogs: [],
    resources: ["subtitles"],
// 🔥 ADDED CONFIGURATION SUPPORT:
   behaviorHints: { configurable: true, configurationRequired: true },
   config: [
        {
            key: "username",
            type: "text",
            title: "BRLM Username",
            description: "Enter your username registered on the BRLM Dashboard."
        }
    ]
};

const builder = new addonBuilder(manifest);
// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL TIMEOUT FETCHER
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWithTimeout(resource, options = {}) {
    const { timeout = CONFIG.FETCH_TIMEOUT_MS } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE TOKENISER
// ─────────────────────────────────────────────────────────────────────────────
const RELEASE_TOKENS = [
    'remux','bluray','blu-ray','bdrip','brrip','bdremux','web-dl','webdl','webrip','web',
    'hdtv','dvdrip','dvdscr','dvd','hdrip','hd','ts','cam',
    '2160p','2160','4k','uhd','1080p','1080','720p','720','480p','480',
    'hevc','x265','x264','h265','h264','av1',
    'hdr','dv','dolby','atmos',
    'dts','aac','dd5','ac3',
    // 🔥 Edition Tracking Tokens
    'extended','director','directors','theatrical','unrated','cut','dc','final',
    // 🔥 NEW: Network & Streaming Service Tokens
    'nf','netflix','amzn','amazon','atvp','apple','dsnp','disney',
    'max','hbo','hmax','hulu','pmtp','paramount','peacock','pckg'
];

function tokeniseRelease(name) {
    if (!name) return new Set();
   const lower = name.toLowerCase().replace(/[._\+\s]+/g, ' ').replace(/\b(\w+)-(\w+)\b/g, '$1$2 $1-$2');
    const found = new Set();
  for (const token of RELEASE_TOKENS) {
        const regex = new RegExp(`\\b${token.replace('-', '-?')}\\b`, 'i');
        if (regex.test(lower)) found.add(token.replace('-', ''));
    }
    return found;
}

function releaseScore(setA, setB) {
    if (setA.size === 0 || setB.size === 0) return 0;
    let matches = 0;
    for (const t of setA) if (setB.has(t)) matches++;
    return (2 * matches) / (setA.size + setB.size);
}

function getReleaseTypeGroup(tokens) {
    let group = null;
    if (tokens.has('webdl') || tokens.has('webrip') || tokens.has('web')) group = tokens.has('webrip') ? 'WEBRIP' : 'WEBDL';
    else if (tokens.has('bluray') || tokens.has('remux') || tokens.has('bdrip') || tokens.has('brrip') || tokens.has('bdremux')) group = 'BLURAY';
    else if (tokens.has('hdtv') || tokens.has('hdrip')) group = 'HDTV';
    else if (tokens.has('dvdrip') || tokens.has('dvdscr') || tokens.has('dvd')) group = 'DVD';
    else if (tokens.has('cam') || tokens.has('ts')) group = 'CAM';

    // 🔥 Catch all 4K variants
    if (group && (tokens.has('2160p') || tokens.has('2160') || tokens.has('4k') || tokens.has('uhd'))) {
        return group + '_4K';
    }
    return group;
}

function filterBaselinesByType(candidates, streamTypeGroup) {
    // Skip if config is off, or if we couldn't detect the stream type
    if (!CONFIG.STRICT_TYPE_MATCHING || !streamTypeGroup) return candidates;
    
    return candidates.filter(c => {
        const cTokens = tokeniseRelease(c.releaseName);
        const cGroup = getReleaseTypeGroup(cTokens);
        return cGroup === streamTypeGroup;
    });
}

// 🔥 "Match subtitles with the movie's cut" — user-configurable, OFF by
// default (userConfig.matchCut), with a per-cut panel (matchCutDirector /
// matchCutTheatrical / matchCutExtended) controlling exactly which of the
// 3 recognized editions get STRICT enforcement. Recognizes whatever naming
// an uploader used: tokeniseRelease() already treats "Director's Cut",
// "Directors Cut", "Director Cut", and "DC" as separate raw tokens;
// getCanonicalCut() groups all of them into one value.
//
// Rules:
//   1. If the played file's cut is one the user opted into strict mode for
//      (a checked chip), a candidate is only accepted if it declares the
//      EXACT SAME cut.
//   2. If the played file's cut is a KNOWN cut but NOT opted into strict
//      mode (chip left unchecked) — a candidate is still REJECTED if it's
//      explicitly tagged with a DIFFERENT known cut (Director's/Theatrical/
//      Extended are never interchangeable, strict mode or not). An UNTAGGED
//      candidate is allowed through, since most releases of the default
//      cut never bother tagging it — but it's flagged "unverified" so the
//      caller can note that on the output, since we're assuming rather
//      than confirming compatibility.
//   3. If the played file itself declares no known cut at all, there's
//      nothing to check against — everything passes, untouched.
function getCanonicalCut(tokens) {
    if (tokens.has('director') || tokens.has('directors') || tokens.has('dc')) return 'director';
    if (tokens.has('extended')) return 'extended';
    if (tokens.has('theatrical')) return 'theatrical';
    return null;
}
function checkCutCompatibility(userTokens, candidateReleaseName, enabledCuts) {
    const userCut = getCanonicalCut(userTokens);
    if (!userCut) return { compatible: true, unverified: false };

    const candidateTokens = tokeniseRelease(candidateReleaseName);
    const candidateCut = getCanonicalCut(candidateTokens);

    if (enabledCuts.has(userCut)) {
        return { compatible: candidateCut === userCut, unverified: false };
    }
    // Not strict for this cut — but a candidate explicitly tagged with a
    // DIFFERENT known cut is still a confirmed mismatch, always rejected.
    if (candidateCut !== null && candidateCut !== userCut) {
        return { compatible: false, unverified: false };
    }
    // Either untagged, or (rarely) explicitly the same cut by luck.
    return { compatible: true, unverified: candidateCut === null };
}
// Thin boolean wrapper — used by ruler-locking call sites that just need a
// plain pass/fail filter and don't track "unverified" for their own output.
function isCutCompatible(userTokens, candidateReleaseName, enabledCuts) {
    return checkCutCompatibility(userTokens, candidateReleaseName, enabledCuts).compatible;
}
// Small note appended to a subtitle's title when it only passed cut-
// matching because it was untagged and assumed compatible, not confirmed.
function cutUnverifiedNote(candidate) {
    return candidate && candidate._cutUnverified ? ' | ⚠️ Unverified Cut Match' : '';
}

// 🔥 NEW: The API Bouncer (Kills wrong seasons/episodes before they download)
function enforceEpisodeMatch(candidates, season, episode) {
    if (!season || !episode) return candidates;
    const s = parseInt(season, 10);
    const e = parseInt(episode, 10);

    return candidates.filter(c => {
        const name = c.releaseName.toLowerCase();
        
        // 1. If it has a strict SxxEyy tag, kill it if it doesn't match perfectly
        const anySEMatch = name.match(/s(\d{1,2})[ex](\d{1,2})\b/i);
        if (anySEMatch) {
            if (parseInt(anySEMatch[1], 10) !== s || parseInt(anySEMatch[2], 10) !== e) return false;
        }
        
        // 2. If it is a Season Pack (S01, Season 1), kill it if it's the wrong season
        const seasonPackMatch = name.match(/(?:^|\b)(?:s|season\s?)(\d{1,2})\b/i);
        if (seasonPackMatch && !anySEMatch) {
             if (parseInt(seasonPackMatch[1], 10) !== s) return false; 
        }
        
        return true; // Keep ambiguous files, zip extractors will handle them
    });
}

// 🔥 Repairs the classic "UTF-8 decoded as Latin-1, then re-saved as UTF-8"
// mistake — produces garbage that's itself perfectly VALID UTF-8 (so the
// broken-character check below never sees it), showing up as "â€™" for an
// apostrophe, "â€"" for an em-dash, or "â‚¬"-style garbage for a Euro sign
// — exactly the "weird symbol near €" pattern. Detects ALL UTF-8 lead-byte
// ranges misread as Latin-1 (2-byte: C2-DF, 3-byte: E0-EF, 4-byte: F0-F4)
// — most punctuation like €, smart quotes, and em-dashes live in the
// 3-byte E0-EF range specifically. Fix: reinterpret the string's
// codepoints as raw Latin-1 bytes, then decode THOSE as UTF-8 — the
// standard round-trip repair for this exact, very common mistake.
function repairMojibake(text) {
    const mojibakePattern = /[\u00c2-\u00df][\u0080-\u00bf]|[\u00e0-\u00ef][\u0080-\u00bf]{2}|[\u00f0-\u00f4][\u0080-\u00bf]{3}/;
    if (!mojibakePattern.test(text)) return text;
    try {
        const repaired = Buffer.from(text, 'latin1').toString('utf8');
        if (!repaired.includes('\uFFFD')) return repaired;
    } catch (e) {}
    return text;
}

function decodeArabicFile(buffer) {
    let buf = buffer;

    // 🔥 Strip a UTF-8 BOM so it never leaks into the first cue's text.
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        buf = buf.subarray(3);
    }
    // 🔥 UTF-16 files (some tools export these) — detect by BOM and decode properly
    // instead of letting them fall through as unreadable UTF-8.
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
        return repairMojibake(iconv.decode(buf.subarray(2), 'utf16le'));
    }
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
        return repairMojibake(iconv.decode(buf.subarray(2), 'utf16be'));
    }

    const utf8 = buf.toString('utf8');

    // 🔥 CRITICAL FIX: if the bytes are VALID UTF-8, always trust them.
    // The old logic instead asked "did UTF-8 produce any Arabic?" — which is
    // false for every English subtitle — and then fell through to win1256.
    // win1256 misdecodes UTF-8 punctuation into Arabic-range characters
    // (♪ = E2 99 AA becomes "â™ھ", and that ھ sits inside 0600-06FF), so the
    // "did win1256 find Arabic?" check passed and the ENTIRE English file was
    // returned as win1256 garbage — turning ♪ into ھ and every em-dash/curly
    // quote into "â€"/"â€™" (the € symbol). A single music note was enough to
    // poison a whole file.
    if (!utf8.includes('\uFFFD')) {
        return repairMojibake(utf8);
    }

    // Not valid UTF-8 → it's a legacy single-byte encoding. Prefer win1256
    // only when it yields a MEANINGFUL amount of Arabic (not one stray glyph),
    // otherwise treat it as Latin (win1252).
    const win1256 = iconv.decode(buf, 'win1256');
    const arabicCount = (win1256.match(/[\u0600-\u06FF]/g) || []).length;
    if (arabicCount >= 20) return win1256;

    return repairMojibake(iconv.decode(buf, 'win1252'));
}

function formatTime(ms) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1_000);
    const x = Math.floor(ms % 1_000);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(x).padStart(3,'0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 1: OPENSUBTITLES
// ─────────────────────────────────────────────────────────────────────────────
async function searchOS(url, apiKey, username) {
    try {
        const res = await fetchWithTimeout(url, { headers: { 'Api-Key': apiKey, 'User-Agent': `${CONFIG.ADDON_NAME} v${CONFIG.ADDON_VERSION}` } });
        recordProviderHttpStatus(username, 'openSubtitles', res.status);
        if (!res.ok) return { data: [] };
        return await res.json();
    } catch { return { data: [] }; }
}
async function getOsSrt(fileId, apiKey) {
    try {
        const req = await fetchWithTimeout('https://api.opensubtitles.com/api/v1/download', {
            method: 'POST',
            timeout: CONFIG.SRT_FETCH_TIMEOUT_MS,
            headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json', 'User-Agent': `${CONFIG.ADDON_NAME} v${CONFIG.ADDON_VERSION}`, 'Accept': 'application/json' },
            body: JSON.stringify({ file_id: parseInt(fileId) })
        });
      
        if (!req.ok) return null;
        const data = await req.json();
        if (!data.link) return null;
        
        const textReq = await fetchWithTimeout(data.link, { timeout: CONFIG.SRT_FETCH_TIMEOUT_MS });
        const buffer = await textReq.arrayBuffer();
        return { text: decodeArabicFile(Buffer.from(buffer)) };
    } catch { return null; }
}
async function fetchOsCandidates({ lang, imdbId, season, episode, videoHash, releaseTokens, limit = 10, apiKey, username }) {
    try {
        // 🔥 Circuit breaker: skip a provider that JUST rate-limited/rejected us
        if (isProviderCoolingDown(username, 'openSubtitles')) {
            console.log(`  🛑 [Circuit Breaker] Skipping OpenSubtitles (recent limited/invalid status).`);
            return [];
        }
        const isTV = !!(season && episode);

        // 🔥 Per docs: "Remove leading zeroes in ID parameters (IMDB ID, TMDB ID...)"
        const cleanImdbId = parseInt(imdbId, 10);
        if (!cleanImdbId || Number.isNaN(cleanImdbId)) return [];

        // 🔥 ONE combined request instead of two. Per docs: "If a moviehash is
        // sent with a request, a moviehash_match boolean field will be added
        // to the response. The matching subtitles will always come first" —
        // OS does the hash-priority sorting for us when it's part of the
        // same request.
        //
        // 🔥 Per docs: "Use imdb_id for movie or episode. Use parent_imdb_id
        // for TV Shows." Our imdbId is always the SHOW's parent ID (from
        // Stremio's "tt123:season:episode" format) — so TV requests must use
        // parent_imdb_id + season_number + episode_number, never imdb_id.
        const params = new URLSearchParams();
        params.set('languages', lang.toLowerCase());
        if (isTV) {
            params.set('parent_imdb_id', String(cleanImdbId));
            params.set('season_number', String(parseInt(season, 10)));
            params.set('episode_number', String(parseInt(episode, 10)));
            params.set('type', 'episode');
        } else {
            params.set('imdb_id', String(cleanImdbId));
            params.set('type', 'movie');
        }
        if (videoHash) params.set('moviehash', videoHash);

        // 🔥 Per docs' Best Practices: server-side ordering is "expensive,
        // time consuming" and blocks caching — we already do our own
        // client-side release-token scoring below, so order_by/
        // order_direction is dropped entirely.

        // 🔥 Per docs: "Avoid http redirection by sending request parameters
        // sorted and without default values."
        const sorted = new URLSearchParams([...params.entries()].sort((a, b) => a[0].localeCompare(b[0])));
        const url = `https://api.opensubtitles.com/api/v1/subtitles?${sorted.toString()}`;

       const data = await searchOS(url, apiKey, username);

        // 🔥 TV-only diagnostic: reads the season number OS itself attached
        // to each returned result (not what we asked for) — a mismatch here
        // means OS ignored/misread our parent_imdb_id + season_number filter.
        if (isTV) {
            const seasonsSeen = [...new Set(
                (data.data || [])
                    .map(s => s.attributes?.feature_details?.season_number)
                    .filter(v => v !== undefined && v !== null)
            )];
            console.log(`  🔍 [OpenSubtitles] Seasons in response: [${seasonsSeen.join(', ') || 'none — 0 results'}] (requested S${season}E${episode})`);
        }

        if (!data.data?.length) return [];

        const mapped = data.data.map(s => ({
            fileId: s.attributes.files[0].file_id,
            releaseName: s.attributes.release || 'OS Match',
            source: 'OpenSubtitles',
            hashMatch: !!(s.attributes?.moviehash_match ?? s.moviehash_match),
            score: releaseTokens.size ? releaseScore(releaseTokens, tokeniseRelease(s.attributes.release || '')) : 0
        }));

        // Hash matches are the strongest signal available (exact file match) — float them above our own token scoring.
        mapped.sort((a, b) => {
            if (a.hashMatch !== b.hashMatch) return a.hashMatch ? -1 : 1;
            return b.score - a.score;
        });

        const seen = new Set();
        return mapped.filter(r => {
            if (seen.has(r.fileId)) return false;
            seen.add(r.fileId);
            return true;
        }).slice(0, limit);
    } catch { return []; }
}
// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 2: SUBDL
// ─────────────────────────────────────────────────────────────────────────────
async function fetchSubdlCandidates({ imdbId, lang, season, episode, releaseTokens, limit = 10, apiKey, username }) {
    try {
        // 🔥 No shared fallback anymore — if this user hasn't set their own
        // key, skip SubDL entirely rather than sending an empty/invalid one.
        if (!apiKey) { setProviderStatus(username, 'subdl', 'noKey'); return []; }
        // 🔥 Circuit breaker: skip a provider that JUST rate-limited/rejected us
        if (isProviderCoolingDown(username, 'subdl')) {
            console.log(`  🛑 [Circuit Breaker] Skipping SubDL (recent limited/invalid status).`);
            return [];
        }
        const key = apiKey;
        const isTV = !!(season && episode);

        // 🔥 CRITICAL FIX: the old request never told SubDL which season/
        // episode we wanted, so it searched the WHOLE show and depended
        // entirely on local regex filtering afterward. season_number and
        // episode_number are real, documented server-side filters — sending
        // them stops wrong-season/wrong-episode results at the source.
        const params = new URLSearchParams();
        params.set('api_key', key);
        params.set('imdb_id', `tt${imdbId}`);
        params.set('languages', lang.toUpperCase());
        params.set('subs_per_page', '30'); // 🔥 API max — old request had no override and silently got the default of 10
        params.set('client', 'stremio');
        if (isTV) {
            params.set('type', 'tv');
            params.set('season_number', String(parseInt(season, 10)));
            params.set('episode_number', String(parseInt(episode, 10)));
            // 🔥 unpack=1: for full-season packs, SubDL returns exact season/
            // episode metadata + a direct download URL for EACH file inside —
            // lets us target the correct episode precisely instead of
            // guessing from filenames inside a zip.
            params.set('unpack', '1');
        } else {
            params.set('type', 'movie');
        }

const url = `https://api.subdl.com/api/v1/subtitles?${params.toString()}`;
        const res = await fetchWithTimeout(url);
        recordProviderHttpStatus(username, 'subdl', res.status);
        if (!res.ok) return [];
        const data = await res.json();

        // 🔥 SubDL signals key/quota failures via a 200 OK response with
        // {status:false, error:"..."} in the BODY, not a 401/403 HTTP code —
        // recordProviderHttpStatus (which only sees res.status) can't catch
        // this on its own, so we check the body's own status flag explicitly.
        if (data.status === false) {
            setProviderStatus(username, 'subdl', 'invalid');
            return [];
        }

        // 🔥 TV-only diagnostic: reads the season number SubDL attached to
        // each returned subtitle (not what we asked for) — confirms the
        // provider actually understood our season_number/episode_number filter.
        if (isTV) {
            const seasonsSeen = [...new Set(
                (data.subtitles || [])
                    .map(sub => sub.season)
                    .filter(v => v !== undefined && v !== null)
            )];
            console.log(`  🔍 [SubDL] Seasons in response: [${seasonsSeen.join(', ') || 'none — 0 results'}] (requested S${season}E${episode})`);
        }

        if (!data.status || !data.subtitles?.length) return [];

        const results = [];
        for (const sub of data.subtitles) {
            const isFullSeason = !!(sub.full_season ?? sub.Full_season);

            // 🔥 Precise episode targeting inside a season pack
            if (isTV && isFullSeason && Array.isArray(sub.unpack_files) && sub.unpack_files.length) {
                const seasNum = parseInt(season, 10);
                const epNum = parseInt(episode, 10);
                const matchedFile = sub.unpack_files.find(f => parseInt(f.season, 10) === seasNum && parseInt(f.episode, 10) === epNum);
                if (matchedFile) {
                    const fileUrl = matchedFile.url.startsWith('/') ? matchedFile.url : `/${matchedFile.url}`;
                    results.push({
                        id: matchedFile.file_n_id || matchedFile.url,
                        releaseName: matchedFile.release_name || sub.release_name || 'SubDL Match',
                        downloadUrl: `https://dl.subdl.com${fileUrl}`,
                        source: 'SubDL',
                        score: releaseTokens.size ? releaseScore(releaseTokens, tokeniseRelease(matchedFile.release_name || sub.release_name || '')) : 0
                    });
                    continue; // Exact file found — skip the whole-pack fallback below
                }
                // Requested episode wasn't listed in this pack's metadata — fall through to the old zip-scan path as a safety net.
            }

            const subUrl = sub.url.startsWith('/') ? sub.url : `/${sub.url}`;
            results.push({
                id: sub.url,
                releaseName: sub.release_name || 'SubDL Match',
                downloadUrl: `https://dl.subdl.com${subUrl}`,
                source: 'SubDL',
                score: releaseTokens.size ? releaseScore(releaseTokens, tokeniseRelease(sub.release_name || '')) : 0
            });
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit);
    } catch { return []; }
}
// 🔥 NEW HELPER: Bulletproof Archive Scanner (ZIP & RAR)
function findEpisodeInArchive(entries, season, episode) {
    if (!season || !episode) return entries[0];
    const ep = parseInt(episode, 10);
    const s = parseInt(season, 10);
    
    // 1. Strict Match: S01E02, s1e2, 1x02
    const strictRegex = new RegExp(`s0?${s}[ex]0?${ep}\\b|0?${s}[x]0?${ep}\\b`, 'i');
    let match = entries.find(e => strictRegex.test(e.entryName));
    if (match) return match;

    // 2. Loose Match: E02, Ep02, Episode 2
    const looseRegex = new RegExp(`\\b[e]0?${ep}\\b|\\bep0?${ep}\\b|\\bepisode\\s?0?${ep}\\b`, 'i');
    match = entries.find(e => looseRegex.test(e.entryName));
    if (match) return match;

    // 3. Fallback Match: just the number at the end (02.srt)
    const numRegex = new RegExp(`\\b0?${ep}\\.srt$`, 'i');
    match = entries.find(e => numRegex.test(e.entryName));
    if (match) return match;

    // 🔥 FIX: Only fallback to guessing if there is exactly 1 subtitle in the zip/rar
    if (entries.length === 1) return entries[0];
    
    return null; // It's a multi-file archive and we couldn't find the episode. Abort!
}


// 🔥 THE UNIVERSAL EXTRACTOR (Handles Plain Text, ZIPs, and RARs seamlessly)
async function getArchiveSrt(url, season = null, episode = null, extraHeaders = {}) {
    try {
        const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', ...extraHeaders };
        const res = await fetchWithTimeout(url, { headers, timeout: CONFIG.SRT_FETCH_TIMEOUT_MS });
        if (!res.ok) return null;
        
        const buffer = await res.arrayBuffer();
        const uint8 = new Uint8Array(buffer);
        
        // 1. Plain Text Check (Some APIs return the raw .srt immediately)
        const preview = Buffer.from(buffer).toString('utf8', 0, 100);
        if (preview.includes('1\n') || preview.includes('1\r') || preview.includes('-->')) {
            return { text: decodeArabicFile(Buffer.from(buffer)) };
        }
        if (preview.includes('<html') || preview.includes('<!DOCTYPE')) return null;

        let entries = [];

        // 2. MAGIC BYTES: ZIP (Starts with PK -> 50 4B)
        if (uint8[0] === 0x50 && uint8[1] === 0x4B) {
            const zip = new AdmZip(Buffer.from(buffer));
            entries = zip.getEntries()
                .filter(e => e.entryName.toLowerCase().endsWith('.srt'))
                .map(e => ({ entryName: e.entryName, getData: () => e.getData() }));
        } 
        // 3. MAGIC BYTES: RAR (Starts with Rar! -> 52 61 72 21)
        else if (uint8[0] === 0x52 && uint8[1] === 0x61 && uint8[2] === 0x72 && uint8[3] === 0x21) {
            const extractor = await createExtractorFromData({ data: uint8 });
            const extracted = extractor.extract();
            for (const file of extracted.files) {
                if (!file.fileHeader.flags.directory && file.fileHeader.name.toLowerCase().endsWith('.srt')) {
                    entries.push({
                        entryName: file.fileHeader.name,
                        getData: () => Buffer.from(file.extraction) // Convert Wasm output back to standard Buffer
                    });
                }
            }
        } else {
            return null; // Unknown file format
        }

        if (entries.length === 0) return null;
        const srtEntry = findEpisodeInArchive(entries, season, episode);
        if (!srtEntry) return null;
        return { text: decodeArabicFile(srtEntry.getData()) };
        
    } catch(e) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 3: SUBSOURCE
// ─────────────────────────────────────────────────────────────────────────────
async function fetchSubsourceCandidates({ imdbId, langCode, season, episode, releaseTokens, limit = 10, apiKey, username }) {
    try {
        // 🔥 No shared fallback anymore — if this user hasn't set their own
        // key, skip SubSource entirely rather than sending an empty/invalid one.
        if (!apiKey) { setProviderStatus(username, 'subsource', 'noKey'); return []; }
        // 🔥 Circuit breaker: skip a provider that JUST rate-limited/rejected us
        if (isProviderCoolingDown(username, 'subsource')) {
            console.log(`  🛑 [Circuit Breaker] Skipping SubSource (recent limited/invalid status).`);
            return [];
        }
        const key = apiKey;
        const isTV = !!(season && episode);
        // 🔥 CRITICAL FIX: SubSource models EACH SEASON of a TV series as its
        // own distinct movieId — /movies/search documents a "season" filter
        // (example: "?searchType=text&q=...&season=1") and its response
        // objects carry a "season" field. /subtitles itself has NO season or
        // episode filter at all (its only filters are movieId, language,
        // productionType, releaseType, releaseInfo, uploader,
        // hearingImpaired, foreignParts, framerate, page, limit, sort) — so
        // the old &season=&episode= appended to /subtitles was silently
        // ignored. Without "season" on the SEARCH step, we could be handed
        // an arbitrary/default season's movieId before any local filtering
        // even ran — the real reason later-season requests kept surfacing
        // Season-1 packs.
        const searchParams = new URLSearchParams();
        searchParams.set('searchType', 'imdb');
        searchParams.set('imdb', `tt${imdbId}`);
        searchParams.set('type', isTV ? 'series' : 'movie');
        if (isTV) searchParams.set('season', String(parseInt(season, 10)));

const searchUrl = `https://api.subsource.net/api/v1/movies/search?${searchParams.toString()}`;
        const sRes = await fetchWithTimeout(searchUrl, { headers: { 'X-API-Key': key } });
        recordProviderHttpStatus(username, 'subsource', sRes.status);
        if (!sRes.ok) return [];

       const sData = await sRes.json();
        // 🔥 Defensive: in case SubSource ever signals a failure via 200 OK
        // + success:false (matches the response envelope in its own docs),
        // rather than always risking res.status alone (like SubDL does).
        if (sData.success === false) {
            setProviderStatus(username, 'subsource', 'invalid');
            return [];
        }
        const candidates = sData.data || [];
        // 🔥 TV-only diagnostic: reads the season number SubSource itself
        // attached to each returned movie/season entry — confirms
        // /movies/search actually understood our "season" filter and
        // resolved the correct per-season movieId, rather than defaulting
        // to an arbitrary one.
        if (isTV) {
            const seasonsSeen = [...new Set(candidates.map(m => m.season).filter(v => v !== undefined && v !== null))];
            console.log(`  🔍 [SubSource] Seasons in response: [${seasonsSeen.join(', ') || 'none — 0 results'}] (requested S${season}E${episode})`);
        }

        if (!candidates.length) return [];

        // Prefer whichever result's own "season" field actually matches —
        // defensive in case the API ever returns more than one entry.
        let movie = candidates[0];
        if (isTV) {
            const seasNum = parseInt(season, 10);
            const exact = candidates.find(m => parseInt(m.season, 10) === seasNum);
            if (exact) movie = exact;
        }

        const langNames = { ar:'arabic', en:'english', fr:'french', es:'spanish', pt:'portuguese', de:'german', it:'italian', ru:'russian', tr:'turkish', hi:'hindi' };
        const targetLang = langNames[langCode.toLowerCase()] || 'english';

        // 🔥 /subtitles has no season/episode filter — only movieId +
        // language matter here (productionType/releaseType are explicitly
        // flagged by the docs as unreliable: "may return limited results
        // since most imported subtitles from Subscene don't include this
        // metadata"). Episode-level narrowing happens locally afterward
        // (enforceEpisodeMatch + archive extraction), same as every other
        // provider. limit=100 is the documented max — the old request never
        // set it and silently got the API's default of 20.
        const subParams = new URLSearchParams();
        subParams.set('movieId', String(movie.movieId));
        subParams.set('language', targetLang);
        subParams.set('limit', '100');
        subParams.set('sort', 'popular');
const url = `https://api.subsource.net/api/v1/subtitles?${subParams.toString()}`;
        const res = await fetchWithTimeout(url, { headers: { 'X-API-Key': key } });
        recordProviderHttpStatus(username, 'subsource', res.status);
        if (!res.ok) return [];

        const data = await res.json();
        if (data.success === false) {
            setProviderStatus(username, 'subsource', 'invalid');
            return [];
        }
        let subs = data.data || [];

        subs = subs.filter(s => s.language?.toLowerCase() === targetLang);

        // 🔥 releaseInfo is an ARRAY of separate tags (e.g. ["BluRay",
        // "1080p"]) — the old code only read index [0], discarding every
        // other tag (resolution, codec, edition, etc.) that our type-
        // matching and scoring depend on.
        const scored = subs.map(sub => {
            const releaseStr = (sub.releaseInfo && sub.releaseInfo.length) ? sub.releaseInfo.join(' ') : '';
            return {
                id: sub.subtitleId,
                releaseName: releaseStr || 'SubSource Match',
                downloadUrl: `https://api.subsource.net/api/v1/subtitles/${sub.subtitleId}/download`,
                source: 'SubSource',
                score: releaseTokens.size ? releaseScore(releaseTokens, tokeniseRelease(releaseStr)) : 0
            };
        });

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit);
    } catch { return []; }
}


// ─────────────────────────────────────────────────────────────────────────────
// MATH ENGINE (SDH DE-NOISER, SCALING, & DISTINCT CUT CHECKER)
// ─────────────────────────────────────────────────────────────────────────────
// 🔥 SDH LINE CLEANER — shared by content candidates (stripSdhAndClean)
// AND English baselines (processEnglishRuler below), so both get IDENTICAL
// treatment. Strips: [bracketed sound descriptions], (parenthetical
// asides), a leading "SPEAKER:" / "Man 1:" / "Police Officer:" tag however
// an uploader wrote it, and any residual line that's ENTIRELY uppercase
// after cleaning (stylized MUSIC/SOUND cues or bare speaker-name lines
// with no colon). Deliberately does NOT touch <html>/{ass} tags — that's
// stripTags's separate, independent job, so the two settings never fight
// each other. Returns '' if the whole line should be dropped.
// 🔥 Speaker-label matcher. Fires at the START of a line OR mid-line right
// after sentence-ending punctuation — so "Hey how are you? Jack: I am fine."
// loses only the "Jack:" part. A label is 1-4 words that each begin with a
// capital/digit (JACK, Man 1, Police Officer, Dr. Smith, NARRATOR), which is
// deliberately stricter than the old "any ≤25 chars before a colon" rule:
// that older rule also ate real dialogue like "Remember this: never give up",
// while this one leaves it intact.
const SDH_SPEAKER_RE = /(?:^|(?<=[.!?…"'’)\]]\s))\s*[-–—]?\s*[A-Z][A-Za-z0-9'’.\-]*(?:\s+[A-Z0-9#][A-Za-z0-9'’.\-]*){0,3}\s?:(?=\s|$)\s*/g;

function stripSdhFromLine(text) {
    if (!text) return '';
    let clean = text;
    clean = clean.replace(/\[.*?\]/g, '');
    clean = clean.replace(/\(.*?\)/g, '');
    clean = clean.replace(SDH_SPEAKER_RE, '');
    // Collapse the double-spaces left behind by mid-line removals
    clean = clean.replace(/\s{2,}/g, ' ').trim();

    // Judge all-caps against a tag-free copy so an incidental lowercase
    // letter inside a formatting tag (e.g. the "i" in <i>) never masks
    // genuinely all-caps SDH noise — but tags themselves are preserved in
    // what we actually return.
    const forCapsCheck = clean.replace(/<[^>]+>/g, '');

    // 🔥 Nothing but punctuation/symbols survived (e.g. "(GRUNTS)." leaving a
    // lone "."), so the whole line was SDH noise — drop it instead of
    // emitting an orphaned punctuation cue.
    if (!/[\p{L}\p{N}]/u.test(forCapsCheck)) return '';

    const hasLetters = /[a-zA-Z]/.test(forCapsCheck);
    if (hasLetters && forCapsCheck === forCapsCheck.toUpperCase()) return '';

    return clean;
}

function stripSdhAndClean(parsedArray) {
    let cleanArray = [];
    for (const line of parsedArray) {
        const rawLines = line.text.split('\n');
        const cleanLines = [];
        for (const raw of rawLines) {
            const cleanL = stripSdhFromLine(raw);
            if (cleanL.length > 0) cleanLines.push(cleanL);
        }
        if (cleanLines.length > 0) {
            cleanArray.push({ ...line, text: cleanLines.join('\n') });
        }
    }
    return cleanArray;
}

function buildEngIndex(engParsed) { return engParsed.map(l => l.startSeconds * 1000).sort((a, b) => a - b); }

function nearestValue(sortedArr, target) {
    let lo = 0, hi = sortedArr.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedArr[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    if (lo > 0 && Math.abs(sortedArr[lo - 1] - target) < Math.abs(sortedArr[lo] - target)) return sortedArr[lo - 1];
    return sortedArr[lo];
}

function median(arr) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function isDistinctCut(textA, textB) {
    try {
        const pA = stripSdhAndClean(srtParser.fromSrt(textA));
        const pB = stripSdhAndClean(srtParser.fromSrt(textB));
        if (pA.length < 20 || pB.length < 20) return false;

        let diffs = [];
        const idxB = pB.map(l => l.startSeconds);
        for (let i = 0; i < 30 && i < pA.length; i++) {
            const target = pA[i].startSeconds;
            let minDiff = Infinity;
            for (let j = 0; j < idxB.length; j++) {
                const diff = idxB[j] - target;
                if (Math.abs(diff) < Math.abs(minDiff)) minDiff = diff;
            }
            diffs.push(minDiff);
        }
        
        const medianDiff = median(diffs);
        // Linked to CONFIG
        return Math.abs(medianDiff) >= CONFIG.DISTINCT_CUT_THRESHOLD_SEC;
    } catch { return false; }
}

function getTextSignature(srtText, isArabic = true) {
    if (!srtText) return '';
    const cleanLines = srtText.split('\n')
        .map(l => l.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim())
        .filter(l => l && !l.match(/^\d+$/) && !l.includes('-->'));
        
    let validLines = cleanLines;
    if (isArabic) {
        validLines = cleanLines.map(l => {
            const match = l.match(/[\u0600-\u06FF]/g);
            return match ? match.join('') : '';
        }).filter(l => l.length > 15);
    } else {
        validLines = cleanLines.filter(l => l.length > 15);
    }
    return validLines.sort((a, b) => b.length - a.length).slice(0, 15).sort().join('');
}

// 🔥 NEW: Wraps getTextSignature so Route B's raw candidate text is compared
// on equal footing with Route A's already SDH-stripped winner. Without this,
// the exact same subtitle looks "different" once with SDH lines and once
// without — and Route B re-pushes it as if it were a new find.
function getComparableSignature(rawText, isArabic, removeSdh) {
    if (!removeSdh) return getTextSignature(rawText, isArabic);
    try {
        const cleanedParsed = stripSdhAndClean(srtParser.fromSrt(rawText));
        return getTextSignature(srtParser.toSrt(cleanedParsed), isArabic);
    } catch {
        return getTextSignature(rawText, isArabic);
    }
}
function computePrecisionShift(englishText, arabicText, label = '', sourceName = 'Unknown', mediaType = 'Unknown', releaseName = 'Unknown', isTV = false, userConfig = {}) {
    if (!englishText || !arabicText) return { passed: false, alignmentPct: 0 };

    // 🔥 LEVEL 0: RAW BYPASS (No math, no syncing, just raw pass-through)
    if (userConfig.engineStrength === 0) {
        let parsed = [];
        try { parsed = srtParser.fromSrt(arabicText); } catch(e){ return { passed: false, alignmentPct: 0 }; }
        if (userConfig.removeSdh) parsed = stripSdhAndClean(parsed);
        parsed.unshift({ id: "0", startTime: "00:00:01,000", endTime: "00:00:06,000", text: `{\\an8}<font color="#8A5A99"><b>[ ${CONFIG.ADDON_NAME} ] By HN95</b></font>\nType: ${mediaType} (Level 0 Bypass)` });
        return { passed: true, fixedText: srtParser.toSrt(parsed), offsetMs: 0, alignmentPct: 100, driftMs: 0 };
    }

    const isArabic = userConfig.targetLang === 'ara' || userConfig.targetLang === 'ar';
    
    // 🔥 THE ULTIMATE CONTENT FIREWALL: The Ratio Check (Only runs for Arabic)
    if (isArabic) {
        const arabicCharCount = (arabicText.match(/[\u0600-\u06FF]/g) || []).length;
        const latinCharCount = (arabicText.match(/[a-zA-Z]/g) || []).length;
        if (arabicCharCount < CONFIG.Min_Arabic_Letters || latinCharCount > arabicCharCount) {
            console.log(`    ❌ [Blocked] Fake/Corrupted File Detected (Ar: ${arabicCharCount} | Latin: ${latinCharCount}). Trashing.`);
            return { passed: false, alignmentPct: 0 };
        }
    }

let originalArParsed, engParsedClean, arParsedClean;
    try {
        const rawEng = srtParser.fromSrt(englishText);
        originalArParsed = srtParser.fromSrt(arabicText); 
        engParsedClean = stripSdhAndClean(rawEng);
        arParsedClean  = stripSdhAndClean(originalArParsed);
    } catch (e) {
        console.log(`    ❌ [Blocked] ${label} | Malformed/unparseable SRT: ${e.message}`);
        return { passed: false, alignmentPct: 0 };
    }

    if (engParsedClean.length < 50 || arParsedClean.length < 50) {
        console.log(`    ❌ [Blocked] ${label} | Too few cues after cleaning (Eng: ${engParsedClean.length}, Ar: ${arParsedClean.length}) — likely a partial/forced/sample track.`);
        return { passed: false, alignmentPct: 0 };
    }

const engIndex   = buildEngIndex(engParsedClean);
   const durationMs = engParsedClean[engParsedClean.length - 1].startSeconds * 1000;
    
    // 🔥 DYNAMIC CHUNKING: 1 chunk for every 10 minutes of runtime (Minimum of 3 chunks for short TV shows)
    const durationMinutes = durationMs / 60000;
    const dynamicChunks = Math.max(3, Math.floor(durationMinutes / 10)); 
    const chunkSizeMs = durationMs / dynamicChunks;

   // 🔥 THE SYNC MEASURE HELPER
    const measureSync = (arLines) => {
        // Use dynamicChunks instead of CONFIG
        const chunks = Array.from({ length: dynamicChunks }, () => []); 
        arLines.forEach(line => {
            const arMs  = line.startSeconds * 1000;
            const engMs = nearestValue(engIndex, arMs);
            let ci = Math.floor(arMs / chunkSizeMs);
            // Cap it using dynamicChunks
            if (ci >= dynamicChunks) ci = dynamicChunks - 1; 
            chunks[ci].push(arMs - engMs);
        });
        const chunkOffsets = chunks.map(deltas => deltas.length > 15 ? median(deltas) : null).filter(val => val !== null);
        if (chunkOffsets.length < 3) return { passed: false, alignmentPct: 0 };
        
        const driftMs = Math.abs(Math.max(...chunkOffsets) - Math.min(...chunkOffsets));
        const allDeltas = chunks.flat();
        const globalMedian = median(allDeltas);
        const consensus = allDeltas.filter(d => Math.abs(d - globalMedian) < 400).length;
        
        return { passed: true, alignmentPct: (consensus / arLines.length) * 100, driftMs, globalMedian };
    };

    let bestMetrics = measureSync(arParsedClean);
    let bestParsed = originalArParsed;

    // 🔥 FPS AUTO-SCALER: Rescue files with bad framerates
    // If it's a decent translation but tearing heavily, test common FPS conversions
    if (bestMetrics.passed && bestMetrics.alignmentPct >= 50 && bestMetrics.driftMs > 250) {
        const fpsRatios = [25/23.976, 23.976/25, 24/23.976, 23.976/24];
        for (const ratio of fpsRatios) {
            const testArClean = arParsedClean.map(l => ({ ...l, startSeconds: l.startSeconds * ratio }));
            const testMetrics = measureSync(testArClean);
            
            // If scaling fixes the tear and bumps the alignment by at least 5%
            if (testMetrics.passed && testMetrics.driftMs < bestMetrics.driftMs && testMetrics.alignmentPct > bestMetrics.alignmentPct + 5) {
                bestMetrics = testMetrics;
                
                // Apply the winning ratio to the final output payload
                bestParsed = originalArParsed.map(l => {
                    const newStart = l.startSeconds * ratio;
                    const newEnd = l.endSeconds * ratio;
                    return {
                        ...l,
                        startSeconds: newStart,
                        endSeconds: newEnd,
                        startTime: formatTime(newStart * 1000),
                        endTime: formatTime(newEnd * 1000)
                    };
                });
            }
        }
    }

  let { passed, alignmentPct, driftMs, globalMedian } = bestMetrics;
    if (!passed) {
        console.log(`    ❌ [Blocked] ${label} | Not enough overlapping timing data to measure sync.`);
        return { passed: false, alignmentPct: 0 };
    }

    const scaleLog = bestParsed !== originalArParsed ? ' [FPS Scaled ⚙️]' : '';
    console.log(`    [Math] ${label} | Align: ${alignmentPct.toFixed(1)}% | Drift: ${driftMs.toFixed(0)}ms${scaleLog}`);

// Penalties linked to CONFIG
    if (driftMs > CONFIG.PENALTY_SEVERE_MS) alignmentPct -= CONFIG.PENALTY_SEVERE_PCT;
    else if (driftMs > CONFIG.PENALTY_MODERATE_MS) alignmentPct -= CONFIG.PENALTY_MODERATE_PCT;
    else if (driftMs > CONFIG.PENALTY_LIGHT_MS) alignmentPct -= CONFIG.PENALTY_LIGHT_PCT;
    
    // 🔥 Dynamic Engine Strength mapped directly from CONFIG
    let dynamicMinPct = CONFIG.STRICTNESS_LEVELS[userConfig.engineStrength] ?? CONFIG.STRICTNESS_LEVELS[3];

    if (alignmentPct < dynamicMinPct) return { passed: false, alignmentPct };

    let finalParsed = bestParsed;
    
    // 🔥 Remove SDH from Arabic text if requested
    if (userConfig.removeSdh) {
        finalParsed = stripSdhAndClean(finalParsed);
    }

    // Delay shift linked to CONFIG
    if (Math.abs(globalMedian) > CONFIG.MIN_ACCEPTABLE_DELAY_MS) {
        finalParsed = originalArParsed.map(line => ({
            ...line,
            startTime: formatTime(Math.max(0, line.startSeconds * 1000 - globalMedian)),
            endTime:   formatTime(Math.max(0, line.endSeconds   * 1000 - globalMedian))
        }));
    }

    // Ratings linked to CONFIG
    let rating = CONFIG.RATINGS.UNRELIABLE.label;
    if (alignmentPct >= CONFIG.RATINGS.ACCURATE.minPct && driftMs <= CONFIG.RATINGS.ACCURATE.maxDriftMs) rating = CONFIG.RATINGS.ACCURATE.label;
    else if (alignmentPct >= CONFIG.RATINGS.STABLE.minPct && driftMs <= CONFIG.RATINGS.STABLE.maxDriftMs) rating = CONFIG.RATINGS.STABLE.label;
    else if (alignmentPct >= CONFIG.RATINGS.POOR.minPct) rating = CONFIG.RATINGS.POOR.label;

   finalParsed.unshift({
        id: "0",
        startTime: "00:00:01,000",
        endTime: "00:00:06,000",
        text: `{\\an8}<font color="#8A5A99"><b>[ ${CONFIG.ADDON_NAME} ] By HN95</b></font>\nType: ${mediaType} (Route A)`
    });

    return { passed: true, fixedText: srtParser.toSrt(finalParsed), offsetMs: globalMedian, alignmentPct, driftMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// ENGLISH DIAGNOSTIC HELPER
// ─────────────────────────────────────────────────────────────────────────────
function processEnglishRuler(baselineObj, rulerName, detectedType, isTV = false, releaseTokens = new Set(), userConfig = {}) {
    if (!baselineObj || !baselineObj.text || !baselineObj.candidate) return null;
    try {
        let parsed = srtParser.fromSrt(baselineObj.text);
        let cleanParsed = [];

        // 🔥 Conditionally Remove SDH — now uses the SAME shared cleaner as
        // stripSdhAndClean (used for winners), so baselines and winners get
        // identical SDH treatment, not two independently-maintained cleaners.
        if (userConfig.removeSdh) {
            for (let i = 0; i < parsed.length; i++) {
                let rawLines = parsed[i].text.split('\n');
                let cleanLines = [];
                for (let line of rawLines) {
                    const cleanL = stripSdhFromLine(line);
                    if (cleanL.length > 0) cleanLines.push(cleanL);
                }
                if (cleanLines.length > 0) cleanParsed.push({ ...parsed[i], text: cleanLines.join('\n') });
            }
        } else {
            cleanParsed = parsed; // Keep original if stripping is off
        }

        // 🔥 Dynamic Cut Detection (Movies Only)

        // 🔥 Dynamic Cut Detection (Movies Only)
        let cutText = "";
        if (!isTV && releaseTokens) {
            const cuts = [];
            if (releaseTokens.has('director') || releaseTokens.has('directors') || releaseTokens.has('dc')) cuts.push("Director's");
            if (releaseTokens.has('extended')) cuts.push("Extended");
            if (releaseTokens.has('theatrical')) cuts.push("Theatrical");
            if (releaseTokens.has('unrated')) cuts.push("Unrated");
            if (releaseTokens.has('final')) cuts.push("Final");
            
            if (cuts.length > 0) {
                cutText = `\nCurrent Cut: ${cuts.join(', ')}`;
            }
        }

        cleanParsed.unshift({
            id: "0",
            startTime: "00:00:01,000",
            endTime: "00:00:06,000",
            text: `{\\an8}<font color="#8A5A99"><b>[ ${CONFIG.ADDON_NAME} ] By HN95</b></font>${cutText}`
        });
        
        const fixedText = srtParser.toSrt(cleanParsed);
        const cacheId = `elite_eng_ruler_${rulerName.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}.srt`;
        subtitleCache.set(cacheId, fixedText);
        
        return {
            id: cacheId,
            url: `${HOST}/dl/${cacheId}`,
            lang: "eng", 
            title: `[👑 English | ${rulerName}]\n[${baselineObj.candidate.source}] ${baselineObj.candidate.releaseName}`
        };
    } catch(e) { return null; }
}

// 🔥 NO-RESULTS DIAGNOSTIC
// Builds a short on-screen explanation when the engine returns nothing.
// Crucially, the "try X instead" advice is EVIDENCE-BASED: it tallies the
// release types of the subtitles that actually exist for this title (from
// the candidate pool we already fetched — no extra API calls), and only
// suggests a type that genuinely has subtitles available. If nothing at
// all exists, it says so instead of inventing a suggestion.
function buildNoResultsDiagnostic(diagPool, detectedType, streamTypeGroup, userConfig, isTV) {
    const TYPE_LABELS = {
        'WEBDL': 'WEB-DL', 'WEBDL_4K': 'WEB-DL 4K',
        'WEBRIP': 'WEBRip', 'WEBRIP_4K': 'WEBRip 4K',
        'BLURAY': 'BluRay/REMUX', 'BLURAY_4K': 'BluRay/REMUX 4K',
        'HDTV': 'HDTV', 'HDTV_4K': 'HDTV 4K',
        'DVD': 'DVD', 'CAM': 'CAM'
    };

    // Tally what release types the available subtitles actually cover
    const tally = {};
    for (const c of diagPool) {
        const g = getReleaseTypeGroup(tokeniseRelease(c.releaseName || ''));
        if (!g) continue;
        tally[g] = (tally[g] || 0) + 1;
    }

    const currentCount = tally[streamTypeGroup] || 0;
    const alternatives = Object.entries(tally)
        .filter(([g]) => g !== streamTypeGroup)
        .sort((a, b) => b[1] - a[1]);

    let reason;
    let suggestion;

    if (diagPool.length === 0) {
        reason = `No subtitles exist for this title in your selected language.`;
        suggestion = userConfig.targetLang === 'ar' || userConfig.targetLang === 'ara'
            ? `Try switching Language to English in the dashboard, or check back later.`
            : `Try switching Language in the dashboard, or check back later.`;
    } else if (alternatives.length > 0) {
        const list = alternatives.slice(0, 3).map(([g, n]) => `${TYPE_LABELS[g] || g} (${n})`).join(', ');
        reason = `Found ${diagPool.length} subtitle(s) for this title, but ${currentCount} for your version (${detectedType}).`;
        suggestion = `Play a different release instead — available: ${list}.`;
    } else if (currentCount > 0) {
        reason = `Found ${currentCount} subtitle(s) matching ${detectedType}, but none passed the sync/quality checks.`;
        suggestion = `Lower "Engine Strictness" in the dashboard, or enable Route B / Route C for looser matching.`;
    } else {
        reason = `Found ${diagPool.length} subtitle(s), but none could be matched to your version (${detectedType}).`;
        suggestion = `Try a different release, or lower "Engine Strictness" in the dashboard.`;
    }

    // Extra hints for settings that commonly cause an empty result
    const hints = [];
    if (userConfig.matchCut) hints.push(`"Match Subtitles With Movie's Cut" is ON — it may be filtering valid results.`);
    if (userConfig.strict4k) hints.push(`"Strict 4K Shield" is ON — it blocks 1080p fallback baselines.`);
    if (userConfig.engineStrength >= 4) hints.push(`Engine Strictness is ${userConfig.engineStrength} (high).`);
    if (!userConfig.allowRouteB && !userConfig.allowRouteC) hints.push(`Route B and Route C are both OFF — no fallbacks available.`);
    const text = `1\n00:00:01,000 --> 00:00:12,000\n{\\an8}<font color="#ff9500"><b>⚠️ ${CONFIG.ADDON_NAME}: No Subtitles Found</b></font>\n<font color="#ffffff">${reason}</font>\n<font color="#00ffcc">💡 ${suggestion}</font>${hints.length ? `\n<font color="#cccccc">${hints.join(' ')}</font>` : ''}`;

    return { text, reason, suggestion };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENGINE (Detached for Background Tasks)
// ─────────────────────────────────────────────────────────────────────────────
async function runSubtitleEngine(args) {
   try {
        // 🔥 1. Get the Username from Stremio
        const username = args.config?.username;
        
        // 🔥 2. Query the SQLite Database for their live settings (Case-Insensitive)
        const userRow = username ? db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username) : null;

        // 🔥 3. KILL SWITCH: If the user doesn't exist
        if (!userRow) {
            console.log(`❌ Blocked request: Invalid or missing Username (${username || 'None'}).`);
            const missingKeyCacheId = `nokey_${Date.now()}.srt`;
            const missingKeyText = `1\n00:00:01,000 --> 00:00:10,000\n{\\an8}<font color="#ff0000"><b>⚠️ الحساب غير مسجل. يرجى إنشاء حساب عبر لوحة التحكم.</b></font>`;
            subtitleCache.set(missingKeyCacheId, missingKeyText);
            return { subtitles: [{ id: missingKeyCacheId, url: `${HOST}/dl/${missingKeyCacheId}`, lang: "ara", title: `⚠️ Account Not Found! Visit Dashboard.` }] };
        }

       // 🔥 4. Apply their live settings from the database
        const userConfig = {
            osKey: userRow.osKey && userRow.osKey.trim() !== "" ? userRow.osKey.trim() : null,
            subdlKey: userRow.subdlKey && userRow.subdlKey.trim() !== "" ? userRow.subdlKey.trim() : null,
            subsourceKey: userRow.subsourceKey && userRow.subsourceKey.trim() !== "" ? userRow.subsourceKey.trim() : null,
            targetLang: userRow.targetLang || 'ar',
            panelLang: userRow.panelLang || 'en',
            stripTags: userRow.stripTags === 1,
            includeStats: userRow.includeStats === 1,
            removeSdh: userRow.removeSdh === 1,
            maxSubs: userRow.maxSubs || 5,
            engineStrength: userRow.engineStrength ?? 3,
            useOs: userRow.useOs !== 0,
            useSubdl: userRow.useSubdl !== 0,
            useSubsource: userRow.useSubsource !== 0,
            allowRouteA: userRow.allowRouteA !== 0,
            allowRouteB: userRow.allowRouteB !== 0,
            allowRouteC: userRow.allowRouteC !== 0,
            strict4k: userRow.strict4k === 1,
            matchCut: userRow.matchCut === 1,
            matchCutDirector: userRow.matchCutDirector === 1,
            matchCutTheatrical: userRow.matchCutTheatrical === 1,
            matchCutExtended: userRow.matchCutExtended === 1
        };
        const isTargetArabic = userConfig.targetLang === 'ara' || userConfig.targetLang === 'ar';
        // 🔥 The real language tag every CONTENT winner (Route A/B/C, Blind
        // Trust) should be pushed under — was hardcoded to "ara" everywhere,
        // which is why English-target results were landing in Stremio's
        // Arabic section regardless of what was actually fetched and synced.
        const outputLang = isTargetArabic ? 'ara' : 'eng';
        if (!userConfig.osKey) {
            console.log(`❌ Blocked request: User ${username} has no OpenSubtitles Key in DB.`);
            const nokeyId = `nokey2_${Date.now()}.srt`;
            subtitleCache.set(nokeyId, `1\n00:00:01,000 --> 00:00:10,000\n{\\an8}<font color="#ff0000"><b>⚠️ الرجاء إدخال مفتاح OpenSubtitles الخاص بك في لوحة التحكم.</b></font>`);
            return { subtitles: [{ id: nokeyId, url: `${HOST}/dl/${nokeyId}`, lang: "ara", title: `⚠️ Missing OS Key! Update Profile.` }] };
        }
        
        // Extract required legacy vars for downstream logic
        const activeOsKey = userConfig.osKey;
        const stripTags = userConfig.stripTags;
        const maskedKey = `...${activeOsKey.slice(-3)}`;
        
        // 🔥 Pulled 'args.extra?.title' to ensure we never miss metadata
        const streamName    = args.extra?.filename ?? args.extra?.title ?? args.extra?.name ?? null;
        const idParts       = args.id.split(':');
        const imdbId        = idParts[0].replace('tt', '');
        const season        = idParts[1] ?? null;
        const episode       = idParts[2] ?? null;
        const videoHash     = args.extra?.videoHash ?? null;
        const releaseTokens = tokeniseRelease(streamName || '');
        const streamTypeGroup = getReleaseTypeGroup(releaseTokens);
        const isTV          = !!(season && episode);
        const is4K          = releaseTokens.has('2160p') || releaseTokens.has('4k'); // 🔥 Track 4K state

        let detectedType = 'Unknown';
        const resTag = is4K ? ' 4K' : '';

if (streamTypeGroup?.startsWith('WEBDL')) detectedType = 'WEB-DL' + resTag;
        else if (streamTypeGroup?.startsWith('WEBRIP')) detectedType = 'WEBRip' + resTag;
        else if (streamTypeGroup?.startsWith('BLURAY')) detectedType = (releaseTokens.has('remux') ? 'REMUX' : 'BLURAY') + resTag;
        else if (streamTypeGroup?.startsWith('HDTV')) detectedType = 'HDTV' + resTag;
        else if (streamTypeGroup?.startsWith('DVD')) detectedType = 'DVD' + resTag;
        else if (streamTypeGroup?.startsWith('CAM')) detectedType = 'CAM' + resTag; 

        // 🔥 CACHE COLLISION SHIELD: Isolate different movie cuts
        let cutTag = [];
        if (releaseTokens.has('director') || releaseTokens.has('directors') || releaseTokens.has('dc')) cutTag.push('DC');
        if (releaseTokens.has('extended')) cutTag.push('EXT');
        if (releaseTokens.has('theatrical')) cutTag.push('THEATRICAL');
        if (releaseTokens.has('unrated')) cutTag.push('UNRATED');
        if (releaseTokens.has('final')) cutTag.push('FINAL');
       const editionKey = cutTag.length > 0 ? `_${cutTag.join('-')}` : '';

        // 🔥 Hoisted here (was previously computed separately, later, inside
        // each of TV/Movie mode) so ruler-locking can ALSO use it — the
        // "Match subtitles with the movie's cut" feature needs to filter
        // rulers, not just content candidates, or a wrong-edition ruler
        // still gets locked and Route A syncs everything against it anyway.
        const cutKeywords = ['director', 'directors', 'extended', 'theatrical', 'unrated', 'final', 'dc'];
        const userCuts = [...releaseTokens].filter(t => cutKeywords.includes(t));

        // 🔥 Which canonical cuts the user opted into strict enforcement
        // for, via the new per-cut panel. Built once, passed to every
        // isCutCompatible() call below.
        const enabledCutSet = new Set();
        if (userConfig.matchCutDirector) enabledCutSet.add('director');
        if (userConfig.matchCutTheatrical) enabledCutSet.add('theatrical');
        if (userConfig.matchCutExtended) enabledCutSet.add('extended');

// 🔥 Cache Key now tracks all active configurations to avoid crossover
       const providerKey = `${userConfig.useOs?1:0}${userConfig.useSubdl?1:0}${userConfig.useSubsource?1:0}`;
       const routeKey = `${userConfig.allowRouteA?1:0}${userConfig.allowRouteB?1:0}${userConfig.allowRouteC?1:0}`;
       const requestCacheKey = `${args.id}_${detectedType}${editionKey}_${activeOsKey}_lang${userConfig.targetLang}_st${stripTags}_sdh${userConfig.removeSdh}_stth${userConfig.engineStrength}_p${providerKey}_r${routeKey}_4k${userConfig.strict4k?1:0}_mcut${userConfig.matchCut?1:0}${[...enabledCutSet].sort().join('')}_max${userConfig.maxSubs}_stats${userConfig.includeStats?1:0}`;
       if (responseCache.has(requestCacheKey)) {
            const cachedResult = responseCache.get(requestCacheKey);
            if (Date.now() - cachedResult.timestamp < CACHE_TTL_MS) {
                console.log(`\n⚡ [CACHE HIT] Serving ${args.id} instantly! (Zero API credits used)`);
                return { subtitles: cachedResult.subtitles };
            } else {
                responseCache.delete(requestCacheKey); // Delete if expired
            }
        }

        // 🔥 NEW: Streaming Service Detector
        let streamingService = '';
        if (releaseTokens.has('nf') || releaseTokens.has('netflix')) streamingService = 'Netflix';
        else if (releaseTokens.has('amzn') || releaseTokens.has('amazon')) streamingService = 'Amazon';
        else if (releaseTokens.has('atvp') || releaseTokens.has('apple')) streamingService = 'Apple TV+';
        else if (releaseTokens.has('dsnp') || releaseTokens.has('disney')) streamingService = 'Disney+';
        else if (releaseTokens.has('max') || releaseTokens.has('hbo') || releaseTokens.has('hmax')) streamingService = 'Max';
        else if (releaseTokens.has('hulu')) streamingService = 'Hulu';
        else if (releaseTokens.has('pmtp') || releaseTokens.has('paramount')) streamingService = 'Paramount+';
        else if (releaseTokens.has('peacock') || releaseTokens.has('pckg')) streamingService = 'Peacock';
        
        const serviceLog = streamingService ? ` | Service: ${streamingService}` : '';

        console.log(`\n===========================================`);
        console.log(`[${CONFIG.ADDON_NAME}] API: ${maskedKey} | IMDb: ${imdbId} | Title: ${streamName || 'Unknown'} | S${season||'?'}E${episode||'?'} | Type: ${detectedType}${serviceLog}`);

        let finalOutput = [];
        let bestFallback = null;
        // 🔥 Raw target-language candidates seen this request (pre-filtering).
        // Used ONLY to explain an empty result — costs no extra API calls.
        let diagPool = [];

        // =====================================================================
        // PATH A: THE TV MULTI-CUT SWEEP
        // =====================================================================
if (isTV) {
            console.log(`\n[TV Mode] Fetching OS Rulers + Arabic Candidates...`);
            let [engOs, engSubdl, engSubsource, arOs, arSubdl, arSubsource] = await Promise.all([
                userConfig.useOs ? fetchOsCandidates({ lang: 'en', imdbId, season, episode, videoHash, releaseTokens, limit: CONFIG.TV_BASELINE_FETCH_POOL, apiKey: activeOsKey, username }) : [],
                userConfig.useSubdl ? fetchSubdlCandidates({ lang: 'en', imdbId, season, episode, releaseTokens, limit: 15, apiKey: userConfig.subdlKey, username }) : [],
                userConfig.useSubsource ? fetchSubsourceCandidates({ langCode: 'en', imdbId, season, episode, releaseTokens, limit: 15, apiKey: userConfig.subsourceKey, username }) : [],
                userConfig.useOs ? fetchOsCandidates({ lang: userConfig.targetLang, imdbId, season, episode, videoHash, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT, apiKey: activeOsKey, username }) : [],
                userConfig.useSubdl ? fetchSubdlCandidates({ lang: userConfig.targetLang, imdbId, season, episode, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT, apiKey: userConfig.subdlKey, username }) : [],
                userConfig.useSubsource ? fetchSubsourceCandidates({ langCode: userConfig.targetLang, imdbId, season, episode, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT, apiKey: userConfig.subsourceKey, username }) : []
            ]);
// 🔥 NEW: Intercept API garbage
            engOs = enforceEpisodeMatch(engOs, season, episode);
            engSubdl = enforceEpisodeMatch(engSubdl, season, episode);
            engSubsource = enforceEpisodeMatch(engSubsource, season, episode);
            arOs = enforceEpisodeMatch(arOs, season, episode);
            arSubdl = enforceEpisodeMatch(arSubdl, season, episode);
            arSubsource = enforceEpisodeMatch(arSubsource, season, episode);

            // 🔥 Combine all English candidates and attach their specific download functions
           // 🔥 Combine all English candidates and attach their specific download functions
       let combinedEng = [
                ...engOs.map(c => ({ ...c, fetchFn: () => getOsSrt(c.fileId, activeOsKey) })),
                ...engSubdl.map(c => ({ ...c, fetchFn: () => getArchiveSrt(c.downloadUrl, season, episode) })),
                ...engSubsource.map(c => ({ ...c, fetchFn: () => getArchiveSrt(c.downloadUrl, season, episode, { 'X-API-Key': userConfig.subsourceKey }) }))
            ];

            const originalCount = combinedEng.length;
        
            console.log(`  🔍 Strict Type Matching: Retained ${combinedEng.length}/${originalCount} TV baselines across all sources.`);

   let osRulers = []; 
            let seenTextSnippets = new Set(); 

            // 🔥 HELPER: Attempts to lock rulers for a specific group.
            // Downloads happen in small concurrent batches (network I/O
            // parallelized) but are still EVALUATED in the exact original
            // order, one at a time — so which candidate becomes "Ruler 1" vs
            // "Ruler 2" and the distinct-cut comparisons are unchanged from
            // before. We check the early-exit condition BETWEEN batches (and
            // mid-batch) so once enough rulers are locked we stop launching
            // further downloads instead of eagerly fetching a whole extra
            // batch we no longer need.
            const tryLockTvRulers = async (targetGroup) => {
                let strictEng = filterBaselinesByType(combinedEng, targetGroup);
                if (userConfig.matchCut) {
                    strictEng = strictEng.filter(c => isCutCompatible(releaseTokens, c.releaseName, enabledCutSet));
                }
                for (let i = 0; i < strictEng.length; i += PREFETCH_BATCH_SIZE) {
                    if (osRulers.length >= CONFIG.TV_DISTINCT_CUTS_LIMIT) break;
                    const batch = strictEng.slice(i, i + PREFETCH_BATCH_SIZE);
                    const batchResults = await Promise.all(batch.map(async c => {
                        try { return { c, srt: await c.fetchFn() }; } catch { return { c, srt: null }; }
                    }));

                    for (const { c, srt } of batchResults) {
                        if (osRulers.length >= CONFIG.TV_DISTINCT_CUTS_LIMIT) break;
                        if (!srt) continue;
                        const textSnippet = srt.text.substring(0, 200).trim();
                        if (seenTextSnippets.has(textSnippet)) continue;
                        seenTextSnippets.add(textSnippet);

                        if (osRulers.length === 0) {
                            osRulers.push({ text: srt.text, candidate: c });
                            console.log(`  ✅ TV Ruler 1 locked [${c.source} | ${targetGroup}]`);
                        } else {
                            let isDistinct = true;
                            for (const r of osRulers) {
                                if (!isDistinctCut(r.text, srt.text)) { isDistinct = false; break; }
                            }
                            if (isDistinct) {
                                osRulers.push({ text: srt.text, candidate: c });
                                console.log(`  ✅ TV Ruler ${osRulers.length} locked (Distinct Cut) [${c.source} | ${targetGroup}]`);
                            }
                        }
                    }
                }
            };

            await tryLockTvRulers(streamTypeGroup);

 // 🔥 THE 4K FALLBACK PROTOCOL
            let fallbackTriggered = false;
            if (osRulers.length === 0 && is4K) {
                if (!userConfig.strict4k) {
                    const fallbackGroup = streamTypeGroup.replace('_4K', '');
                    console.log(`⚠️ 4K Starvation: No 4K Rulers found. Falling back to 1080p baselines (${fallbackGroup})...`);
                    await tryLockTvRulers(fallbackGroup);
                    fallbackTriggered = true;
                } else {
                    console.log(`🛡️ 4K Strictness Shield Active: Refusing to fall back to 1080p baselines.`);
                }
            }

if (osRulers.length === 0) {
                console.log(`⚠️ No TV Rulers locked. Skipping Route A.`);
            }

            // 🔥 BUG FIX: precomputed once so the gauntlet loop below can
            // cheaply skip any "content" candidate that's textually IDENTICAL
            // to a Master Ruler (this happens when target language == 'en',
            // since the ruler and content pools then query the same provider
            // for the same language and can return the same file). Syncing a
            // file against itself produces a near-perfect "winner" that's the
            // same subtitle as the Master Ruler — except the Ruler never
            // applies stripTags/removeSdh while a real winner does, so it
            // looked like "the same subtitle twice, one formatted, one not."
            const rulerSignatures = osRulers.map(r => getTextSignature(r.text, isTargetArabic));

            // 🔥 Whichever group actually backs our locked ruler(s) — if we fell
            // back from 4K to 1080p, Route B must match against 1080p too.
            // Arabic releases are almost never tagged "4K", so filtering Route B
            // against the raw 4K label would silently empty it out every time.
            const effectiveTypeGroup = fallbackTriggered ? streamTypeGroup.replace('_4K', '') : streamTypeGroup;
            const allCandidates = [
                ...arOs.map(c => ({ ...c, fetchFn: () => getOsSrt(c.fileId, activeOsKey) })),
                ...arSubdl.map(c => ({ ...c, fetchFn: () => getArchiveSrt(c.downloadUrl, season, episode) })),
                ...arSubsource.map(c => ({ ...c, fetchFn: () => getArchiveSrt(c.downloadUrl, season, episode, { 'X-API-Key': userConfig.subsourceKey }) }))
            ];
            // 🔥 Snapshot for the no-results diagnostic (before any filtering)
            diagPool = allCandidates.map(c => ({ releaseName: c.releaseName }));

            let allSurvivingTvArabic = [];

          // 🔥 Strictness Level 5 uses cutKeywords/userCuts computed earlier

            // 🔥 Apply the cheap, synchronous cut-focus filter BEFORE
            // prefetching — so we never waste a network download on a
            // candidate we were going to skip anyway. allCandidates itself
            // stays untouched (Route B below still needs the full list).
            let tvCandidatesToProcess = allCandidates;
            if (userConfig.engineStrength === 5 && userCuts.length > 0) {
                tvCandidatesToProcess = tvCandidatesToProcess.filter(c => {
                    const cTokens = tokeniseRelease(c.releaseName);
                    const hasMatchingCut = userCuts.some(cut => cTokens.has(cut) || (cut === 'dc' && cTokens.has('director')) || (cut === 'director' && cTokens.has('dc')));
                    if (!hasMatchingCut) console.log(`  🛡️ [Level 5 Cut Focus] Skipping ${c.releaseName} (Missing required cut)`);
                    return hasMatchingCut;
                });
            }
            // 🔥 NEW: "Match subtitles with the movie's cut" — independent,
            // opt-in toggle (separate from engine strictness). See
            // checkCutCompatibility() for the exact Director/Theatrical/Extended matching rules.
            if (userConfig.matchCut) {
                tvCandidatesToProcess = tvCandidatesToProcess.filter(c => {
                    const result = checkCutCompatibility(releaseTokens, c.releaseName, enabledCutSet);
                    if (!result.compatible) {
                        console.log(`  🎬 [Cut Match] Skipping ${c.releaseName} (Edition mismatch with played file)`);
                        return false;
                    }
                    if (result.unverified) c._cutUnverified = true;
                    return true;
                });
            }
            await prefetchInBatches(tvCandidatesToProcess);

            console.log(`\n[TV Mode] Initiating Battle Royale against ${osRulers.length} OS Cuts...`);
            for (let i = 0; i < tvCandidatesToProcess.length; i++) {
                const c = tvCandidatesToProcess[i];

             const arabicData = c._prefetched;
                if (!arabicData) continue;

                // 🔥 BUG FIX: skip a candidate that's literally the same file
                // as an already-locked Master Ruler. Checked BEFORE
                // .fetchedText is set, so Route B can't independently
                // re-surface it either.
                if (rulerSignatures.some(sig => sig.length > 50 && sig === getTextSignature(arabicData.text, isTargetArabic))) {
                    continue;
                }

                c.fetchedText = arabicData.text; // 🔥 Cache for Route B & C
                // 🔥 Route C should hand back the BEST-scoring fallback, not
                // just whichever candidate happened to download first —
                // score is already computed by each provider's fetch step.
                if (!bestFallback || c.score > bestFallback.candidate.score) {
                    bestFallback = { candidate: c, text: arabicData.text };
                }

              // ─── ROUTE A: The Math Gauntlet (tried FIRST, even against a 4K-fallback ruler) ───
                if (userConfig.allowRouteA && osRulers.length > 0) {
                    let bestScoreForCandidate = null;
                    for (let rIdx = 0; rIdx < osRulers.length; rIdx++) {
                       const ruler = osRulers[rIdx];
                        const result = computePrecisionShift(ruler.text, arabicData.text, `${c.source} vs OS Cut ${rIdx+1}`, c.source, detectedType, c.releaseName, true, userConfig);
                        if (result.passed && (!bestScoreForCandidate || result.alignmentPct > bestScoreForCandidate.alignmentPct)) {
                            bestScoreForCandidate = { candidate: c, matchedRuler: `OS Cut ${rIdx+1}`, ...result };
                        }
                    }
                    if (bestScoreForCandidate) {
                        allSurvivingTvArabic.push(bestScoreForCandidate);
                    }
                }
                // 🔥 REMOVED: 4K Blind Trust Protocol. It bypassed Route A's
                // math verification ENTIRELY (always "0ms, Unverified") on
                // nothing more than a matching 4K tag — no sync check, no
                // cut/edition check at all. A candidate that fails Route A
                // now simply isn't pushed here; it can still surface via
                // Route B ("Raw Match") or Route C, both of which are
                // honest about being unverified instead of dressed up as a
                // confident "4K Trust" result.
            }
     // 2. ALWAYS push the Clean English Rulers conditionally based on Route A
           if (userConfig.allowRouteA) {
                for (let rIdx = 0; rIdx < osRulers.length; rIdx++) {
                    const cleanEnglish = processEnglishRuler(osRulers[rIdx], `OS Cut ${rIdx+1}`, detectedType, isTV, releaseTokens, userConfig);
                    if (cleanEnglish) finalOutput.push({ ...cleanEnglish, isRuler: true });
                }
            }

// 3. Sort all survivors and grab up to 3 unique files PER OS CUT
            const sortFn = (a, b) => b.alignmentPct === a.alignmentPct ? (a.driftMs - b.driftMs) : (b.alignmentPct - a.alignmentPct);
            allSurvivingTvArabic.sort(sortFn);
            
            const finalTvWinners = []; 
            const cutWinnerTracker = {}; 

          for (const candidate of allSurvivingTvArabic) {
                const cutName = candidate.matchedRuler;
                if (!cutWinnerTracker[cutName]) cutWinnerTracker[cutName] = 0;
                if (cutWinnerTracker[cutName] >= 3) continue;

      // 🔥 THE OPTIMIZED SHIELD (Text is King)
                const isClone = finalTvWinners.some(existing => {
                    const candidateSig = getTextSignature(candidate.fixedText, isTargetArabic);
                    const existingSig = getTextSignature(existing.fixedText, isTargetArabic);
                    const textMatches = candidateSig.length > 50 && candidateSig === existingSig;

                    // Only fall back to Math if the text signature somehow failed to generate
                    let mathMatches = false;
                    if (candidateSig.length <= 50) {
                        const pctDiff = Math.abs(existing.alignmentPct - candidate.alignmentPct);
                        const offsetDiff = Math.abs(existing.offsetMs - candidate.offsetMs);
                        mathMatches = pctDiff < 0.2 && offsetDiff <= 2;
                    }

                    return textMatches || mathMatches; 
                });

                if (isClone) {
                    console.log(`    🗑️ [2FA Clone Killed] ${candidate.candidate.releaseName}`);
                    continue; 
                }

                finalTvWinners.push(candidate);
                cutWinnerTracker[cutName]++; 

               // 🔥 Custom Filename Format: Brlm-subs-[Align]-[Offset]_[TinyID].srt
                const cacheId = `Brlm-subs-[${candidate.alignmentPct.toFixed(0)}]-[${candidate.offsetMs>0?'+':''}${candidate.offsetMs.toFixed(0)}ms]_${Math.floor(Math.random()*10000)}.srt`;
                
                let finalSrtText = candidate.fixedText;
                if (stripTags) {
                    finalSrtText = finalSrtText.replace(/\{[^}]+\}/g, '').replace(/<[^>]+>/g, '');
                }
                
                subtitleCache.set(cacheId, finalSrtText);
                
            finalOutput.push({
                    id: cacheId, url: `${HOST}/dl/${cacheId}`, lang: outputLang,
                    title: `[Synced to ${candidate.matchedRuler} | ${candidate.alignmentPct.toFixed(0)}%${cutUnverifiedNote(candidate.candidate)}] (${candidate.offsetMs>0?'+':''}${candidate.offsetMs.toFixed(0)}ms)\n[${candidate.candidate.source}] ${candidate.candidate.releaseName}`
                });
            }

  // ─── ROUTE B: The Top 2 Raw Token Matches ───
            if (userConfig.allowRouteB) {
                console.log(`\n[TV Mode] Extracting Route B (Top 2 Raw Matches)...`);
              const routeBCandidates = filterBaselinesByType(allCandidates.filter(c => c.fetchedText), effectiveTypeGroup).sort((a, b) => b.score - a.score);
let routeBCount = 0;
            for (const c of routeBCandidates) {
                if (routeBCount >= 2) break;
                
                if (isTargetArabic) {
                    const arabicCharCount = (c.fetchedText.match(/[\u0600-\u06FF]/g) || []).length;
                    const latinCharCount = (c.fetchedText.match(/[a-zA-Z]/g) || []).length;
                    if (arabicCharCount < CONFIG.Min_Arabic_Letters || latinCharCount > arabicCharCount) continue;
                }

              const cSig = getComparableSignature(c.fetchedText, isTargetArabic, userConfig.removeSdh);
                const isAlreadyInRouteA = finalOutput.filter(o => !o.isRuler).some(existing => {
                    const existingSubText = subtitleCache.get(existing.id.split('/').pop() || existing.id) || "";
                    return existingSubText && getTextSignature(existingSubText, isTargetArabic) === cSig;
                });

                if (isAlreadyInRouteA) continue;

                console.log(`  🚀 [Route B] Pushing top match: ${c.releaseName}`);
                try {
                    let routeBParsed = srtParser.fromSrt(c.fetchedText);
                    // 🔥 Route B previously skipped SDH stripping entirely —
                    // only Route A winners and the English rulers were ever
                    // cleaned, so "Remove SDH Elements" silently did nothing
                    // for any Route B result.
                    if (userConfig.removeSdh) routeBParsed = stripSdhAndClean(routeBParsed);
                    routeBParsed.unshift({ id: "0", startTime: "00:00:01,000", endTime: "00:00:06,000", text: `{\\an8}<font color="#8A5A99"><b>[ ${CONFIG.ADDON_NAME} ] By HN95</b></font>\nType: ${detectedType} (Route B)` });
                    let finalRouteBText = srtParser.toSrt(routeBParsed);
                    if (stripTags) finalRouteBText = finalRouteBText.replace(/\{[^}]+\}/g, '').replace(/<[^>]+>/g, '');
                    const cacheId = `elite_tv_ar_RouteB_${Date.now()}_${Math.floor(Math.random()*10000)}.srt`;
                    subtitleCache.set(cacheId, finalRouteBText);
                   finalOutput.push({ id: cacheId, url: `${HOST}/dl/${cacheId}`, lang: outputLang, title: `[⚠️ Route B | Raw Top Match${cutUnverifiedNote(c)}]\n[${c.source}] ${c.releaseName}` });
                    routeBCount++;
                } catch(e) {}
            }
        }
		}
// =====================================================================
        // PATH B: THE MOVIE CROSS-MATRIX
        // =====================================================================
        else {
            console.log(`\n[Movie Mode] Fetching 3 Master Rulers + Candidates...`);
        let [engOs, engSubdl, engSubsource, arOs, arSubdl, arSubsource] = await Promise.all([
                userConfig.useOs ? fetchOsCandidates({ lang: 'en', imdbId, season, episode, videoHash, releaseTokens, limit: CONFIG.MOVIE_BASELINE_LIMIT, apiKey: activeOsKey, username }) : [],
                userConfig.useSubdl ? fetchSubdlCandidates({ lang: 'en', imdbId, season, episode, releaseTokens, limit: CONFIG.MOVIE_BASELINE_LIMIT, apiKey: userConfig.subdlKey, username }) : [],
                userConfig.useSubsource ? fetchSubsourceCandidates({ langCode: 'en', imdbId, season, episode, releaseTokens, limit: CONFIG.MOVIE_BASELINE_LIMIT, apiKey: userConfig.subsourceKey, username }) : [],
                
                userConfig.useOs ? fetchOsCandidates({ lang: userConfig.targetLang, imdbId, season, episode, videoHash, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT, apiKey: activeOsKey, username }) : [],
                userConfig.useSubdl ? fetchSubdlCandidates({ lang: userConfig.targetLang, imdbId, season, episode, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT, apiKey: userConfig.subdlKey, username }) : [],
                userConfig.useSubsource ? fetchSubsourceCandidates({ langCode: userConfig.targetLang, imdbId, season, episode, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT, apiKey: userConfig.subsourceKey, username }) : []
            ]);

            let osBaseline = null, subdlBaseline = null, subsourceBaseline = null;

            // 🔥 HELPER: Attempts to lock rulers for a specific group. These
            // three providers' rulers are fully independent of each other
            // (no shared distinct-cut bookkeeping like TV mode has), so
            // running them concurrently rather than one-after-another cuts
            // wall-clock ruler-locking time roughly to the slowest of the
            // three instead of the sum of all three. Each provider's own
            // loop still stops at its first success — unchanged.
            const tryLockMovieRulers = async (targetGroup) => {
                let fOs = filterBaselinesByType(engOs, targetGroup);
                let fSubdl = filterBaselinesByType(engSubdl, targetGroup);
                let fSubsource = filterBaselinesByType(engSubsource, targetGroup);
                if (userConfig.matchCut) {
                    fOs = fOs.filter(c => isCutCompatible(releaseTokens, c.releaseName, enabledCutSet));
                    fSubdl = fSubdl.filter(c => isCutCompatible(releaseTokens, c.releaseName, enabledCutSet));
                    fSubsource = fSubsource.filter(c => isCutCompatible(releaseTokens, c.releaseName, enabledCutSet));
                }

                await Promise.all([
                    (async () => {
                        for (const c of fOs) {
                            if (osBaseline) break;
                            osBaseline = await getOsSrt(c.fileId, activeOsKey);
                            if (osBaseline) { osBaseline.candidate = c; console.log(`  ✅ OS Ruler locked [${targetGroup}]`); }
                        }
                    })(),
                    (async () => {
                        for (const c of fSubdl) {
                            if (subdlBaseline) break;
                            subdlBaseline = await getArchiveSrt(c.downloadUrl);
                            if (subdlBaseline) { subdlBaseline.candidate = c; console.log(`  ✅ SubDL Ruler locked [${targetGroup}]`); }
                        }
                    })(),
                    (async () => {
                        for (const c of fSubsource) {
                            if (subsourceBaseline) break;
                            const key = userConfig.subsourceKey;
                            subsourceBaseline = await getArchiveSrt(c.downloadUrl, null, null, { 'X-API-Key': key });
                            if (subsourceBaseline) { subsourceBaseline.candidate = c; console.log(`  ✅ SubSource Ruler locked [${targetGroup}]`); }
                        }
                    })()
                ]);
            };

            await tryLockMovieRulers(streamTypeGroup);

            // 🔥 THE 4K FALLBACK PROTOCOL
            let fallbackTriggered = false;
            const hasMovieRulers = osBaseline || subdlBaseline || subsourceBaseline;
            if (!hasMovieRulers && is4K) {
                if (!userConfig.strict4k) {
                    const fallbackGroup = streamTypeGroup.replace('_4K', '');
                    console.log(`⚠️ 4K Starvation: No 4K Rulers found. Falling back to 1080p baselines (${fallbackGroup})...`);
                    await tryLockMovieRulers(fallbackGroup);
                    fallbackTriggered = true;
                } else {
                    console.log(`🛡️ 4K Strictness Shield Active: Refusing to fall back to 1080p baselines.`);
                }
          } else if (!hasMovieRulers) {
                console.log(`⚠️ No Movie Rulers locked. Skipping Route A.`);
            }

            // 🔥 BUG FIX: same self-sync duplicate protection as TV mode —
            // see the matching comment there for the full explanation.
            const rulerSignatures = [osBaseline, subdlBaseline, subsourceBaseline]
                .filter(Boolean)
                .map(r => getTextSignature(r.text, isTargetArabic));

            // 🔥 Whichever group actually backs our locked ruler(s) — if we fell
            // back from 4K to 1080p, Route B must match against 1080p too.
            const effectiveTypeGroup = fallbackTriggered ? streamTypeGroup.replace('_4K', '') : streamTypeGroup;

            const allArabicCandidates = [
                ...arOs.map((c, index) => ({ ...c, trackNum: index + 1, fetchFn: () => getOsSrt(c.fileId, activeOsKey) })),
                ...arSubdl.map((c, index) => ({ ...c, trackNum: index + 1, fetchFn: () => getArchiveSrt(c.downloadUrl) })),
                ...arSubsource.map((c, index) => ({ ...c, trackNum: index + 1, fetchFn: () => getArchiveSrt(c.downloadUrl, null, null, { 'X-API-Key': userConfig.subsourceKey }) })),
            ];
            // 🔥 Snapshot for the no-results diagnostic (before any filtering)
            diagPool = allArabicCandidates.map(c => ({ releaseName: c.releaseName }));

            let allSurvivingArabic = [];
let sourceCounters = { 'OpenSubtitles': 0, 'SubDL': 0, 'SubSource': 0 };

            // 🔥 Strictness Level 5 uses cutKeywords/userCuts computed earlier

            // 🔥 Apply the cheap, synchronous cut-focus filter BEFORE
            // prefetching — so we never waste a network download on a
            // candidate we were going to skip anyway. allArabicCandidates
            // itself stays untouched (Route B below still needs the full list).
            let movieCandidatesToProcess = allArabicCandidates;
            if (userConfig.engineStrength === 5 && userCuts.length > 0) {
                movieCandidatesToProcess = movieCandidatesToProcess.filter(c => {
                    const cTokens = tokeniseRelease(c.releaseName);
                    const hasMatchingCut = userCuts.some(cut => cTokens.has(cut) || (cut === 'dc' && cTokens.has('director')) || (cut === 'director' && cTokens.has('dc')));
                    if (!hasMatchingCut) console.log(`  🛡️ [Level 5 Cut Focus] Skipping ${c.releaseName} (Missing required cut)`);
                    return hasMatchingCut;
                });
            }
            // 🔥 NEW: "Match subtitles with the movie's cut" — independent,
            // opt-in toggle (separate from engine strictness).
            if (userConfig.matchCut) {
                movieCandidatesToProcess = movieCandidatesToProcess.filter(c => {
                    const result = checkCutCompatibility(releaseTokens, c.releaseName, enabledCutSet);
                    if (!result.compatible) {
                        console.log(`  🎬 [Cut Match] Skipping ${c.releaseName} (Edition mismatch with played file)`);
                        return false;
                    }
                    if (result.unverified) c._cutUnverified = true;
                    return true;
                });
            }
            await prefetchInBatches(movieCandidatesToProcess);

            console.log(`\n[Movie Mode] Initiating 3-Ruler Cross-Matrix Gauntlet...`);
            for (let i = 0; i < movieCandidatesToProcess.length; i++) {
                const c = movieCandidatesToProcess[i];

              const arabicData = c._prefetched;
                if (!arabicData) continue;

                // 🔥 BUG FIX: skip a candidate that's literally the same file
                // as an already-locked Master Ruler. Checked BEFORE
                // .fetchedText is set, so Route B can't independently
                // re-surface it either.
                if (rulerSignatures.some(sig => sig.length > 50 && sig === getTextSignature(arabicData.text, isTargetArabic))) {
                    continue;
                }

                c.fetchedText = arabicData.text; // 🔥 Cache for Route B & C
                // 🔥 Route C should hand back the BEST-scoring fallback, not
                // just whichever candidate happened to download first.
                if (!bestFallback || c.score > bestFallback.candidate.score) {
                    bestFallback = { candidate: c, text: arabicData.text };
                }

                // ─── ROUTE A: The Math Gauntlet (tried FIRST, even against a 4K-fallback ruler) ───
                if (userConfig.allowRouteA && hasMovieRulers) {
                    sourceCounters[c.source] = (sourceCounters[c.source] || 0) + 1;
                    const candidateLabel = `${c.source}[${sourceCounters[c.source]}]`;
                    let bestScoreForCandidate = null;

                    const testAgainstRuler = (baseline, rulerName) => {
                        if (!baseline) return;
                        const result = computePrecisionShift(baseline.text, arabicData.text, `${candidateLabel} vs ${rulerName} Ruler`, c.source, detectedType, c.releaseName, false, userConfig);
                        if (result.passed) {
                            if (!bestScoreForCandidate) {
                                bestScoreForCandidate = { candidate: c, rulerName, ...result };
                            } else {
                                const driftImprovement = bestScoreForCandidate.driftMs - result.driftMs;
                                if (driftImprovement > 40 || (Math.abs(driftImprovement) <= 40 && result.alignmentPct > bestScoreForCandidate.alignmentPct)) {
                                    bestScoreForCandidate = { candidate: c, rulerName, ...result };
                                }
                            }
                        }
                    };
                    testAgainstRuler(osBaseline, 'OpenSubtitles');
                    testAgainstRuler(subdlBaseline, 'SubDL');
                    testAgainstRuler(subsourceBaseline, 'SubSource');

                    if (bestScoreForCandidate) {
                        allSurvivingArabic.push(bestScoreForCandidate);
                    }
                }
                // 🔥 REMOVED: 4K Blind Trust Protocol. It bypassed Route A's
                // math verification ENTIRELY (always "0ms, Unverified") on
                // nothing more than a matching 4K tag — no sync check, no
                // cut/edition check at all. A candidate that fails Route A
                // now simply isn't pushed here; it can still surface via
                // Route B ("Raw Match") or Route C, both of which are
                // honest about being unverified instead of dressed up as a
                // confident "4K Trust" result.
            }

            // 2. Sort by "True Sync Score" (Native 0ms matches float to the absolute top)
            const sortFn = (a, b) => {
                // Penalize drift heavily during sorting so 0ms native matches beat slightly drifty high-percentage matches
                const scoreA = a.alignmentPct - (a.driftMs > 30 ? (a.driftMs / 20) : 0);
                const scoreB = b.alignmentPct - (b.driftMs > 30 ? (b.driftMs / 20) : 0);
                return scoreB === scoreA ? (a.driftMs - b.driftMs) : (scoreB - scoreA);
            };
            allSurvivingArabic.sort(sortFn);

// 3. Clone Firewall: Pick the absolute Top 5 UNIQUE translations overall
            const topArabic = [];
            const usedRulers = new Set();

for (const champ of allSurvivingArabic) {
           // 🔥 THE OPTIMIZED SHIELD (Text is King)
                const isClone = topArabic.some(existing => {
                    const candidateSig = getTextSignature(champ.fixedText, isTargetArabic);
                    const existingSig = getTextSignature(existing.fixedText, isTargetArabic);
                    const textMatches = candidateSig.length > 50 && candidateSig === existingSig;

                    // Only fall back to Math if the text signature somehow failed to generate
                    let mathMatches = false;
                    if (candidateSig.length <= 50) {
                        const pctDiff = Math.abs(existing.alignmentPct - champ.alignmentPct);
                        const offsetDiff = Math.abs(existing.offsetMs - champ.offsetMs);
                        mathMatches = pctDiff < 0.2 && offsetDiff <= 2;
                    }

                    return textMatches || mathMatches; 
                });

                if (isClone) {
                    console.log(`    🗑️ [2FA Clone Killed] Skipping duplicate: ${champ.candidate.releaseName}`);
                    continue; 
                }
                
                topArabic.push(champ);
                usedRulers.add(champ.rulerName); // Remember which English ruler it synced to
                
                if (topArabic.length >= 5) break; 
            }
           // 4. Push Clean English Rulers conditionally
           if (userConfig.allowRouteA) {
               const r1 = osBaseline ? processEnglishRuler(osBaseline, 'OpenSubtitles', detectedType, isTV, releaseTokens, userConfig) : null;
               if (r1) finalOutput.push({ ...r1, isRuler: true });
               const r2 = subdlBaseline ? processEnglishRuler(subdlBaseline, 'SubDL', detectedType, isTV, releaseTokens, userConfig) : null;
               if (r2) finalOutput.push({ ...r2, isRuler: true });
               const r3 = subsourceBaseline ? processEnglishRuler(subsourceBaseline, 'SubSource', detectedType, isTV, releaseTokens, userConfig) : null;
               if (r3) finalOutput.push({ ...r3, isRuler: true });
           }
// 5. Push the Top Arabic Winners
          for (const champ of topArabic) {
                // 🔥 Custom Filename Format: Brlm-subs-[Align]-[Offset]_[TinyID].srt
                const cacheId = `Brlm-subs-[${champ.alignmentPct.toFixed(0)}]-[${champ.offsetMs>0?'+':''}${champ.offsetMs.toFixed(0)}ms]_${Math.floor(Math.random()*10000)}.srt`;
                
                // 🔥 NEW: The Tag Vaporizer
                let finalSrtText = champ.fixedText;
                if (stripTags) {
                    finalSrtText = finalSrtText.replace(/\{[^}]+\}/g, '').replace(/<[^>]+>/g, '');
                }
                
                subtitleCache.set(cacheId, finalSrtText);
              finalOutput.push({
                    id: cacheId, url: `${HOST}/dl/${cacheId}`, lang: outputLang,
                    title: `[Synced to ${champ.rulerName} Ruler | ${champ.alignmentPct.toFixed(0)}%${cutUnverifiedNote(champ.candidate)}] (${champ.offsetMs>0?'+':''}${champ.offsetMs.toFixed(0)}ms)\n[${champ.candidate.source}[${champ.candidate.trackNum}]] ${champ.candidate.releaseName}`
                });
            }

        // ─── ROUTE B: The Top 2 Raw Token Matches ───
            if (userConfig.allowRouteB) {
                console.log(`\n[Movie Mode] Extracting Route B (Top 2 Raw Matches)...`);
                const routeBCandidates = filterBaselinesByType(allArabicCandidates.filter(c => c.fetchedText), effectiveTypeGroup).sort((a, b) => b.score - a.score);
                let routeBCount = 0;
                
                for (const c of routeBCandidates) {
                    if (routeBCount >= 2) break;
                    
                    if (isTargetArabic) {
                        const arabicCharCount = (c.fetchedText.match(/[\u0600-\u06FF]/g) || []).length;
                        const latinCharCount = (c.fetchedText.match(/[a-zA-Z]/g) || []).length;
                        if (arabicCharCount < CONFIG.Min_Arabic_Letters || latinCharCount > arabicCharCount) continue;
                    }

               const cSig = getComparableSignature(c.fetchedText, isTargetArabic, userConfig.removeSdh);
                    const isAlreadyInRouteA = finalOutput.filter(o => !o.isRuler).some(existing => {
                        const existingSubText = subtitleCache.get(existing.id.split('/').pop() || existing.id) || "";
                        return existingSubText && getTextSignature(existingSubText, isTargetArabic) === cSig;
                    });

                    if (isAlreadyInRouteA) continue;

                    console.log(`  🚀 [Route B] Pushing top match: ${c.releaseName}`);
                    try {
                       let routeBParsed = srtParser.fromSrt(c.fetchedText);
                        // 🔥 Route B previously skipped SDH stripping entirely (see TV-mode note).
                        if (userConfig.removeSdh) routeBParsed = stripSdhAndClean(routeBParsed);
                        routeBParsed.unshift({ id: "0", startTime: "00:00:01,000", endTime: "00:00:06,000", text: `{\\an8}<font color="#8A5A99"><b>[ ${CONFIG.ADDON_NAME} ] By HN95</b></font>\nType: ${detectedType} (Route B)` });
                        let finalRouteBText = srtParser.toSrt(routeBParsed);
                        if (stripTags) finalRouteBText = finalRouteBText.replace(/\{[^}]+\}/g, '').replace(/<[^>]+>/g, '');
                        const cacheId = `elite_ar_RouteB_${Date.now()}_${Math.floor(Math.random()*10000)}.srt`;
                        subtitleCache.set(cacheId, finalRouteBText);
                        
                       finalOutput.push({ id: cacheId, url: `${HOST}/dl/${cacheId}`, lang: outputLang, title: `[⚠️ Route B | Raw Match${cutUnverifiedNote(c)}]\n[${c.source}[${c.trackNum}]] ${c.releaseName}` });
                        routeBCount++;
                    } catch(e) {}
                }
            }
        }
// =====================================================================
// FINAL DELIVERY & FALLBACK (ROUTE C)
// =====================================================================
// FINAL DELIVERY & FALLBACK (ROUTE C)
finalOutput = finalOutput.filter(item => item !== null);
        const winnersCount = finalOutput.filter(sub => !sub.isRuler).length;

      // 🔥 ROUTE C: If Route A and Route B both failed entirely, serve the absolute fallback
        if (userConfig.allowRouteC && winnersCount === 0 && bestFallback) {
           console.log(`⚠️ Route A & B failed. Serving Route C (Fallback) from ${bestFallback.candidate.source}.`);
            // 🔥 Build the same evidence-based diagnostic the no-results path
            // uses, but MERGE it into the Route C subtitle instead of
            // returning a separate dummy track — the user still gets a usable
            // subtitle, plus an on-screen heads-up that it's unverified and
            // which release would work better.
            const routeCDiag = buildNoResultsDiagnostic(diagPool, detectedType, streamTypeGroup, userConfig, isTV);
            let fallbackParsed;
            try {
                fallbackParsed = srtParser.fromSrt(bestFallback.text);
                // 🔥 Route C previously skipped SDH stripping entirely.
                if (userConfig.removeSdh) fallbackParsed = stripSdhAndClean(fallbackParsed);
                fallbackParsed.unshift({ id: "0", startTime: "00:00:01,000", endTime: "00:00:09,000", text: `{\\an8}<font color="#ff9500"><b>⚠️ ${CONFIG.ADDON_NAME}: Unverified Match (Route C)</b></font>\n<font color="#ffffff">${routeCDiag.reason}</font>\n<font color="#00ffcc">💡 ${routeCDiag.suggestion}</font>` });
                bestFallback.text = srtParser.toSrt(fallbackParsed);
            } catch(e) {}

            const cacheId = `elite_routeC_${Date.now()}.srt`;
            let finalSrtText = bestFallback.text;
            if (stripTags) finalSrtText = finalSrtText.replace(/\{[^}]+\}/g, '').replace(/<[^>]+>/g, '');
            subtitleCache.set(cacheId, finalSrtText);
            finalOutput.push({ id: cacheId, url: `${HOST}/dl/${cacheId}`, lang: outputLang, title: `[🔴 Route C | Unverified — see note at 0:01${cutUnverifiedNote(bestFallback.candidate)}]\n[${bestFallback.candidate.source}] ${bestFallback.candidate.releaseName}` });
        }

       if (finalOutput.length > 0) {
            // 🔥 Enforce the Max Returned Subtitles config. Split on isRuler
            // (not lang) — the Master Ruler and the real winners can share
            // the same lang tag (both "eng") when the target language is
            // English, so lang alone can no longer tell them apart.
            const rulerSubs = finalOutput.filter(sub => sub.isRuler).map(({ isRuler, ...rest }) => rest);
            const contentSubs = finalOutput.filter(sub => !sub.isRuler).slice(0, userConfig.maxSubs);
            finalOutput = [...rulerSubs, ...contentSubs];

            console.log(`\n👑 --- MASTER RULERS USED ---`);
            rulerSubs.forEach(r => console.log(`   ${r.title.replace('\n', ' | ')}`));

            console.log(`\n🏆 --- WINNERS (${outputLang.toUpperCase()}) ---`);
            contentSubs.forEach(sub => console.log(`   ${sub.title.replace('\n', ' | ')}`));

            console.log(`\n✅ [Done] ${finalOutput.length} total result(s) returned.`);
            
            if (userConfig.includeStats) {
                const engineMode = isTV ? 'TV Show/Series' : 'Movie';
                const serviceTag = streamingService ? ` [${streamingService}]` : '';
                const totalWinners = contentSubs.length;
                const totalRulers = rulerSubs.length;
                const statsText = `1\n00:00:01,000 --> 00:40:00,000\n{\\an7}<font color="#00ffcc"><b>[ 📊 BRLM Subs: Stats for Nerds ]</b></font>\n<font color="#cccccc"><b>Version:</b> ${CONFIG.ADDON_VERSION}\n<b>Engine:</b> ${engineMode}\n<b>Stream Type:</b> ${detectedType}${serviceTag}\n<b>File Name:</b> ${streamName || 'Unknown'}\n<b>Result:</b> ${totalWinners} ${outputLang === 'ara' ? 'Arabic' : 'English'} Syncs | ${totalRulers} Master Rulers</font>`;
                const statsCacheId = `stats_nerds_${Date.now()}.srt`;
                subtitleCache.set(statsCacheId, statsText);
                finalOutput.unshift({ id: statsCacheId, url: `${HOST}/dl/${statsCacheId}`, lang: "eng", title: `📊 Stats for Nerds (Debug Info)` });
            }

            // 🔥 Only save to cache if we actually found real winners.
            if (contentSubs.length > 0) {
                responseCache.set(requestCacheKey, { timestamp: Date.now(), subtitles: finalOutput });
            } else {
                console.log(`⚠️ Zero winners generated. Skipping cache to allow immediate retries.`);
            }
            
            return { subtitles: finalOutput };
        }

        // 🔥 Nothing to return — explain WHY, on-screen, in the first seconds.
        {
            const diag = buildNoResultsDiagnostic(diagPool, detectedType, streamTypeGroup, userConfig, isTV);
            console.log(`\n[Done] No subtitles found. ${diag.reason} ${diag.suggestion}`);
            const diagId = `diag_noresults_${Date.now()}.srt`;
            subtitleCache.set(diagId, diag.text);
            return { subtitles: [{
                id: diagId,
                url: `${HOST}/dl/${diagId}`,
                lang: outputLang,
                title: `⚠️ No Results — Tap for Reason & Fix`
            }] };
        }

   } catch (error) {
        console.error("❌ Fatal:", error.message);
        return { subtitles: [] };
    }
} // <--- The engine is now cleanly sealed with this bracket

// 🔥 RELIABILITY #5 (continued): thin wrapper applied at BOTH places
// runSubtitleEngine gets called (the live request handler below, and the
// background autoFetchNext pre-cacher) — so a live request and a
// background pre-cache for the exact same user+episode that happen to
// overlap in time share one execution instead of duplicating the entire
// fetch-and-sync pipeline. Falls through unchanged if nothing is in flight.
async function runSubtitleEngineCoalesced(args) {
    const coalesceKey = `${(args.config?.username || 'anon').toLowerCase()}:${args.id}`;
    if (inFlightRequests.has(coalesceKey)) {
        console.log(`\n⏳ [Coalesced] Joining in-flight request for ${args.id} instead of duplicating work.`);
        return inFlightRequests.get(coalesceKey);
    }
    const enginePromise = runSubtitleEngine(args);
    inFlightRequests.set(coalesceKey, enginePromise);
    try {
        return await enginePromise;
    } finally {
        inFlightRequests.delete(coalesceKey);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TRAFFIC COP (Main Handler & Smart Background Pre-Cacher)
// ─────────────────────────────────────────────────────────────────────────────
builder.defineSubtitlesHandler(async (args) => {
    // 1. Await the actual request so the user gets their subtitles instantly
    const result = await runSubtitleEngineCoalesced(args);

    // 2. Smart Fire-and-Forget Pre-fetcher!
    let autoFetchNext = true; // Default to ON
    if (args.config?.username) {
        try {
            const userRow = db.prepare('SELECT autoFetchNext FROM users WHERE LOWER(username) = LOWER(?)').get(args.config.username);
            if (userRow && userRow.autoFetchNext === 0) autoFetchNext = false;
        } catch (e) {}
    }

    if (autoFetchNext && args.type === 'series' && args.id) {
        // Run completely in the background so we don't block the user's video from loading
        (async () => {
            const parts = args.id.split(':');
            if (parts.length === 3) {
                const imdbId = parts[0];
                const currentSeason = parseInt(parts[1]);
                const currentEpisode = parseInt(parts[2]);

                let nextId = `${imdbId}:${currentSeason}:${currentEpisode + 1}`; // Fallback

                try {
                    // Query Stremio's native Cinemeta API to read the season map
                    const metaRes = await fetch(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`);
                    const metaData = await metaRes.json();
                    
                    if (metaData?.meta?.videos) {
                        const videos = metaData.meta.videos;
                        const nextInSeason = videos.find(v => v.season === currentSeason && v.episode === currentEpisode + 1);
                        const nextSeasonFirst = videos.find(v => v.season === currentSeason + 1 && v.episode === 1);
                        
                        if (nextInSeason) {
                            nextId = `${imdbId}:${currentSeason}:${currentEpisode + 1}`;
                        } else if (nextSeasonFirst) {
                            nextId = `${imdbId}:${currentSeason + 1}:1`;
                            console.log(`\n📺 [Season Finale Detected] Jumping to Season ${currentSeason + 1}`);
                        } else {
                            console.log(`\n🛑 [Series Finale] No more episodes to pre-cache.`);
                            return; // End of the line, stop wasting APIs!
                        }
                    }
                } catch (e) {
                    // If Cinemeta is down, just use the fallback +1 logic
                }

                const nextEpArgs = JSON.parse(JSON.stringify(args)); 
                nextEpArgs.id = nextId;
                
                // 🔥 CRITICAL: Only delete the videoHash. Keep filename for strict WEB-DL/REMUX matching.
               if (nextEpArgs.extra) {
    delete nextEpArgs.extra.videoHash;

    // Sanitize the filename: wipe the episode tag (S01E01) so the
    // tokeniser can't match wrong-episode release names, but keep
    // everything else (WEB-DL, REMUX, codec, etc.) for strict type matching.
    const nameFields = ['filename', 'title', 'name'];
    for (const field of nameFields) {
        if (nextEpArgs.extra[field]) {
            nextEpArgs.extra[field] = nextEpArgs.extra[field]
                .replace(/S\d{1,2}E\d{1,2}/gi, 'S??E??');
        }
    }
}

                console.log(`\n⏳ [Pre-Cache Daemon] Queuing background sync for next episode: ${nextEpArgs.id}...`);
                await runSubtitleEngineCoalesced(nextEpArgs);
            }
        })().catch(err => {
            console.log(`[Pre-Cache] Background task aborted silently.`);
        });
    }

    return result;
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS SERVER & DASHBOARD API
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json()); 

// 🛠️ API: Expose Config to Standalone Frontend
app.get('/api/config', (req, res) => {
    res.json({ name: CONFIG.ADDON_NAME, version: CONFIG.ADDON_VERSION });
});

app.post('/api/register', (req, res) => {
    try {
        const { username, password, confirmPassword } = req.body;
        
        // Standard Username Rule: 3-20 chars, letters, numbers, hyphens, and underscores ONLY. No spaces.
        const userRegex = /^[a-zA-Z0-9_-]{3,20}$/;
        if (!username || !userRegex.test(username)) return res.status(400).json({ error: "Username must be 3-20 characters (letters, numbers, _ , - only)." });
        
        // Standard Password Rule: Min 4 chars, strictly NO spaces.
        if (!password || password.length < 4 || /\s/.test(password)) return res.status(400).json({ error: "Password must be at least 4 characters with NO spaces." });
        
        if (password !== confirmPassword) return res.status(400).json({ error: "Passwords do not match." });
        
        const existing = db.prepare('SELECT username FROM users WHERE LOWER(username) = LOWER(?)').get(username);
        if (existing) return res.status(400).json({ error: "Username already exists." });

        db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username.trim(), password);
        res.json({ success: true, message: "Account created! Please log in." });
    } catch (e) {
        console.error("Register Error:", e.message);
        res.status(500).json({ error: "Server failed to create account." });
    }
});

app.post('/api/login', (req, res) => {
    try {
        const { username, password } = req.body;
        const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?) AND password = ?').get(username, password);
        
        if (!user) return res.status(401).json({ error: "Invalid Username or Password." });
        res.json({ success: true, user });
    } catch (e) {
        console.error("Login Error:", e.message);
        res.status(500).json({ error: "Server failed to process login." });
    }
});

app.post('/api/update', (req, res) => {
    const { 
        username, password, osKey, subdlKey, subsourceKey, targetLang, panelLang, stripTags, includeStats, removeSdh, maxSubs, engineStrength,
        useOs, useSubdl, useSubsource, allowRouteA, allowRouteB, allowRouteC, strict4k, autoFetchNext, matchCut, matchCutDirector, matchCutTheatrical, matchCutExtended
    } = req.body;
    
    const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?) AND password = ?').get(username, password);
    if (!user) return res.status(401).json({ error: "Authentication failed." });
    
    try {
        db.prepare(`
            UPDATE users 
            SET osKey = ?, subdlKey = ?, subsourceKey = ?, targetLang = ?, panelLang = ?, stripTags = ?, includeStats = ?, removeSdh = ?, maxSubs = ?, engineStrength = ?,
                useOs = ?, useSubdl = ?, useSubsource = ?, allowRouteA = ?, allowRouteB = ?, allowRouteC = ?, strict4k = ?, autoFetchNext = ?, matchCut = ?,
                matchCutDirector = ?, matchCutTheatrical = ?, matchCutExtended = ?
            WHERE LOWER(username) = LOWER(?)
        `).run(
            osKey.trim(), subdlKey ? subdlKey.trim() : "", subsourceKey ? subsourceKey.trim() : "", targetLang || "ar", panelLang || "en", stripTags ? 1 : 0, includeStats ? 1 : 0, removeSdh ? 1 : 0, parseInt(maxSubs), parseInt(engineStrength),
            useOs ? 1 : 0, useSubdl ? 1 : 0, useSubsource ? 1 : 0, allowRouteA ? 1 : 0, allowRouteB ? 1 : 0, allowRouteC ? 1 : 0, strict4k ? 1 : 0, autoFetchNext ? 1 : 0, matchCut ? 1 : 0,
            matchCutDirector ? 1 : 0, matchCutTheatrical ? 1 : 0, matchCutExtended ? 1 : 0,
            username
        );
        
        const configStr = encodeURIComponent(JSON.stringify({ username: username }));
        const installLink = `stremio://${HOST.replace(/^https?:\/\//, '')}/${configStr}/manifest.json`;
        res.json({ success: true, message: "Settings saved!", installLink });
    } catch (e) {
        res.status(500).json({ error: "Failed to update settings." });
    }
});

app.get('/api/provider-status', (req, res) => {
    const username = (req.query.username || '').toLowerCase();
    if (!username) return res.status(400).json({ error: 'Missing username' });
    const providers = ['openSubtitles', 'subdl', 'subsource'];
    const result = {};
    for (const p of providers) {
        const entry = providerStatus.get(`${username}:${p}`);
        result[p] = entry ? entry.status : 'unknown';
    }
    res.json(result);
});

// 🔥 RESET TO DEFAULTS — restores every tuning option to
// CONFIG.DEFAULT_SETTINGS. Built dynamically from that object, so adding or
// changing a default there is all that's ever needed. API keys and the
// panel language are intentionally preserved: a user resetting because
// "nothing works" should not also lose the keys they pasted in.
app.post('/api/reset', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?) AND password = ?').get(username, password);
    if (!user) return res.status(401).json({ error: "Authentication failed." });

    try {
        const keys = Object.keys(CONFIG.DEFAULT_SETTINGS);
        const setClause = keys.map(k => `${k} = ?`).join(', ');
        const values = keys.map(k => CONFIG.DEFAULT_SETTINGS[k]);
        db.prepare(`UPDATE users SET ${setClause} WHERE LOWER(username) = LOWER(?)`).run(...values, username);

        const updated = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);
        res.json({ success: true, message: "Settings restored to defaults!", user: updated });
    } catch (e) {
        console.error("Reset Error:", e.message);
        res.status(500).json({ error: "Failed to reset settings." });
    }
});

app.get('/dl/:cacheId', (req, res) => {
    const subText = subtitleCache.get(req.params.cacheId);
    if (subText) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.send(subText); } 
    else { res.status(404).send('Subtitle expired or not found.'); }
});
app.get('/', (req, res) => {
    try {
        // Read the external webpage.html file
        let html = fs.readFileSync(path.join(__dirname, 'webpage.html'), 'utf8');
        
        // Dynamically inject backend variables into the HTML string
        html = html.replace(/__ADDON_NAME__/g, CONFIG.ADDON_NAME)
                   .replace(/__ADDON_VERSION__/g, CONFIG.ADDON_VERSION)
                   .replace(/__HOST__/g, HOST);
                   
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (err) {
        console.error("Dashboard Load Error:", err.message);
        res.status(500).send("Error loading dashboard interface.");
    }
});
const router = getRouter(builder.getInterface());
app.get('/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.send(manifest);
});

app.use(router);

app.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(`🚀 ${CONFIG.ADDON_NAME} V${CONFIG.ADDON_VERSION} is LIVE`);
    console.log(`🌍 Public HOST: ${HOST}`);
    console.log(`=========================================\n`);
});
