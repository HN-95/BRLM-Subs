const express = require('express');
const cors = require('cors');
const iconv = require('iconv-lite');
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const parser = require("srt-parser-2").default;
const srtParser = new parser();
const AdmZip = require("adm-zip");

// ═════════════════════════════════════════════════════════════════════════════
// ⚙️ THE MASTER CONFIGURATION HUB
// Change these variables to tune the entire engine.
// ═════════════════════════════════════════════════════════════════════════════
const CONFIG = {
    // ─── BRANDING & IDENTITY ──────────────────────────────────────────────────
    ADDON_NAME: "BRLM Subs", // Changes Stremio Manifest, Watermarks, and Web UI
    ADDON_VERSION: "1.0.6",

    // ─── API KEYS ─────────────────────────────────────────────────────────────
    SUBDL_API_KEY: "eOg4zBUtULlU4bnZNw8TxPuIeJabAnxp",
    SUBSOURCE_KEY: "sk_5e25899dbf3a10bd8581778b2fa65698a50d27bec099309d24a185a29ea2bceb",
    ADDIC7ED_COOKIE: process.env.ADDIC7ED_COOKIE || "", // Optional Cloudflare bypass

    // ─── SEARCH & FETCH LIMITS ────────────────────────────────────────────────
    ARABIC_CANDIDATE_LIMIT: 10,        // Max Arabic subtitles to fetch per provider
    MOVIE_BASELINE_LIMIT: 3,           // Max English baselines to check per provider (Movies)
    TV_BASELINE_FETCH_POOL: 60,        // How deep to dig into OS to find distinct TV cuts
    TV_DISTINCT_CUTS_LIMIT: 3,         // How many distinct TV baselines to lock and test against

    // ─── MATH ENGINE TUNING ───────────────────────────────────────────────────
    MATH_CHUNKS: 5,                    // Test Points: Number of segments to split the movie into for drift calculation
    MIN_ACCEPTABLE_DELAY_MS: 50,       // Any delay smaller than this will NOT trigger an auto-shift
    DISTINCT_CUT_THRESHOLD_SEC: 0.5,   // Minimum seconds of difference needed to treat a TV baseline as a "New Cut"
    MIN_PASSING_ALIGNMENT_PCT: 40,     // If a subtitle scores below this %, it is immediately trashed

    // ─── DRIFT PENALTIES (If drift > X ms, subtract Y %) ──────────────────────
    PENALTY_SEVERE_MS: 2500,   PENALTY_SEVERE_PCT: 40,
    PENALTY_MODERATE_MS: 1200, PENALTY_MODERATE_PCT: 20,
    PENALTY_LIGHT_MS: 750,     PENALTY_LIGHT_PCT: 10,

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
    ARABIC_CANDIDATE_LIMIT: 10,        // Max Arabic subtitles to fetch per provider
};
// ═════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 7000;
const HOST = (process.env.HOST || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const subtitleCache = new Map();
let isApiLimitReached = false;

// 🔥 NEW: Caches the final calculated subtitle list for 2 hours to prevent API burn
const responseCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 2;
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
            key: "userOsKey",
            type: "text",
            title: "OpenSubtitles API Key (Required)",
            description: "You MUST enter your own OpenSubtitles API Key for this addon to work."
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
    '2160p','1080p','720p','480p',
    'hevc','x265','x264','h265','h264','av1',
    'hdr','dv','dolby','atmos',
    'dts','aac','dd5','ac3'
];

