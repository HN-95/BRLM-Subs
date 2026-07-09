const express = require('express');
const cors = require('cors');
const iconv = require('iconv-lite');
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const parser = require("srt-parser-2").default;
const srtParser = new parser();
const AdmZip = require("adm-zip");
const { createExtractorFromData } = require('node-unrar-js');

// ═════════════════════════════════════════════════════════════════════════════
// ⚙️ THE MASTER CONFIGURATION HUB
// Change these variables to tune the entire engine.
// ═════════════════════════════════════════════════════════════════════════════
const CONFIG = {
    // ─── BRANDING & IDENTITY ──────────────────────────────────────────────────
    ADDON_NAME: "BRLM Subs", // Changes Stremio Manifest, Watermarks, and Web UI
    ADDON_VERSION: "1.2.0",

    // ─── API KEYS ─────────────────────────────────────────────────────────────
    SUBDL_API_KEY: "eOg4zBUtULlU4bnZNw8TxPuIeJabAnxp",
    SUBSOURCE_KEY: "sk_5e25899dbf3a10bd8581778b2fa65698a50d27bec099309d24a185a29ea2bceb",
    ADDIC7ED_COOKIE: process.env.ADDIC7ED_COOKIE || "", // Optional Cloudflare bypass

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
	CLONE_SAMPLE_SIZE: 400,            // Number of pure Arabic characters to sample for shift-invariant clone detection

};
// ═════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 7000;
const HOST = (process.env.HOST || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const subtitleCache = new Map();

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
        },
        {
            key: "stripTags",
            type: "boolean",
            title: "Remove Formatting Tags",
            description: "Check this if your TV shows raw code like {\\an8} or <i> on screen.",
            default: false
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

function getArabicSignature(srtText) {
    if (!srtText) return '';
    
    // 1. Strip all HTML/ASS tags and isolate raw lines
    const cleanLines = srtText.split('\n')
        .map(l => l.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim())
        .filter(l => l && !l.match(/^\d+$/) && !l.includes('-->'));
        
    // 2. Extract strictly Arabic characters from each line
    const arabicLines = cleanLines.map(l => {
        const match = l.match(/[\u0600-\u06FF]/g);
        return match ? match.join('') : '';
    }).filter(l => l.length > 15); // Ignore short generic words (yes, no, hi)
    
    // 3. Find the 15 longest sentences, sort alphabetically, and crush them together
    return arabicLines.sort((a, b) => b.length - a.length)
        .slice(0, 15)
        .sort()
        .join('');
}
function computePrecisionShift(englishText, arabicText, label = '', sourceName = 'Unknown', mediaType = 'Unknown', releaseName = 'Unknown', isTV = false) {
    if (!englishText || !arabicText) return { passed: false, alignmentPct: 0 };
    
    // 🔥 THE ULTIMATE CONTENT FIREWALL: The Ratio Check
    // Corrupted files bypass volume checks by repeating a fake Arabic letter on every line.
    // By comparing Arabic counts to Latin counts, we instantly catch French/English fakes.
    const arabicCharCount = (arabicText.match(/[\u0600-\u06FF]/g) || []).length;
    const latinCharCount = (arabicText.match(/[a-zA-Z]/g) || []).length;
    
    if (arabicCharCount < CONFIG.Min_Arabic_Letters || latinCharCount > arabicCharCount) {
        console.log(`    ❌ [Blocked] Fake/Corrupted File Detected (Ar: ${arabicCharCount} | Latin: ${latinCharCount}). Trashing.`);
        return { passed: false, alignmentPct: 0 };
    }

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
    if (!passed) return { passed: false, alignmentPct: 0 };

    const scaleLog = bestParsed !== originalArParsed ? ' [FPS Scaled ⚙️]' : '';
    console.log(`    [Math] ${label} | Align: ${alignmentPct.toFixed(1)}% | Drift: ${driftMs.toFixed(0)}ms${scaleLog}`);

    // Penalties linked to CONFIG
    if (driftMs > CONFIG.PENALTY_SEVERE_MS) alignmentPct -= CONFIG.PENALTY_SEVERE_PCT;
    else if (driftMs > CONFIG.PENALTY_MODERATE_MS) alignmentPct -= CONFIG.PENALTY_MODERATE_PCT;
    else if (driftMs > CONFIG.PENALTY_LIGHT_MS) alignmentPct -= CONFIG.PENALTY_LIGHT_PCT;
    
    if (alignmentPct < CONFIG.MIN_PASSING_ALIGNMENT_PCT) return { passed: false, alignmentPct };

    let finalParsed = bestParsed;
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
// ─────────────────────────────────────────────────────────────────────────────
// ENGLISH DIAGNOSTIC HELPER
// ─────────────────────────────────────────────────────────────────────────────
function processEnglishRuler(baselineObj, rulerName, detectedType, isTV = false, releaseTokens = new Set()) {
    if (!baselineObj || !baselineObj.text || !baselineObj.candidate) return null;
    try {
        let parsed = srtParser.fromSrt(baselineObj.text);
        let cleanParsed = [];

        // 🔥 Remove SDH (Tags and All-Caps Lines)
        for (let i = 0; i < parsed.length; i++) {
            let rawLines = parsed[i].text.split('\n');
            let cleanLines = [];
            
            for (let line of rawLines) {
                // Strip [Text] and (Text)
                let cleanL = line.replace(/\[.*?\]/gs, '').replace(/\(.*?\)/gs, '').trim();
                
                // If the line has letters and is entirely uppercase, it's an SDH label. Skip it.
                const hasLetters = /[a-zA-Z]/.test(cleanL);
                if (hasLetters && cleanL === cleanL.toUpperCase()) continue;
                
                if (cleanL.length > 0) cleanLines.push(cleanL);
            }
            
            if (cleanLines.length > 0) {
                cleanParsed.push({ ...parsed[i], text: cleanLines.join('\n') });
            }
        }

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

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENGINE (Detached for Background Tasks)
// ─────────────────────────────────────────────────────────────────────────────
async function runSubtitleEngine(args) {
   try {
        // 🔥 Extract User's API Key strictly. NO SHARED FALLBACK.
        const activeOsKey = args.config?.userOsKey && args.config.userOsKey.trim() !== "" ? args.config.userOsKey.trim() : null;
		// 🔥 NEW: Extract the user's formatting preference
        const stripTags = args.config?.stripTags === true || args.config?.stripTags === "true";

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
        const is4K          = releaseTokens.has('2160p') || releaseTokens.has('4k'); // 🔥 Track 4K state

        let detectedType = 'Unknown';
        const resTag = is4K ? ' 4K' : '';

        if (streamTypeGroup?.startsWith('WEBDL')) detectedType = 'WEB-DL' + resTag;
        else if (streamTypeGroup?.startsWith('WEBRIP')) detectedType = 'WEBRip' + resTag;
        else if (streamTypeGroup?.startsWith('BLURAY')) detectedType = (releaseTokens.has('remux') ? 'REMUX' : 'BLURAY') + resTag;
        else if (streamTypeGroup?.startsWith('HDTV')) detectedType = 'HDTV' + resTag;
        else if (streamTypeGroup?.startsWith('DVD')) detectedType = 'DVD' + resTag;
        else if (streamTypeGroup?.startsWith('CAM')) detectedType = 'CAM' + resTag; 

       // 🔥 NEW: Intercept the request if we've already done the math!
       const requestCacheKey = `${args.id}_${detectedType}_${activeOsKey}`;
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

        // =====================================================================
        // PATH A: THE TV MULTI-CUT SWEEP
        // =====================================================================
if (isTV) {
            console.log(`\n[TV Mode] Fetching OS Rulers + Arabic Candidates...`);
            let [engOs, engSubdl, engSubsource, arOs, arSubdl, arSubsource] = await Promise.all([
                fetchOsCandidates({ lang: 'en', imdbId, season, episode, videoHash, releaseTokens, limit: CONFIG.TV_BASELINE_FETCH_POOL, apiKey: activeOsKey }),
                fetchSubdlCandidates({ lang: 'en', imdbId, season, episode, releaseTokens, limit: 15 }),
                fetchSubsourceCandidates({ langCode: 'en', imdbId, season, episode, releaseTokens, limit: 15 }),
                fetchOsCandidates({ lang: 'ar', imdbId, season, episode, videoHash, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT, apiKey: activeOsKey }),
                fetchSubdlCandidates({ lang: 'ar', imdbId, season, episode, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT }),
                fetchSubsourceCandidates({ langCode: 'ar', imdbId, season, episode, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT })
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
                ...engSubsource.map(c => ({ ...c, fetchFn: () => getArchiveSrt(c.downloadUrl, season, episode, { 'X-API-Key': CONFIG.SUBSOURCE_KEY }) }))
            ];

            const originalCount = combinedEng.length;
        
            console.log(`  🔍 Strict Type Matching: Retained ${combinedEng.length}/${originalCount} TV baselines across all sources.`);

   let osRulers = []; 
            let seenTextSnippets = new Set(); 

            // 🔥 HELPER: Attempts to lock rulers for a specific group
            const tryLockTvRulers = async (targetGroup) => {
                const strictEng = filterBaselinesByType(combinedEng, targetGroup);
                for (const c of strictEng) {
                    if (osRulers.length >= CONFIG.TV_DISTINCT_CUTS_LIMIT) break;
                    const srt = await c.fetchFn();
                    if (srt) {
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
                const fallbackGroup = streamTypeGroup.replace('_4K', '');
                console.log(`⚠️ 4K Starvation: No 4K Rulers found. Falling back to 1080p baselines (${fallbackGroup})...`);
                await tryLockTvRulers(fallbackGroup);
                fallbackTriggered = true;
            }

if (osRulers.length === 0) {
                console.log(`⚠️ No TV Rulers locked. Skipping Route A.`);
            }

            const allCandidates = [
                ...arOs.map(c => ({ ...c, fetchFn: () => getOsSrt(c.fileId, activeOsKey) })),
                ...arSubdl.map(c => ({ ...c, fetchFn: () => getArchiveSrt(c.downloadUrl, season, episode) })),
                ...arSubsource.map(c => ({ ...c, fetchFn: () => getArchiveSrt(c.downloadUrl, season, episode, { 'X-API-Key': CONFIG.SUBSOURCE_KEY }) }))
            ];

            let allSurvivingTvArabic = [];

            console.log(`\n[TV Mode] Initiating Battle Royale against ${osRulers.length} OS Cuts...`);
            for (let i = 0; i < allCandidates.length; i++) {
                const c = allCandidates[i];
                const arabicData = await c.fetchFn();
                if (!arabicData) continue;
                c.fetchedText = arabicData.text; // 🔥 Cache for Route B & C
                if (!bestFallback) bestFallback = { candidate: c, text: arabicData.text };

                // 🔥 4K Blind Trust Protocol
                const cTokens = tokeniseRelease(c.releaseName);
                const cGroup = getReleaseTypeGroup(cTokens);
                if (fallbackTriggered && cGroup === streamTypeGroup) {
                    console.log(`  🚀 [Blind Trust] Pushing explicit 4K Arabic match: ${c.releaseName}`);
                    try {
                        let fallbackParsed = srtParser.fromSrt(arabicData.text);
                        fallbackParsed.unshift({ id: "0", startTime: "00:00:01,000", endTime: "00:00:06,000", text: `{\\an8}<font color="#8A5A99"><b>[ ${CONFIG.ADDON_NAME} ] By HN95</b></font>\nType: ${detectedType} (Blind Trust)` });
                        let blindText = srtParser.toSrt(fallbackParsed);
                        if (stripTags) blindText = blindText.replace(/\{[^}]+\}/g, '').replace(/<[^>]+>/g, '');
                        const cacheId = `elite_tv_ar_blind_${Date.now()}_${Math.floor(Math.random()*10000)}.srt`;
                        subtitleCache.set(cacheId, blindText);
                        finalOutput.push({ id: cacheId, url: `${HOST}/dl/${cacheId}`, lang: "ara", title: `[👑 4K Trust | Unverified] (0ms)\n[${c.source}] ${c.releaseName}` });
                    } catch(e) {}
                    continue; 
                }

                // ─── ROUTE A: The Math Gauntlet ───
                if (osRulers.length > 0) {
                    let bestScoreForCandidate = null;
                    for (let rIdx = 0; rIdx < osRulers.length; rIdx++) {
                        const ruler = osRulers[rIdx];
                        const result = computePrecisionShift(ruler.text, arabicData.text, `${c.source} vs OS Cut ${rIdx+1}`, c.source, detectedType, c.releaseName, true);
                        if (result.passed && (!bestScoreForCandidate || result.alignmentPct > bestScoreForCandidate.alignmentPct)) {
                            bestScoreForCandidate = { candidate: c, matchedRuler: `OS Cut ${rIdx+1}`, ...result };
                        }
                    }
                    if (bestScoreForCandidate) allSurvivingTvArabic.push(bestScoreForCandidate);
                }
            }

           // 2. ALWAYS push the Clean English Rulers unconditionally
            for (let rIdx = 0; rIdx < osRulers.length; rIdx++) {
                const cleanEnglish = processEnglishRuler(osRulers[rIdx], `OS Cut ${rIdx+1}`, detectedType, isTV, releaseTokens);
                if (cleanEnglish) finalOutput.push(cleanEnglish);
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
                    const candidateSig = getArabicSignature(candidate.fixedText);
                    const existingSig = getArabicSignature(existing.fixedText);
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
                    id: cacheId, url: `${HOST}/dl/${cacheId}`, lang: "ara",
                    title: `[Synced to ${candidate.matchedRuler} | ${candidate.alignmentPct.toFixed(0)}%] (${candidate.offsetMs>0?'+':''}${candidate.offsetMs.toFixed(0)}ms)\n[${candidate.candidate.source}] ${candidate.candidate.releaseName}`
                });
            }

            // ─── ROUTE B: The Top 2 Raw Token Matches ───
            console.log(`\n[TV Mode] Extracting Route B (Top 2 Raw Matches)...`);
            const routeBCandidates = allCandidates.filter(c => c.fetchedText).sort((a, b) => b.score - a.score);
            let routeBCount = 0;
            for (const c of routeBCandidates) {
                if (routeBCount >= 2) break;
                
                const arabicCharCount = (c.fetchedText.match(/[\u0600-\u06FF]/g) || []).length;
                const latinCharCount = (c.fetchedText.match(/[a-zA-Z]/g) || []).length;
                if (arabicCharCount < CONFIG.Min_Arabic_Letters || latinCharCount > arabicCharCount) continue;

                const cSig = getArabicSignature(c.fetchedText);
                const isAlreadyInRouteA = finalOutput.filter(o => o.lang === 'ara').some(existing => {
                    const existingSubText = subtitleCache.get(existing.id.split('/').pop() || existing.id) || "";
                    return existingSubText && getArabicSignature(existingSubText) === cSig;
                });

                if (isAlreadyInRouteA) continue;

                console.log(`  🚀 [Route B] Pushing top match: ${c.releaseName}`);
                try {
                    let routeBParsed = srtParser.fromSrt(c.fetchedText);
                    routeBParsed.unshift({ id: "0", startTime: "00:00:01,000", endTime: "00:00:06,000", text: `{\\an8}<font color="#8A5A99"><b>[ ${CONFIG.ADDON_NAME} ] By HN95</b></font>\nType: ${detectedType} (Route B)` });
                    let finalRouteBText = srtParser.toSrt(routeBParsed);
                    if (stripTags) finalRouteBText = finalRouteBText.replace(/\{[^}]+\}/g, '').replace(/<[^>]+>/g, '');
                    const cacheId = `elite_tv_ar_RouteB_${Date.now()}_${Math.floor(Math.random()*10000)}.srt`;
                    subtitleCache.set(cacheId, finalRouteBText);
                    finalOutput.push({ id: cacheId, url: `${HOST}/dl/${cacheId}`, lang: "ara", title: `[⚠️ Route B | Raw Top Match]\n[${c.source}] ${c.releaseName}` });
                    routeBCount++;
                } catch(e) {}
            }
        }
// =====================================================================
        // PATH B: THE MOVIE CROSS-MATRIX
        // =====================================================================
        else {
            console.log(`\n[Movie Mode] Fetching 3 Master Rulers + Arabic Candidates...`);
            let [engOs, engSubdl, engSubsource, arOs, arSubdl, arSubsource] = await Promise.all([
                fetchOsCandidates({ lang: 'en', imdbId, season, episode, videoHash, releaseTokens, limit: CONFIG.MOVIE_BASELINE_LIMIT, apiKey: activeOsKey }),
                fetchSubdlCandidates({ lang: 'en', imdbId, season, episode, releaseTokens, limit: CONFIG.MOVIE_BASELINE_LIMIT }),
                fetchSubsourceCandidates({ langCode: 'en', imdbId, season, episode, releaseTokens, limit: CONFIG.MOVIE_BASELINE_LIMIT }),
                
                fetchOsCandidates({ lang: 'ar', imdbId, season, episode, videoHash, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT, apiKey: activeOsKey }),
                fetchSubdlCandidates({ lang: 'ar', imdbId, season, episode, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT }),
                fetchSubsourceCandidates({ langCode: 'ar', imdbId, season, episode, releaseTokens, limit: CONFIG.ARABIC_CANDIDATE_LIMIT })
            ]);

           
let osBaseline = null, subdlBaseline = null, subsourceBaseline = null;

            // 🔥 HELPER: Attempts to lock rulers for a specific group
            const tryLockMovieRulers = async (targetGroup) => {
                const fOs = filterBaselinesByType(engOs, targetGroup);
                const fSubdl = filterBaselinesByType(engSubdl, targetGroup);
                const fSubsource = filterBaselinesByType(engSubsource, targetGroup);
                
                for (const c of fOs) {
                    if (osBaseline) break;
                    osBaseline = await getOsSrt(c.fileId, activeOsKey);
                    if (osBaseline) { osBaseline.candidate = c; console.log(`  ✅ OS Ruler locked [${targetGroup}]`); }
                }
                for (const c of fSubdl) {
                    if (subdlBaseline) break;
                    subdlBaseline = await getArchiveSrt(c.downloadUrl);
                    if (subdlBaseline) { subdlBaseline.candidate = c; console.log(`  ✅ SubDL Ruler locked [${targetGroup}]`); }
                }
                for (const c of fSubsource) {
                    if (subsourceBaseline) break;
                    subsourceBaseline = await getArchiveSrt(c.downloadUrl, null, null, { 'X-API-Key': CONFIG.SUBSOURCE_KEY });
                    if (subsourceBaseline) { subsourceBaseline.candidate = c; console.log(`  ✅ SubSource Ruler locked [${targetGroup}]`); }
                }
            };

            await tryLockMovieRulers(streamTypeGroup);

            // 🔥 THE 4K FALLBACK PROTOCOL
            let fallbackTriggered = false;
     const hasMovieRulers = osBaseline || subdlBaseline || subsourceBaseline;
            if (!hasMovieRulers) {
                console.log(`⚠️ No Movie Rulers locked. Skipping Route A.`);
            }

            const allArabicCandidates = [
                ...arOs.map((c, index) => ({ ...c, trackNum: index + 1, fetchFn: () => getOsSrt(c.fileId, activeOsKey) })),
                ...arSubdl.map((c, index) => ({ ...c, trackNum: index + 1, fetchFn: () => getArchiveSrt(c.downloadUrl) })),
                ...arSubsource.map((c, index) => ({ ...c, trackNum: index + 1, fetchFn: () => getArchiveSrt(c.downloadUrl, null, null, { 'X-API-Key': CONFIG.SUBSOURCE_KEY }) })),
            ];

            let allSurvivingArabic = [];
            let sourceCounters = { 'OpenSubtitles': 0, 'SubDL': 0, 'SubSource': 0 };

            console.log(`\n[Movie Mode] Initiating 3-Ruler Cross-Matrix Gauntlet...`);
            for (let i = 0; i < allArabicCandidates.length; i++) {
                const c = allArabicCandidates[i];
                const arabicData = await c.fetchFn();
                if (!arabicData) continue;
                c.fetchedText = arabicData.text; // 🔥 Cache for Route B & C
                if (!bestFallback) bestFallback = { candidate: c, text: arabicData.text };
                
                // 🔥 4K Blind Trust Protocol
                const cTokens = tokeniseRelease(c.releaseName);
                const cGroup = getReleaseTypeGroup(cTokens);
                if (fallbackTriggered && cGroup === streamTypeGroup) {
                    console.log(`  🚀 [Blind Trust] Pushing explicit 4K Arabic match: ${c.releaseName}`);
                    try {
                        let fallbackParsed = srtParser.fromSrt(arabicData.text);
                        fallbackParsed.unshift({ id: "0", startTime: "00:00:01,000", endTime: "00:00:06,000", text: `{\\an8}<font color="#8A5A99"><b>[ ${CONFIG.ADDON_NAME} ] By HN95</b></font>\nType: ${detectedType} (Blind Trust)` });
                        let blindText = srtParser.toSrt(fallbackParsed);
                        if (stripTags) blindText = blindText.replace(/\{[^}]+\}/g, '').replace(/<[^>]+>/g, '');
                        const cacheId = `elite_ar_blind_${Date.now()}_${Math.floor(Math.random()*10000)}.srt`;
                        subtitleCache.set(cacheId, blindText);
                        finalOutput.push({ id: cacheId, url: `${HOST}/dl/${cacheId}`, lang: "ara", title: `[👑 4K Trust | Unverified] (0ms)\n[${c.source}[${c.trackNum}]] ${c.releaseName}` });
                    } catch(e) {}
                    continue; 
                }

                // ─── ROUTE A: The Math Gauntlet ───
                if (hasMovieRulers) {
                    sourceCounters[c.source] = (sourceCounters[c.source] || 0) + 1;
                    const candidateLabel = `${c.source}[${sourceCounters[c.source]}]`;
                    let bestScoreForCandidate = null;

                    const testAgainstRuler = (baseline, rulerName) => {
                        if (!baseline) return;
                        const result = computePrecisionShift(baseline.text, arabicData.text, `${candidateLabel} vs ${rulerName} Ruler`, c.source, detectedType, c.releaseName, false);
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

                    if (bestScoreForCandidate) allSurvivingArabic.push(bestScoreForCandidate);
                }
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
                    const candidateSig = getArabicSignature(champ.fixedText);
                    const existingSig = getArabicSignature(existing.fixedText);
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
           // 4. Push Clean English Rulers Unconditionally
            if (osBaseline) finalOutput.push(processEnglishRuler(osBaseline, 'OpenSubtitles', detectedType, isTV, releaseTokens));
            if (subdlBaseline) finalOutput.push(processEnglishRuler(subdlBaseline, 'SubDL', detectedType, isTV, releaseTokens));
            if (subsourceBaseline) finalOutput.push(processEnglishRuler(subsourceBaseline, 'SubSource', detectedType, isTV, releaseTokens));
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
                    id: cacheId, url: `${HOST}/dl/${cacheId}`, lang: "ara",
                    title: `[Synced to ${champ.rulerName} Ruler | ${champ.alignmentPct.toFixed(0)}%] (${champ.offsetMs>0?'+':''}${champ.offsetMs.toFixed(0)}ms)\n[${champ.candidate.source}[${champ.candidate.trackNum}]] ${champ.candidate.releaseName}`
                });
            }

            // ─── ROUTE B: The Top 2 Raw Token Matches ───
            console.log(`\n[Movie Mode] Extracting Route B (Top 2 Raw Matches)...`);
            const routeBCandidates = allArabicCandidates.filter(c => c.fetchedText).sort((a, b) => b.score - a.score);
            let routeBCount = 0;
            
            for (const c of routeBCandidates) {
                if (routeBCount >= 2) break;
                
                const arabicCharCount = (c.fetchedText.match(/[\u0600-\u06FF]/g) || []).length;
                const latinCharCount = (c.fetchedText.match(/[a-zA-Z]/g) || []).length;
                if (arabicCharCount < CONFIG.Min_Arabic_Letters || latinCharCount > arabicCharCount) continue;

                const cSig = getArabicSignature(c.fetchedText);
                const isAlreadyInRouteA = finalOutput.filter(o => o.lang === 'ara').some(existing => {
                    const existingSubText = subtitleCache.get(existing.id.split('/').pop() || existing.id) || "";
                    return existingSubText && getArabicSignature(existingSubText) === cSig;
                });

                if (isAlreadyInRouteA) continue;

                console.log(`  🚀 [Route B] Pushing top match: ${c.releaseName}`);
                try {
                    let routeBParsed = srtParser.fromSrt(c.fetchedText);
                    routeBParsed.unshift({ id: "0", startTime: "00:00:01,000", endTime: "00:00:06,000", text: `{\\an8}<font color="#8A5A99"><b>[ ${CONFIG.ADDON_NAME} ] By HN95</b></font>\nType: ${detectedType} (Route B)` });
                    let finalRouteBText = srtParser.toSrt(routeBParsed);
                    if (stripTags) finalRouteBText = finalRouteBText.replace(/\{[^}]+\}/g, '').replace(/<[^>]+>/g, '');
                    const cacheId = `elite_ar_RouteB_${Date.now()}_${Math.floor(Math.random()*10000)}.srt`;
                    subtitleCache.set(cacheId, finalRouteBText);
                    
                    finalOutput.push({ id: cacheId, url: `${HOST}/dl/${cacheId}`, lang: "ara", title: `[⚠️ Route B | Raw Match]\n[${c.source}[${c.trackNum}]] ${c.releaseName}` });
                    routeBCount++;
                } catch(e) {}
            }
        }
// =====================================================================
// FINAL DELIVERY & FALLBACK (ROUTE C)
        // =====================================================================
        finalOutput = finalOutput.filter(item => item !== null);
        const arabicWinnersCount = finalOutput.filter(sub => sub.lang === 'ara').length;

        // 🔥 ROUTE C: If Route A and Route B both failed entirely, serve the absolute fallback
        if (arabicWinnersCount === 0 && bestFallback) {
            console.log(`⚠️ Route A & B failed. Serving Route C (Fallback) from ${bestFallback.candidate.source}.`);
            let fallbackParsed;
            try {
                fallbackParsed = srtParser.fromSrt(bestFallback.text);
                fallbackParsed.unshift({ id: "0", startTime: "00:00:01,000", endTime: "00:00:06,000", text: `{\\an8}<font color="#8A5A99"><b>[ ${CONFIG.ADDON_NAME} ] By HN95</b></font>\nType: ${detectedType} (Route C)` });
                bestFallback.text = srtParser.toSrt(fallbackParsed);
            } catch(e) {}

            const cacheId = `elite_routeC_${Date.now()}.srt`;
            let finalSrtText = bestFallback.text;
            if (stripTags) finalSrtText = finalSrtText.replace(/\{[^}]+\}/g, '').replace(/<[^>]+>/g, '');
            subtitleCache.set(cacheId, finalSrtText);
            finalOutput.push({ id: cacheId, url: `${HOST}/dl/${cacheId}`, lang: "ara", title: `[🔴 Route C | Fallback]\n[${bestFallback.candidate.source}] ${bestFallback.candidate.releaseName}` });
        }

        if (finalOutput.length > 0) {
            console.log(`\n👑 --- MASTER RULERS USED ---`);
            finalOutput.filter(sub => sub.lang === 'eng').forEach(r => console.log(`   ${r.title.replace('\n', ' | ')}`));

            console.log(`\n🏆 --- ARABIC WINNERS ---`);
            finalOutput.filter(sub => sub.lang === 'ara').forEach(sub => console.log(`   ${sub.title.replace('\n', ' | ')}`));

            console.log(`\n✅ [Done] ${finalOutput.length} total result(s) returned.`);
            
            const engineMode = isTV ? 'TV Show/Series' : 'Movie';
            const serviceTag = streamingService ? ` [${streamingService}]` : '';
            const totalAra = finalOutput.filter(s => s.lang === 'ara').length;
            const totalEng = finalOutput.filter(s => s.lang === 'eng').length;
            const statsText = `1\n00:00:01,000 --> 00:40:00,000\n{\\an7}<font color="#00ffcc"><b>[ 📊 BRLM Subs: Stats for Nerds ]</b></font>\n<font color="#cccccc"><b>Version:</b> ${CONFIG.ADDON_VERSION}\n<b>Engine:</b> ${engineMode}\n<b>Stream Type:</b> ${detectedType}${serviceTag}\n<b>File Name:</b> ${streamName || 'Unknown'}\n<b>Result:</b> ${totalAra} Arabic Syncs | ${totalEng} Master Rulers</font>`;
            const statsCacheId = `stats_nerds_${Date.now()}.srt`;
            subtitleCache.set(statsCacheId, statsText);
            
          finalOutput.unshift({ id: statsCacheId, url: `${HOST}/dl/${statsCacheId}`, lang: "eng", title: `📊 Stats for Nerds (Debug Info)` });

            // 🔥 BUG FIX: Only save to cache if we actually found Arabic subtitles.
            if (totalAra > 0) {
                responseCache.set(requestCacheKey, { timestamp: Date.now(), subtitles: finalOutput });
            } else {
                console.log(`⚠️ Zero Arabic subs generated. Skipping cache to allow immediate retries.`);
            }
            
            return { subtitles: finalOutput };
        }

        console.log(`\n[Done] No subtitles found.`);
        return { subtitles: [] };

   } catch (error) {
        console.error("❌ Fatal:", error.message);
        return { subtitles: [] };
    }
} // <--- The engine is now cleanly sealed with this bracket

// ─────────────────────────────────────────────────────────────────────────────
// THE TRAFFIC COP (Main Handler & Smart Background Pre-Cacher)
// ─────────────────────────────────────────────────────────────────────────────
builder.defineSubtitlesHandler(async (args) => {
    // 1. Await the actual request so the user gets their subtitles instantly
    const result = await runSubtitleEngine(args);

    // 2. Smart Fire-and-Forget Pre-fetcher!
    if (args.type === 'series' && args.id) {
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
                await runSubtitleEngine(nextEpArgs);
            }
        })().catch(err => {
            console.log(`[Pre-Cache] Background task aborted silently.`);
        });
    }

    return result;
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
                
                <label style="color:#a0a0a0; display:flex; align-items:center; gap:10px; margin-bottom:15px; cursor:pointer;">
                    <input type="checkbox" id="stripTags" style="width:auto; margin:0; transform: scale(1.2);">
                    Strip Formatting Tags (Fixes {\an8} on Basic TVs)
                </label>
                
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

            // Generates the dynamic URLs containing the user's API Key and settings
            function getUrls() {
                const key = osKeyInput.value.trim();
                let configPath = '';
                if (key) {
                    // 🔥 NEW: Grab the checkbox state and inject it into the Stremio config URL
                    const strip = document.getElementById('stripTags').checked;
                    const configObj = { userOsKey: key, stripTags: strip };
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