function tokeniseRelease(name) {
    if (!name) return new Set();
   const lower = name.toLowerCase().replace(/[._\s]+/g, ' ');
    const found = new Set();
    for (const token of RELEASE_TOKENS) {
        if (new RegExp(`(?<![a-z])${token.replace('-', '-?')}(?![a-z])`, 'i').test(lower)) {
            found.add(token.replace('-', ''));
        }
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
    if (tokens.has('webdl') || tokens.has('webrip') || tokens.has('web')) return 'WEB';
    // 🔥 Added bdremux check here
    if (tokens.has('bluray') || tokens.has('remux') || tokens.has('bdrip') || tokens.has('brrip') || tokens.has('bdremux')) return 'BLURAY';
    if (tokens.has('hdtv') || tokens.has('hdrip')) return 'HDTV';
    if (tokens.has('dvdrip') || tokens.has('dvdscr') || tokens.has('dvd')) return 'DVD';
    if (tokens.has('cam') || tokens.has('ts')) return 'CAM';
    return null;
}

function filterBaselinesByType(candidates, streamTypeGroup) {
    // Skip if config is off, or if we couldn't detect the stream type
    if (!CONFIG.STRICT_TYPE_MATCHING || !streamTypeGroup) return candidates;
    
    return candidates.filter(c => {
        const cTokens = tokeniseRelease(c.releaseName);
        const cGroup = getReleaseTypeGroup(cTokens);
        
        // Strict enforce: Only keep baselines that match the exact group
        // Note: If cGroup is null (e.g., filename is just "The.Boys.S1E2.srt"), we discard it 
        // to ensure 100% accuracy, as requested.
        return cGroup === streamTypeGroup;
    });
}
function decodeArabicFile(buffer) {
    const utf8 = buffer.toString('utf8');
    
    // 🔥 Uses exact hex code so it never gets erased: Counts broken symbols
    const brokenCharCount = (utf8.match(/\uFFFD/g) || []).length;
    
    // Only drop to win1256 if the file is completely unreadable in UTF-8
    if (brokenCharCount > 30) {
        return iconv.decode(buffer, 'win1256');
    }
    
    // If UTF-8 produced no Arabic text at all, test win1256 just in case
    if (!/[\u0600-\u06FF]/.test(utf8)) {
        const win1256 = iconv.decode(buffer, 'win1256');
        if (/[\u0600-\u06FF]/.test(win1256)) return win1256;
    }
    
    // Otherwise, trust the UTF-8 decode
    return utf8;
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
async function searchOS(url, apiKey) {
    try {
        const res = await fetchWithTimeout(url, { headers: { 'Api-Key': apiKey, 'User-Agent': 'StremioArabicElite' } });
        if (res.status === 429 || res.status === 403 || res.status === 401) isApiLimitReached = true;
        if (!res.ok) return { data: [] };
        return await res.json();
    } catch { return { data: [] }; }
}

async function getOsSrt(fileId, apiKey) {
    try {
        const req = await fetchWithTimeout('https://api.opensubtitles.com/api/v1/download', {
            method: 'POST',
            timeout: CONFIG.SRT_FETCH_TIMEOUT_MS,
            headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'StremioArabicElite', 'Accept': 'application/json' },
            body: JSON.stringify({ file_id: parseInt(fileId) })
        });
        if (req.status === 429 || req.status === 403 || req.status === 401) isApiLimitReached = true;
        if (!req.ok) return null;
        const data = await req.json();
        if (!data.link) return null;
        
        const textReq = await fetchWithTimeout(data.link, { timeout: CONFIG.SRT_FETCH_TIMEOUT_MS });
        const buffer = await textReq.arrayBuffer();
        return { text: decodeArabicFile(Buffer.from(buffer)) };
    } catch { return null; }
}
async function fetchOsCandidates({ lang, imdbId, season, episode, videoHash, releaseTokens, limit = 10, apiKey }) {
    let results = [];
    if (videoHash) {
        const url = `https://api.opensubtitles.com/api/v1/subtitles?languages=${lang}&moviehash=${videoHash}`;
        const hashData = await searchOS(url, apiKey);
        if (hashData.data?.length) {
            results.push(...hashData.data.map(s => ({
                fileId: s.attributes.files[0].file_id,
                releaseName: s.attributes.release || 'OS Hash Match',
                source: 'OpenSubtitles',
                score: 2
            })));
        }
    }

    let poolUrl = `https://api.opensubtitles.com/api/v1/subtitles?languages=${lang}&imdb_id=${imdbId}&order_by=download_count&order_direction=desc`;
    if (season && episode) poolUrl += `&season_number=${season}&episode_number=${episode}`;
    const poolData = await searchOS(poolUrl, apiKey);

    if (poolData.data?.length) {
        const poolEntries = poolData.data.map(s => ({
            fileId: s.attributes.files[0].file_id,
            releaseName: s.attributes.release || 'OS Search Match',
            source: 'OpenSubtitles',
            score: releaseTokens.size ? releaseScore(releaseTokens, tokeniseRelease(s.attributes.release || '')) : 0
        }));
        results.push(...poolEntries);
    }

    results.sort((a, b) => b.score - a.score);
    const seen = new Set();
    return results.filter(r => {
        if (seen.has(r.fileId)) return false;
        seen.add(r.fileId);
        return true;
    }).slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 2: SUBDL
// ─────────────────────────────────────────────────────────────────────────────
async function fetchSubdlCandidates({ imdbId, lang, season, episode, releaseTokens, limit = 10 }) {
    try {
        let url = `https://api.subdl.com/api/v1/subtitles?api_key=${CONFIG.SUBDL_API_KEY}&imdb_id=tt${imdbId}&languages=${lang.toLowerCase()}`;
        url += season && episode ? `&type=tv&season_number=${season}&episode_number=${episode}` : `&type=movie`;
        
        const res = await fetchWithTimeout(url);
        if (!res.ok) return [];
        const data = await res.json();
        if (!data.subtitles?.length) return [];
        
        const scored = data.subtitles.map(sub => ({
            id: sub.url,
            releaseName: sub.release_name || 'SubDL Match',
            downloadUrl: "https://dl.subdl.com" + (sub.url.startsWith('/') ? sub.url : '/' + sub.url),
            source: 'SubDL',
            score: releaseTokens.size ? releaseScore(releaseTokens, tokeniseRelease(sub.release_name || '')) : 0
        }));
        
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit);
    } catch { return []; }
}

async function getZipSrt(zipUrl) {
    try {
        const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
        const res = await fetchWithTimeout(zipUrl, { headers, timeout: CONFIG.SRT_FETCH_TIMEOUT_MS });
        if (!res.ok) return null;
        
        const buffer = await res.arrayBuffer();
        const textPreview = Buffer.from(buffer).toString('utf8', 0, 100);
        if (textPreview.includes('<html') || textPreview.includes('<!DOCTYPE')) return null;
        
        const zip = new AdmZip(Buffer.from(buffer));
        const srtEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.srt'));
        if (!srtEntry) return null;
        
        return { text: decodeArabicFile(srtEntry.getData()) };
    } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 3: SUBSOURCE
// ─────────────────────────────────────────────────────────────────────────────
async function fetchSubsourceCandidates({ imdbId, langCode, season, episode, releaseTokens, limit = 10 }) {
    try {
        const searchUrl = `https://api.subsource.net/api/v1/movies/search?searchType=imdb&imdb=tt${imdbId}`;
        const sRes = await fetchWithTimeout(searchUrl, { headers: { 'X-API-Key': CONFIG.SUBSOURCE_KEY } });
        if (!sRes.ok) return [];
        
        const sData = await sRes.json();
        const movie = sData.data?.[0];
        if (!movie) return [];

        const targetLang = langCode.toLowerCase() === 'ar' ? 'arabic' : 'english';
        let url = `https://api.subsource.net/api/v1/subtitles?movieId=${movie.movieId}&language=${targetLang}`;
        if (season && episode) url += `&season=${season}&episode=${episode}`;

        const res = await fetchWithTimeout(url, { headers: { 'X-API-Key': CONFIG.SUBSOURCE_KEY } });
        if (!res.ok) return [];
        
        const data = await res.json();
        let subs = Array.isArray(data) ? data : (data.data || data.items || data.subtitles || []);
        
        subs = subs.filter(s => s.language?.toLowerCase() === targetLang);

        const scored = subs.map(sub => ({
            id: sub.subtitleId,
            releaseName: (sub.releaseInfo && sub.releaseInfo[0]) || 'SubSource Match',
            downloadUrl: `https://api.subsource.net/api/v1/subtitles/${sub.subtitleId}/download`,
            source: 'SubSource',
            score: releaseTokens.size ? releaseScore(releaseTokens, tokeniseRelease((sub.releaseInfo && sub.releaseInfo[0]) || '')) : 0
        }));

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit);
    } catch { return []; }
}

async function getSubsourceSrt(zipUrl) {
    try {
        const res = await fetchWithTimeout(zipUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'X-API-Key': CONFIG.SUBSOURCE_KEY }, timeout: CONFIG.SRT_FETCH_TIMEOUT_MS });
        if (!res.ok) return null;
        const buffer = await res.arrayBuffer();
        const preview = Buffer.from(buffer).toString('utf8', 0, 50);
        if (preview.trim().startsWith('{') || preview.trim().startsWith('<')) return null;
        if (preview.includes('1\n') || preview.includes('1\r') || preview.includes('-->')) {
            return { text: decodeArabicFile(Buffer.from(buffer)) };
        }
        const zip = new AdmZip(Buffer.from(buffer));
        const srtEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.srt'));
        if (!srtEntry) return null;
        return { text: decodeArabicFile(srtEntry.getData()) };
    } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// MATH ENGINE (SDH DE-NOISER, SCALING, & DISTINCT CUT CHECKER)
// ─────────────────────────────────────────────────────────────────────────────
function stripSdhAndClean(parsedArray) {
    let cleanArray = [];
    for (const line of parsedArray) {
        let cleanText = line.text.replace(/<[^>]+>/g, '');
        cleanText = cleanText.replace(/\[.*?\]/g, '');
        cleanText = cleanText.replace(/\(.*?\)/g, '');
        if (cleanText.trim().length > 0) cleanArray.push(line);
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

function computePrecisionShift(englishText, arabicText, label = '', sourceName = 'Unknown', mediaType = 'Unknown', releaseName = 'Unknown', isTV = false) {
    if (!englishText || !arabicText) return { passed: false, alignmentPct: 0 };
    
    let originalArParsed, engParsedClean, arParsedClean;
    try {
        const rawEng = srtParser.fromSrt(englishText);
        originalArParsed = srtParser.fromSrt(arabicText); 
        engParsedClean = stripSdhAndClean(rawEng);
        arParsedClean  = stripSdhAndClean(originalArParsed);
    } catch { return { passed: false, alignmentPct: 0 }; }

    if (engParsedClean.length < 50 || arParsedClean.length < 50) return { passed: false, alignmentPct: 0 };

    const engIndex   = buildEngIndex(engParsedClean);
    const durationMs = engParsedClean[engParsedClean.length - 1].startSeconds * 1000;
    const chunkSizeMs = durationMs / CONFIG.MATH_CHUNKS; // Linked to CONFIG
    
    // Create chunk arrays dynamically based on CONFIG
    const chunks = Array.from({ length: CONFIG.MATH_CHUNKS }, () => []);

    arParsedClean.forEach(line => {
        const arMs  = line.startSeconds * 1000;
        const engMs = nearestValue(engIndex, arMs);
        const delta = arMs - engMs;
        let ci = Math.floor(arMs / chunkSizeMs);
        if (ci >= CONFIG.MATH_CHUNKS) ci = CONFIG.MATH_CHUNKS - 1;
        chunks[ci].push(delta);
    });

    const chunkOffsets = chunks.map(deltas => deltas.length > 15 ? median(deltas) : null).filter(val => val !== null);
    if (chunkOffsets.length < 3) return { passed: false, alignmentPct: 0 };

    const driftMs      = Math.abs(Math.max(...chunkOffsets) - Math.min(...chunkOffsets));
    const allDeltas    = chunks.flat();
    const globalMedian = median(allDeltas);
    const consensusLines = allDeltas.filter(d => Math.abs(d - globalMedian) < 400).length;
    let alignmentPct = (consensusLines / arParsedClean.length) * 100;

    console.log(`    [Math] ${label} | Align: ${alignmentPct.toFixed(1)}% | Drift: ${driftMs.toFixed(0)}ms`);

    // Penalties linked to CONFIG
    if (driftMs > CONFIG.PENALTY_SEVERE_MS) alignmentPct -= CONFIG.PENALTY_SEVERE_PCT;
    else if (driftMs > CONFIG.PENALTY_MODERATE_MS) alignmentPct -= CONFIG.PENALTY_MODERATE_PCT;
    else if (driftMs > CONFIG.PENALTY_LIGHT_MS) alignmentPct -= CONFIG.PENALTY_LIGHT_PCT;
    
    if (alignmentPct < CONFIG.MIN_PASSING_ALIGNMENT_PCT) return { passed: false, alignmentPct };

    let finalParsed = originalArParsed;
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
        text: `{\\an8}<font color="#8A5A99"><b>[ ${CONFIG.ADDON_NAME} ] By HN95</b></font>\nType: ${mediaType}`
    });

    return { passed: true, fixedText: srtParser.toSrt(finalParsed), offsetMs: globalMedian, alignmentPct, driftMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// ENGLISH DIAGNOSTIC HELPER
// ─────────────────────────────────────────────────────────────────────────────
function processEnglishRuler(baselineObj, rulerName, detectedType) {
    if (!baselineObj || !baselineObj.text || !baselineObj.candidate) return null;
    try {
        let parsed = srtParser.fromSrt(baselineObj.text);
        parsed.unshift({
            id: "0",
            startTime: "00:00:01,000",
            endTime: "00:00:06,000",
            text: `{\\an8}<font color="#8A5A99"><b>[ ${CONFIG.ADDON_NAME} ]</b></font>\nSource: ${baselineObj.candidate.source} | Type: ${detectedType} | Accuracy: ${CONFIG.RATINGS.DIAGNOSTIC.label}\nMatch: 100% | Delay: 0ms\nFile: ${baselineObj.candidate.releaseName}`
        });
        
        const fixedText = srtParser.toSrt(parsed);
        const cacheId = `elite_eng_ruler_${rulerName.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}.srt`;
        subtitleCache.set(cacheId, fixedText);
        
        return {
            id: cacheId,
            url: `${HOST}/dl/${cacheId}`,
            lang: "eng", 
            title: `[👑 ${rulerName} Ruler]\n[${baselineObj.candidate.source}] ${baselineObj.candidate.releaseName}`
        };
    } catch(e) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
builder.defineSubtitlesHandler(async (args) => {
   try {
        // 🔥 Extract User's API Key strictly. NO SHARED FALLBACK.
        const activeOsKey = args.config?.userOsKey && args.config.userOsKey.trim() !== "" ? args.config.userOsKey.trim() : null;

        // 🔥 KILL SWITCH: If they didn't provide a key, serve a warning subtitle instantly and abort.
        if (!activeOsKey) {
            console.log(`❌ Blocked request: User did not provide an API Key.`);
            const missingKeyCacheId = `nokey_${Date.now()}.srt`;
            const missingKeyText = `1\n00:00:01,000 --> 00:00:10,000\n{\\an8}<font color="#ff0000"><b>⚠️ الإضافة تفتقد مفتاح API. يرجى إعادة التثبيت وإدخال المفتاح الخاص بك.</b></font>`;
            subtitleCache.set(missingKeyCacheId, missingKeyText);
            return {
                subtitles: [{
                    id: missingKeyCacheId,
                    url: `${HOST}/dl/${missingKeyCacheId}`,
                    lang: "ara",
                    title: `⚠️ Missing API Key! Reinstall Addon.`
                }]
            };
        }
        
        // 🔥 Masked Key Debugger: Only shows last 3 digits in your logs
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

        let detectedType = 'Unknown';
        if (streamTypeGroup === 'WEB') detectedType = 'WEB-DL';
        else if (streamTypeGroup === 'BLURAY') detectedType = releaseTokens.has('remux') ? 'REMUX' : 'BLURAY';
        else if (streamTypeGroup === 'HDTV') detectedType = 'HDTV';
        else if (streamTypeGroup === 'DVD') detectedType = 'DVD';
        else if (streamTypeGroup === 'CAM') detectedType = 'CAM';

        // 🔥 NEW: Intercept the request if we've already done the math!
        const requestCacheKey = `${args.id}_${activeOsKey}_${detectedType}`;
        if (responseCache.has(requestCacheKey)) {
            const cachedResult = responseCache.get(requestCacheKey);
            if (Date.now() - cachedResult.timestamp < CACHE_TTL_MS) {
                console.log(`\n⚡ [CACHE HIT] Serving ${args.id} instantly! (Zero API credits used)`);
                return { subtitles: cachedResult.subtitles };
            } else {
                responseCache.delete(requestCacheKey); // Delete if expired
            }
        }

        console.log(`\n===========================================`);
        console.log(`[${CONFIG.ADDON_NAME}] API: ${maskedKey} | IMDb: ${imdbId} | S${season||'?'}E${episode||'?'} | Type: ${detectedType}`);

        let finalOutput = [];
        let bestFallback = null;

        // =====================================================================
        // PATH A: THE TV MULTI-CUT SWEEP
        // =====================================================================
        if (isTV) {
            console.log(`\n[TV Mode] Fetching OS Rulers + Arabic Candidates...`);
            let [engOs, arOs, arSubdl, arSubsource] = await Promise.all([
                // 🔥 Injected activeOsKey
                fetchOsCandidates({ lang: 'en', imdbId, season, episode, videoHash, releaseTokens, limit: CONFIG.TV_BASELINE_FETCH_POOL, apiKey: activeOsKey }), 
                fetchOsCandidates({ lang: 'ar', imdbId, season, episode, videoHash, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT, apiKey: activeOsKey }),
                fetchSubdlCandidates({ lang: 'ar', imdbId, season, episode, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT }),
                fetchSubsourceCandidates({ langCode: 'ar', imdbId, season, episode, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT })
            ]);

            // --- ADD THIS FILTERING BLOCK ---
            const originalCount = engOs.length;
            engOs = filterBaselinesByType(engOs, streamTypeGroup);
            console.log(`  🔍 Strict Type Matching: Retained ${engOs.length}/${originalCount} baselines matching type [${streamTypeGroup || 'Unknown'}]`);
            // --------------------------------

            let osRulers = [];
            let seenTextSnippets = new Set(); // The Clone Firewall

            for (const c of engOs) {
                // 🔥 Passed activeOsKey
                const srt = await getOsSrt(c.fileId, activeOsKey);
                if (srt) {
                    const textSnippet = srt.text.substring(0, 200).trim();
                    if (seenTextSnippets.has(textSnippet)) continue;
                    seenTextSnippets.add(textSnippet);

                    if (osRulers.length === 0) {
                        osRulers.push({ text: srt.text, candidate: c });
                        console.log(`  ✅ OS TV Ruler 1 locked [Score: ${c.score.toFixed(2)}]`);
                    } else {
                        let isDistinct = true;
                        for (const r of osRulers) {
                            if (!isDistinctCut(r.text, srt.text)) {
                                isDistinct = false;
                                break;
                            }
                        }
                        if (isDistinct) {
                            osRulers.push({ text: srt.text, candidate: c });
                            console.log(`  ✅ OS TV Ruler ${osRulers.length} locked (Distinct Cut) [Score: ${c.score.toFixed(2)}]`);
                            if (osRulers.length === CONFIG.TV_DISTINCT_CUTS_LIMIT) break; 
                        }
                    }
                }
            }

            if (osRulers.length === 0) {
                console.log(`❌ Could not lock any OS TV Rulers. Aborting sync.`);
                return { subtitles: [] };
            }

            const allCandidates = [
                // 🔥 Passed activeOsKey
                ...arOs.map(c => ({ ...c, fetchFn: () => getOsSrt(c.fileId, activeOsKey) })),
                ...arSubdl.map(c => ({ ...c, fetchFn: () => getZipSrt(c.downloadUrl) })),
                ...arSubsource.map(c => ({ ...c, fetchFn: () => getSubsourceSrt(c.downloadUrl) }))
            ];

            let tvRulerMatches = Array.from({ length: osRulers.length }, () => []);

            console.log(`\n[TV Mode] Initiating Battle Royale against ${osRulers.length} OS Cuts...`);
            for (let i = 0; i < allCandidates.length; i++) {
                const c = allCandidates[i];
                const arabicData = await c.fetchFn();
                if (!arabicData) continue;
                if (!bestFallback) bestFallback = { candidate: c, text: arabicData.text };

                for (let rIdx = 0; rIdx < osRulers.length; rIdx++) {
                    const ruler = osRulers[rIdx];
                    const result = computePrecisionShift(ruler.text, arabicData.text, `${c.source} vs OS Cut ${rIdx+1}`, c.source, detectedType, c.releaseName, true);
                    if (result.passed) {
                        tvRulerMatches[rIdx].push({ candidate: c, ...result });
                    }
                }
            }

            const sortFn = (a, b) => b.alignmentPct === a.alignmentPct ? (a.driftMs - b.driftMs) : (b.alignmentPct - a.alignmentPct);
            
            for (let rIdx = 0; rIdx < osRulers.length; rIdx++) {
                if (tvRulerMatches[rIdx].length > 0) {
                    tvRulerMatches[rIdx].sort(sortFn);
                    const champ = tvRulerMatches[rIdx][0];
                    const cacheId = `elite_tv_cut${rIdx+1}_${Date.now()}_${Math.floor(Math.random()*10000)}.srt`;
                    subtitleCache.set(cacheId, champ.fixedText);
                    
                    finalOutput.push({
                        id: cacheId,
                        url: `${HOST}/dl/${cacheId}`,
                        lang: "ara",
                        title: `[Synced to OS Cut ${rIdx+1} | ${champ.alignmentPct.toFixed(0)}%] (${champ.offsetMs>0?'+':''}${champ.offsetMs.toFixed(0)}ms)\n[${champ.candidate.source}] ${champ.candidate.releaseName}`
                    });
                    
                    // Diagnostic Ruler tied properly inside the block
                    const diagnosticRuler = processEnglishRuler(osRulers[rIdx], `OS Cut ${rIdx+1}`, detectedType);
                    if (diagnosticRuler) finalOutput.push(diagnosticRuler);
                }
            }
        } 
        
        // =====================================================================
        // PATH B: THE MOVIE CROSS-MATRIX
        // =====================================================================
        else {
            console.log(`\n[Movie Mode] Fetching 3 Master Rulers + Arabic Candidates...`);
            let [engOs, engSubdl, engSubsource, arOs, arSubdl, arSubsource] = await Promise.all([
                // 🔥 Injected activeOsKey
                fetchOsCandidates({ lang: 'en', imdbId, season, episode, videoHash, releaseTokens, limit: CONFIG.MOVIE_BASELINE_LIMIT, apiKey: activeOsKey }),
                fetchSubdlCandidates({ lang: 'en', imdbId, season, episode, releaseTokens, limit: CONFIG.MOVIE_BASELINE_LIMIT }),
                fetchSubsourceCandidates({ langCode: 'en', imdbId, season, episode, releaseTokens, limit: CONFIG.MOVIE_BASELINE_LIMIT }),
                fetchOsCandidates({ lang: 'ar', imdbId, season, episode, videoHash, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT, apiKey: activeOsKey }),
                fetchSubdlCandidates({ lang: 'ar', imdbId, season, episode, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT }),
                fetchSubsourceCandidates({ langCode: 'ar', imdbId, season, episode, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT })
            ]);

            // --- ADD THIS FILTERING BLOCK ---
            engOs = filterBaselinesByType(engOs, streamTypeGroup);
            engSubdl = filterBaselinesByType(engSubdl, streamTypeGroup);
            engSubsource = filterBaselinesByType(engSubsource, streamTypeGroup);
            // --------------------------------

            let osBaseline = null, subdlBaseline = null, subsourceBaseline = null;

            for (const c of engOs) {
                // 🔥 Passed activeOsKey
                osBaseline = await getOsSrt(c.fileId, activeOsKey);
                if (osBaseline) { osBaseline.candidate = c; console.log(`  ✅ OS Ruler locked`); break; }
            }
            for (const c of engSubdl) {
                subdlBaseline = await getZipSrt(c.downloadUrl);
                if (subdlBaseline) { subdlBaseline.candidate = c; console.log(`  ✅ SubDL Ruler locked`); break; }
            }
            for (const c of engSubsource) {
                subsourceBaseline = await getSubsourceSrt(c.downloadUrl);
                if (subsourceBaseline) { subsourceBaseline.candidate = c; console.log(`  ✅ SubSource Ruler locked`); break; }
            }

            if(!osBaseline && !subdlBaseline && !subsourceBaseline) {
                console.log(`❌ No Master Rulers could be locked. Aborting sync.`);
                return { subtitles: [] };
            }

            const allArabicCandidates = [
                // 🔥 Passed activeOsKey
                ...arOs.map(c => ({ ...c, fetchFn: () => getOsSrt(c.fileId, activeOsKey) })),
                ...arSubdl.map(c => ({ ...c, fetchFn: () => getZipSrt(c.downloadUrl) })),
                ...arSubsource.map(c => ({ ...c, fetchFn: () => getSubsourceSrt(c.downloadUrl) })),
            ];

            let rulerMatches = { 'OpenSubtitles': [], 'SubDL': [], 'SubSource': [] };

            console.log(`\n[Movie Mode] Initiating 3-Ruler Cross-Matrix Gauntlet...`);
            for (let i = 0; i < allArabicCandidates.length; i++) {
                const c = allArabicCandidates[i];
                const arabicData = await c.fetchFn();
                if (!arabicData) continue;
                if (!bestFallback) bestFallback = { candidate: c, text: arabicData.text };
                
                let bestMatrixScore = null;

                const testAgainstRuler = (baseline, rulerName) => {
                    if (!baseline) return;
                    const result = computePrecisionShift(baseline.text, arabicData.text, `${c.source} vs ${rulerName} Ruler`, c.source, detectedType, c.releaseName, false);
                    if (result.passed && (!bestMatrixScore || result.alignmentPct > bestMatrixScore.alignmentPct)) {
                        bestMatrixScore = { candidate: c, rulerName, ...result };
                    }
                };

                testAgainstRuler(osBaseline, 'OpenSubtitles');
                testAgainstRuler(subdlBaseline, 'SubDL');
                testAgainstRuler(subsourceBaseline, 'SubSource');

                if (bestMatrixScore) rulerMatches[bestMatrixScore.rulerName].push(bestMatrixScore);
            }

            const sortFn = (a, b) => b.alignmentPct === a.alignmentPct ? (a.driftMs - b.driftMs) : (b.alignmentPct - a.alignmentPct);
            for (const ruler of ['OpenSubtitles', 'SubDL', 'SubSource']) {
                if (rulerMatches[ruler].length > 0) {
                    rulerMatches[ruler].sort(sortFn);
                    const champ = rulerMatches[ruler][0];
                    const cacheId = `elite_${ruler.toLowerCase()}_${Date.now()}_${Math.floor(Math.random()*10000)}.srt`;
                    subtitleCache.set(cacheId, champ.fixedText);
                    finalOutput.push({
                        id: cacheId,
                        url: `${HOST}/dl/${cacheId}`,
                        lang: "ara",
                        title: `[Synced to ${ruler} Ruler | ${champ.alignmentPct.toFixed(0)}%] (${champ.offsetMs>0?'+':''}${champ.offsetMs.toFixed(0)}ms)\n[${champ.candidate.source}] ${champ.candidate.releaseName}`
                    });
                    
                    // Diagnostic Ruler tied properly inside the block
                    let baselineObj = null;
                    if (ruler === 'OpenSubtitles') baselineObj = osBaseline;
                    if (ruler === 'SubDL') baselineObj = subdlBaseline;
                    if (ruler === 'SubSource') baselineObj = subsourceBaseline;
                    
                    if (baselineObj) {
                        const diagnosticRuler = processEnglishRuler(baselineObj, ruler, detectedType);
                        if (diagnosticRuler) finalOutput.push(diagnosticRuler);
                    }
                }
            }
        }

// =====================================================================
        // FINAL DELIVERY & FALLBACK
        // =====================================================================
        finalOutput = finalOutput.filter(item => item !== null);

        // 🔥 Forces a warning subtitle into the player if the API is burned out
        if (typeof isApiLimitReached !== 'undefined' && isApiLimitReached) {
            const limitCacheId = `api_limit_${Date.now()}.srt`;
            const limitText = `1\n00:00:01,000 --> 00:00:10,000\n{\\an8}<font color="#ff0000"><b>⚠️ أنتهت صلاحية الرخصة, جددها يا حلو</b></font>`;
            subtitleCache.set(limitCacheId, limitText);
            finalOutput.unshift({
                id: limitCacheId,
                url: `${HOST}/dl/${limitCacheId}`,
                lang: "ara",
                title: `⚠️ API Key Expired!`
            });
        }

        if (finalOutput.length > 0) {
            console.log(`\n✅ [Done] ${finalOutput.length} total result(s) returned.`);
            // 🔥 NEW: Save the hard work to the cache before delivering
            responseCache.set(requestCacheKey, { timestamp: Date.now(), subtitles: finalOutput });
            return { subtitles: finalOutput };
        }

        if (bestFallback) {
            console.log(`⚠️ Math engine failed. Serving unverified fallback from ${bestFallback.candidate.source}.`);
            let fallbackParsed;
            try {
                fallbackParsed = srtParser.fromSrt(bestFallback.text);
                fallbackParsed.unshift({
                    id: "0",
                    startTime: "00:00:01,000",
                    endTime: "00:00:06,000",
                    text: `{\\an8}<font color="#8A5A99"><b>[ ${CONFIG.ADDON_NAME} ]</b></font>\nSource: ${bestFallback.candidate.source} | Type: ${detectedType} | Accuracy: ${CONFIG.RATINGS.UNVERIFIED.label}\nMatch: N/A | Delay: N/A\nFile: ${bestFallback.candidate.releaseName}`
                });
                bestFallback.text = srtParser.toSrt(fallbackParsed);
            } catch(e) {}

            const cacheId = `elite_fallback_${Date.now()}.srt`;
            subtitleCache.set(cacheId, bestFallback.text);
            
            const fallbackOutput = [{ id: cacheId, url: `${HOST}/dl/${cacheId}`, lang: "ara", title: `⚠️ Arabic (${CONFIG.RATINGS.UNVERIFIED.label})` }];
            // 🔥 NEW: Cache the fallback too, so we don't spam the APIs on a lost cause
            responseCache.set(requestCacheKey, { timestamp: Date.now(), subtitles: fallbackOutput });
            return { subtitles: fallbackOutput };
        }

        console.log(`\n[Done] No subtitles found.`);
        return { subtitles: [] };

    } catch (error) {
        console.error("❌ Fatal:", error.message);
        return { subtitles: [] };
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS SERVER
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());

app.get('/dl/:cacheId', (req, res) => {
    const subText = subtitleCache.get(req.params.cacheId);
    if (subText) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(subText);
    } else {
        res.status(404).send('Subtitle expired or not found.');
    }
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>${CONFIG.ADDON_NAME} | Setup</title>
        <style>
            body { background-color:#141414; color:#e5e5e5; font-family:'Segoe UI',sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; text-align:center; }
            .container { background-color:#202020; padding:40px; border-radius:12px; border:1px solid #333; max-width:500px; width: 90%; box-shadow:0 10px 30px rgba(0,0,0,.5); box-sizing: border-box; }
            h1 { color:#8A5A99; font-size:2.2rem; margin-top:0; margin-bottom: 5px; }
            p { color:#a0a0a0; font-size:1rem; margin-bottom:25px; }
            input { width: 100%; padding: 14px; margin-bottom: 15px; border-radius: 8px; border: 1px solid #444; background: #111; color: white; font-size: 1rem; box-sizing: border-box; outline: none; transition: 0.2s; }
            input:focus { border-color: #8A5A99; }
            .btn { background-color:#8A5A99; color:white; padding:15px; width:100%; border:none; border-radius:8px; font-size:1.1rem; font-weight:bold; cursor:pointer; text-decoration:none; display:block; margin-top:10px; box-sizing: border-box; transition: 0.2s; }
            .btn:hover { background-color:#6c4777; }
            .btn-secondary { background-color: #333; margin-top: 15px; }
            .btn-secondary:hover { background-color: #444; }
            .error { color: #ff4c4c; font-size: 0.9rem; display: none; margin-bottom: 15px; text-align: left; padding-left: 5px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>${CONFIG.ADDON_NAME}</h1>
            <p>V${CONFIG.ADDON_VERSION} | Configuration</p>
            
            <div style="text-align: left;">
                <input type="text" id="osKey" placeholder="Enter OpenSubtitles API Key (Required)">
                <div id="errorMsg" class="error">⚠️ You must enter your API key to continue.</div>
            </div>

            <a href="#" id="installBtn" class="btn">1. Install to Stremio</a>
            <button id="copyBtn" class="btn btn-secondary">2. Copy Manifest Link (For Nuvio)</button>
        </div>

        <script>
            const host = "${HOST}";
            const installBtn = document.getElementById('installBtn');
            const copyBtn = document.getElementById('copyBtn');
            const osKeyInput = document.getElementById('osKey');
            const errorMsg = document.getElementById('errorMsg');

            // Generates the dynamic URLs containing the user's API Key
        function getUrls() {
                const key = osKeyInput.value.trim();
                // 🔥 Bulletproof Stremio JSON format for third-party apps
                let configPath = '';
                if (key) {
                    const configObj = { userOsKey: key };
                    configPath = encodeURIComponent(JSON.stringify(configObj)) + '/';
                }
                const httpsUrl = host + '/' + configPath + 'manifest.json';
                const stremioUrl = httpsUrl.replace(/^https?:/, 'stremio:');
                return { httpsUrl, stremioUrl, key };
            }

            installBtn.addEventListener('click', (e) => {
                const urls = getUrls();
                if (!urls.key) {
                    e.preventDefault(); // Stop the click if empty
                    errorMsg.style.display = 'block';
                } else {
                    errorMsg.style.display = 'none';
                    installBtn.href = urls.stremioUrl; // Route to Stremio app
                }
            });

            copyBtn.addEventListener('click', () => {
                const urls = getUrls();
                if (!urls.key) {
                    errorMsg.style.display = 'block';
                    return;
                }
                errorMsg.style.display = 'none';
                
                // Copy the HTTPS manifest link directly to clipboard
                navigator.clipboard.writeText(urls.httpsUrl).then(() => {
                    const originalText = copyBtn.innerText;
                    copyBtn.innerText = '✅ Copied to Clipboard!';
                    copyBtn.style.backgroundColor = '#4caf50';
                    setTimeout(() => {
                        copyBtn.innerText = originalText;
                        copyBtn.style.backgroundColor = '#333';
                    }, 2000);
                });
            });

            // Hide error message when they start typing
            osKeyInput.addEventListener('input', () => {
                if (osKeyInput.value.trim() !== '') {
                    errorMsg.style.display = 'none';
                }
            });
        </script>
    </body>
    </html>
    `);
});

const router = getRouter(builder.getInterface());

// Force the manifest to be served with the correct headers for Nuvio
app.get('/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.send(manifest);
});

// Explicitly bind the router so it captures the config from the URL parameters
app.use(router);

app.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(`🚀 ${CONFIG.ADDON_NAME} V${CONFIG.ADDON_VERSION} is LIVE`);
    console.log(`🌍 Public HOST: ${HOST}`);
    console.log(`=========================================\n`);
});
