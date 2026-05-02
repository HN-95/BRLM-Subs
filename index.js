const express = require('express');
const cors = require('cors');
const iconv = require('iconv-lite');
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const parser = require("srt-parser-2").default;
const srtParser = new parser();
const AdmZip = require("adm-zip");

const OS_API_KEY = "0RrM7pMhpM4n2pVN0ldnzNXYnxh72LIL";
const SUBDL_API_KEY = "eOg4zBUtULlU4bnZNw8TxPuIeJabAnxp";
// ---> PASTE YOUR CHROME COOKIE HERE TO BYPASS THE LOGIN WALL <---
const ADDIC7ED_COOKIE = "PHPSESSID=7ahdnps9hv4388rhqqk0cqabk7; wikisubtitlesuser=1189026; wikisubtitlespass=c999fd9f819578dfbbe69dcb919d0536";

const PORT = 7000;
const subtitleCache = new Map();

const manifest = {
    id: "com.arabic.elite.autoshift",
    version: "17.1.0",
    name: "Arabic Elite Engine (V17 + Addic7ed)",
    description: "Slices movies into 5 checkpoints across OS, SubDL, YTS, and Addic7ed.",
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
};

const builder = new addonBuilder(manifest);

const RELEASE_TOKENS = [
    'remux', 'bluray', 'blu-ray', 'bdrip', 'brrip', 'web-dl', 'webdl', 'webrip', 'web', 'hdtv', 'dvdrip', 'dvdscr', 'dvd', 'hdrip', 'hd', 'ts', 'cam',
    '2160p', '1080p', '720p', '480p',
    'hevc', 'x265', 'x264', 'h265', 'h264', 'av1',
    'hdr', 'dv', 'dolby', 'atmos',
    'dts', 'aac', 'dd5', 'ac3',
    'yts', 'yify', 'galaxy', 'mkvking', 'sparks', 'fgt', 'ettv', 'eztv', 'rarbg', 'ctrlhd', 'ntb', 'flux', 'evo', 'ion10', 'telesync', 'hdts'
];

function tokeniseRelease(name) {
    if (!name) return new Set();
    const lower = name.toLowerCase().replace(/[._\-\s]+/g, ' ');
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

function decodeArabicFile(buffer) {
    const utf8 = buffer.toString('utf8');
    if (/[\u0600-\u06FF]/.test(utf8)) return utf8;
    return iconv.decode(buffer, 'win1256');
}

function formatTime(ms) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1_000);
    const x = Math.floor(ms % 1_000);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(x).padStart(3,'0')}`;
}

// ==========================================
// SOURCE 1: OPENSUBTITLES
// ==========================================
async function searchOS(url) {
    try {
        const res = await fetch(url, { headers: { 'Api-Key': OS_API_KEY, 'User-Agent': 'StremioArabicElite v17' } });
        if (!res.ok) return { data: [] };
        return await res.json();
    } catch { return { data: [] }; }
}

async function getOsSrt(fileId) {
    try {
        const req = await fetch('https://api.opensubtitles.com/api/v1/download', {
            method: 'POST',
            headers: { 'Api-Key': OS_API_KEY, 'Content-Type': 'application/json', 'User-Agent': 'StremioArabicElite v17', 'Accept': 'application/json' },
            body: JSON.stringify({ file_id: parseInt(fileId) })
        });
        if (!req.ok) return null;
        const data = await req.json();
        if (!data.link) return null;
        const textReq = await fetch(data.link);
        const buffer = await textReq.arrayBuffer();
        return { text: decodeArabicFile(Buffer.from(buffer)) };
    } catch { return null; }
}

async function fetchOsCandidates({ lang, imdbId, season, episode, videoHash, releaseTokens, limit = 10 }) {
    let results = [];
    if (videoHash) {
        const url = `https://api.opensubtitles.com/api/v1/subtitles?languages=${lang}&moviehash=${videoHash}`;
        const hashData = await searchOS(url);
        if (hashData.data?.length) {
            results.push(...hashData.data.map(s => ({
                fileId: s.attributes.files[0].file_id, releaseName: s.attributes.release || '', source: 'OS', hashMatch: true
            })));
        }
    }
    let poolUrl = `https://api.opensubtitles.com/api/v1/subtitles?languages=${lang}&imdb_id=${imdbId}&order_by=download_count&order_direction=desc`;
    if (season && episode) poolUrl += `&season_number=${season}&episode_number=${episode}`;
    const poolData = await searchOS(poolUrl);

    if (poolData.data?.length) {
        const poolEntries = poolData.data.slice(0, 20).map(s => ({
            fileId: s.attributes.files[0].file_id, releaseName: s.attributes.release || '', source: 'OS', hashMatch: false,
            score: releaseTokens.size ? releaseScore(releaseTokens, tokeniseRelease(s.attributes.release || '')) : 0
        }));
        poolEntries.sort((a, b) => b.score - a.score);
        results.push(...poolEntries);
    }
    const seen = new Set();
    results = results.filter(r => { if (seen.has(r.fileId)) return false; seen.add(r.fileId); return true; });
    return results.slice(0, limit);
}

// ==========================================
// SOURCE 2: SUBDL
// ==========================================
async function getSubdlCandidates(imdbId, langCode, season, episode) {
    try {
        let url = `https://api.subdl.com/api/v1/subtitles?api_key=${SUBDL_API_KEY}&imdb_id=tt${imdbId}&languages=${langCode.toLowerCase()}`;
        url += season && episode ? `&type=tv&season_number=${season}&episode_number=${episode}` : `&type=movie`;
        const res = await fetch(url);
        const data = await res.json();
        if (!data.subtitles?.length) return [];
        return data.subtitles.map(sub => ({
            id: sub.url,
            releaseName: sub.release_name || 'SubDL',
            downloadUrl: "https://dl.subdl.com" + (sub.url.startsWith('/') ? sub.url : '/' + sub.url),
            source: 'SubDL'
        }));
    } catch { return []; }
}

async function fetchSubdlCandidates({ imdbId, lang, season, episode, releaseTokens, limit = 10 }) {
    const all = await getSubdlCandidates(imdbId, lang, season, episode);
    if (!all.length) return [];
    const scored = all.map(c => ({ ...c, score: releaseTokens.size ? releaseScore(releaseTokens, tokeniseRelease(c.releaseName)) : 0 }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}

// ==========================================
// SOURCE 3: YTS (LIGHTNING SCRAPER)
// ==========================================
async function getYtsCandidates(imdbId, langCode) {
    try {
        const url = `https://yifysubtitles.org/movie-imdb/tt${imdbId}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36' } });
        if (!res.ok) return [];
        const html = await res.text();

        const langString = langCode.toLowerCase() === 'ar' ? 'arabic' : 'english';
        
        const regex = new RegExp(`href="\\/subtitles\\/([^"]+?-${langString}-[^"]+?)"`, 'gi');
        
        let matches;
        const candidates = [];
        const seen = new Set();
        
        while ((matches = regex.exec(html)) !== null) {
            const subId = matches[1];
            if (!seen.has(subId)) {
                seen.add(subId);
                candidates.push({
                    id: subId,
                    releaseName: subId.replace(/-/g, '.'),
                    downloadUrl: `https://yifysubtitles.org/subtitle/${subId}.zip`,
                    refererUrl: url, // <-- THE BREADCRUMB INJECTED HERE
                    source: 'YTS'
                });
            }
        }
        return candidates;
    } catch (e) { return []; }
}

async function fetchYtsCandidates({ imdbId, lang, season, episode, releaseTokens, limit = 10 }) {
    if (season || episode) return [];

    const all = await getYtsCandidates(imdbId, lang);
    if (!all.length) return [];
    
    const scored = all.map(c => ({ 
        ...c, 
        score: releaseTokens.size ? releaseScore(releaseTokens, tokeniseRelease(c.releaseName)) : 0 
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}

// ==========================================
// SOURCE 4: ADDIC7ED (COOKIE-BYPASS SCRAPER)
// ==========================================
async function getShowName(imdbId) {
    try {
        const res = await fetch(`https://v3-cinemeta.strem.io/meta/series/tt${imdbId}.json`);
        const data = await res.json();
        return data.meta?.name || null;
    } catch { return null; }
}

async function getAddic7edCandidates(imdbId, langCode, season, episode) {
    if (!season || !episode) return []; 

    const showName = await getShowName(imdbId);
    if (!showName) return [];

    const formattedName = showName.replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
    const addic7edLang = langCode.toLowerCase() === 'ar' ? '38' : '1'; 
    const url = `https://www.addic7ed.com/serie/${formattedName}/${season}/${episode}/${addic7edLang}`;

 try {
        const res = await fetch(url, { 
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Cookie': ADDIC7ED_COOKIE 
            } 
        });
        
        if (!res.ok) return [];
        const html = await res.text();

        const candidates = [];
        const seen = new Set();

        // THE FIX: We split the entire HTML page into chunks based on Addic7ed's language column
        const chunks = html.split('class="language"');

        // We start at index 1 because index 0 is just the website header/junk
        for (let i = 1; i < chunks.length; i++) {
            const chunk = chunks[i];
            
            // Check the first 20 characters of this chunk to guarantee it says "Arabic"
            if (chunk.substring(0, 20).includes('Arabic')) {
                
                // NOW we run the regex, but ONLY inside this safely verified Arabic block
                const linkMatch = chunk.match(/href="(\/(?:original|updated)\/\d+\/\d+)"/i);
                
                if (linkMatch) {
                    const downloadPath = linkMatch[1];
                    if (!seen.has(downloadPath)) {
                        seen.add(downloadPath);
                        candidates.push({
                            id: downloadPath,
                            // Added .ARABIC to the name so you can see it in the logs!
                            releaseName: `Addic7ed.${formattedName}.S${season}E${episode}.ARABIC`,
                            downloadUrl: `https://www.addic7ed.com${downloadPath}`,
                            refererUrl: url, 
                            source: 'Addic7ed'
                        });
                    }
                }
            }
        }
        return candidates;
    } catch (e) { return []; }
}

async function fetchAddic7edCandidates({ imdbId, lang, season, episode, limit = 5 }) {
    const all = await getAddic7edCandidates(imdbId, lang, season, episode);
    return all.slice(0, limit);
}

// A global map to hold active network requests
const activeAddic7edFetches = new Map();

async function getAddic7edSrt(downloadUrl, refererUrl) {
    // CONCURRENCY LOCK: If Thread A is already downloading this, make Thread B wait for it!
    if (activeAddic7edFetches.has(downloadUrl)) {
        console.log(`⏳ [Concurrency Lock] Thread B is waiting for Thread A to finish Addic7ed...`);
        return await activeAddic7edFetches.get(downloadUrl);
    }

    // Wrap the actual fetch in a Promise so we can store it in the map
    const fetchPromise = (async () => {
        try {
            const res = await fetch(downloadUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Referer': refererUrl, 
                    'Cookie': ADDIC7ED_COOKIE
                }
            });
            if (!res.ok) return null;
            
            const buffer = await res.arrayBuffer();
            const text = decodeArabicFile(Buffer.from(buffer));
            
            if (text.includes('<!DOCTYPE html>') || text.includes('<html')) {
                console.log(`❌ [Addic7ed Blocked] The session cookie has expired or we hit a rate limit!`);
                return null; 
            }
            
            return { text };
        } catch { 
            return null; 
        } finally {
            // Clean up the lock 5 seconds after it finishes
            setTimeout(() => activeAddic7edFetches.delete(downloadUrl), 5000);
        }
    })();

    // Save the active promise to the map so Thread B can find it
    activeAddic7edFetches.set(downloadUrl, fetchPromise);
    
    return await fetchPromise;
}

// --- UNIVERSAL ZIP EXTRACTOR (Used by SubDL and YTS) ---
// --- UNIVERSAL ZIP EXTRACTOR (Upgraded with Referer Bypass) ---
async function getZipSrt(zipUrl, refererUrl = null) {
    try {
        const headers = { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
        };
        // If a referer is provided, inject it to bypass hotlink protection
        if (refererUrl) headers['Referer'] = refererUrl;

        const res = await fetch(zipUrl, { headers });
        if (!res.ok) return null;
        
        const buffer = await res.arrayBuffer();
        
        // 🛡️ CLOUDFLARE SHIELD: Peek at the first 100 bytes of the file. 
        // If it looks like HTML instead of a ZIP archive, abort!
        const textPreview = Buffer.from(buffer).toString('utf8', 0, 100);
        if (textPreview.includes('<html') || textPreview.includes('<!DOCTYPE')) {
            console.log(`  ❌ [Firewall Block] The ZIP URL returned an HTML Captcha page instead of a file!`);
            return null;
        }

        const zip = new AdmZip(Buffer.from(buffer));
        const srtEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.srt'));
        if (!srtEntry) return null;
        return { text: decodeArabicFile(srtEntry.getData()) };
    } catch (e) { 
        return null; 
    }
}

// ==========================================
// V17: MATH ENGINE (Checkpoint + Stretch)
// ==========================================
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

function computePrecisionShift(englishText, arabicText, label = '') {
    if (!englishText || !arabicText) return { passed: false, alignmentPct: 0 };
    let engParsed, arParsed;
    try {
        engParsed = srtParser.fromSrt(englishText);
        arParsed  = srtParser.fromSrt(arabicText);
    } catch { return { passed: false, alignmentPct: 0 }; }

    if (engParsed.length < 50 || arParsed.length < 50) return { passed: false, alignmentPct: 0 };

    const engIndex = buildEngIndex(engParsed);
    const durationMs = engParsed[engParsed.length - 1].startSeconds * 1000;
    const chunkSizeMs = durationMs / 5; 
    
    let chunks = [[], [], [], [], []];

    arParsed.forEach(line => {
        const arMs  = line.startSeconds * 1000;
        const engMs = nearestValue(engIndex, arMs);
        const delta = arMs - engMs;

        let chunkIdx = Math.floor(arMs / chunkSizeMs);
        if (chunkIdx > 4) chunkIdx = 4;
        chunks[chunkIdx].push(delta);
    });

    let chunkOffsets = chunks
        .map(deltas => deltas.length > 15 ? median(deltas) : null)
        .filter(val => val !== null);

    if (chunkOffsets.length < 3) return { passed: false, alignmentPct: 0 }; 

    const maxOffset = Math.max(...chunkOffsets);
    const minOffset = Math.min(...chunkOffsets);
    const driftMs = Math.abs(maxOffset - minOffset);

    const allDeltas = chunks.flat();
    const globalMedian = median(allDeltas);

    const consensusLines = allDeltas.filter(d => Math.abs(d - globalMedian) < 300).length;
    let alignmentPct = (consensusLines / arParsed.length) * 100;

    console.log(`    [V17] ${label} | Raw Align: ${alignmentPct.toFixed(1)}% | Drift: ${driftMs.toFixed(0)}ms`);

    // The Penalty Box
    if (driftMs > 350) {
        alignmentPct -= 40; 
        console.log(`      ↳ ⚠️ Penalized for drifting! Score dropped to ${alignmentPct.toFixed(1)}%`);
    }

    if (alignmentPct < 40) return { passed: false, alignmentPct };

    let fixedText = arabicText;
    if (Math.abs(globalMedian) > 50) {
        const shifted = arParsed.map(line => ({
            ...line,
            startTime: formatTime(Math.max(0, line.startSeconds * 1000 - globalMedian)),
            endTime:   formatTime(Math.max(0, line.endSeconds   * 1000 - globalMedian))
        }));
        fixedText = srtParser.toSrt(shifted);
    }

    return { 
        passed: true, 
        fixedText, 
        offsetMs: globalMedian, 
        alignmentPct,
        driftMs
    };
}

// ==========================================
// MAIN HANDLER
// ==========================================
// A global cache map to hold active handler promises (locks the whole Tri-Core test)
// A global cache map to hold active handler promises (locks the whole Tri-Core test)
// A global cache map to hold active handler promises
// A global cache map to hold active handler promises
const mainRequestCache = new Map();

// ==========================================
// MAIN HANDLER (DUAL-ENGINE ARCHITECTURE)
// ==========================================
builder.defineSubtitlesHandler(async (args) => {
    const idPartsStr = args.id.split(':');
    const imdbIdStr  = idPartsStr[0].replace('tt', '');
    const seasonStr  = idPartsStr[1] ?? '0';
    const episodeStr = idPartsStr[2] ?? '0';
    const videoHash  = args.extra?.videoHash ?? null; 
    
    const requestKey = `${imdbIdStr}:${seasonStr}:${episodeStr}`;
    const now = Date.now();

    if (!videoHash) {
        console.log(`\n⏱️ [Blind Request] No hash detected. Sleeping for 1.5s to wait for Stremio's Precision Fetch...`);
        await new Promise(r => setTimeout(r, 1500));
        if (mainRequestCache.has(requestKey) && mainRequestCache.get(requestKey).hasHash) {
            console.log(`🛑 [Blind Request] A superior Hash Request took the lock! Aborting.`);
            return { subtitles: [] }; 
        }
    }

    if (mainRequestCache.has(requestKey)) {
        const cachedEntry = mainRequestCache.get(requestKey);
        if (videoHash && !cachedEntry.hasHash) {
            console.log(`\n⚔️ [Hash Override] Precision Fetch detected! Breaking the blind lock...`);
        } else if (now - cachedEntry.timestamp < 10000) {
            console.log(`⏳ [GLOBAL LOCK] Concurrency detected. Waiting for primary thread...`);
            return await cachedEntry.promise;
        }
    }

    const handlerPromise = (async () => {
        try {
            const videoHash   = args.extra?.videoHash  ?? null;
            const streamName  = args.extra?.filename   ?? args.extra?.name ?? null;
            const idParts     = args.id.split(':');
            const imdbId      = idParts[0].replace('tt', '');
            const season      = idParts[1] ?? null;
            const episode     = idParts[2] ?? null;
            const releaseTokens = tokeniseRelease(streamName || '');

            console.log(`\n===========================================`);
            console.log(`[V17 Request] IMDb: ${imdbId} | S${season||'?'}E${episode||'?'} | Hash: ${videoHash||'none'}`);

            // ==========================================
            // STEP 1: FETCHING BASELINES (THE RULERS)
            // ==========================================
            console.log(`\n[Step 1] Fetching English Baselines...`);
            const engOsCandidates = await fetchOsCandidates({ lang: 'en', imdbId, season, episode, videoHash, releaseTokens, limit: 3 });
            const engSubdlCandidates = await fetchSubdlCandidates({ imdbId, lang: 'en', season, episode, releaseTokens, limit: 2 });
            
            let tvBaseline = null;
            let movieOsBaseline = null;
            let movieSubdlBaseline = null;

            if (season && episode) {
                console.log(`[Step 1] TV Show detected. Forcing Addic7ed > SubDL > OS Hierarchy...`);
                const engAddic7edCandidates = await fetchAddic7edCandidates({ imdbId, lang: 'en', season, episode, limit: 2 });
                const allTvCandidates = [
                     ...engAddic7edCandidates.map(c => ({ ...c, _fetchFn: () => getAddic7edSrt(c.downloadUrl, c.refererUrl) })),
                     ...engSubdlCandidates.map(c => ({ ...c, _fetchFn: () => getZipSrt(c.downloadUrl, c.refererUrl) })),
                     ...engOsCandidates.map(c => ({ ...c, _fetchFn: () => getOsSrt(c.fileId) }))
                ];
                for (const c of allTvCandidates) {
                    tvBaseline = await c._fetchFn();
                    if (tvBaseline) { console.log(`✅ TV Baseline locked via ${c.source}`); break; }
                }
                if (!tvBaseline) return { subtitles: [] };
            } else {
                console.log(`[Step 1] Movie detected. Engaging Dual-Baseline Engine (OS & SubDL)...`);
                // 1. Lock OS Baseline
                for (const c of engOsCandidates) {
                    movieOsBaseline = await getOsSrt(c.fileId);
                    if (movieOsBaseline) { console.log(`✅ OS Baseline Locked`); break; }
                }
                // 2. Lock SubDL Baseline
                for (const c of engSubdlCandidates) {
                    movieSubdlBaseline = await getZipSrt(c.downloadUrl, c.refererUrl);
                    if (movieSubdlBaseline) { console.log(`✅ SubDL Baseline Locked`); break; }
                }
                if (!movieOsBaseline && !movieSubdlBaseline) return { subtitles: [] };
            }

            let successfulTvMatches = [];
            let successfulOsMatches = [];
            let successfulSubdlMatches = [];
            let fastTrackWinner = null;
            let bestFallback = null;

            // ==========================================
            // PHASE 1: TV FAST-TRACK
            // ==========================================
            if (season && episode) {
                const arAddic7edCandidates = await fetchAddic7edCandidates({ imdbId, lang: 'ar', season, episode, limit: 4 });
                for (let i = 0; i < arAddic7edCandidates.length; i++) {
                    const c = arAddic7edCandidates[i];
                    const arabicData = await getAddic7edSrt(c.downloadUrl, c.refererUrl);
                    if (!arabicData) continue;
                    if (!bestFallback) bestFallback = { candidate: c, text: arabicData.text };
                    
                    const result = computePrecisionShift(tvBaseline.text, arabicData.text, `Addic7ed #${i+1}`);
                    if (result.passed) {
                        successfulTvMatches.push({ candidate: c, ...result });
                        if (result.alignmentPct >= 95 && result.driftMs <= 100) {
                            fastTrackWinner = successfulTvMatches[successfulTvMatches.length - 1];
                            break;
                        }
                    }
                }
            }

            // ==========================================
            // PHASE 2: MOVIES & TV BACKUPS
            // ==========================================
            if (!fastTrackWinner) {
                const [arOsCandidates, arSubdlCandidates] = await Promise.all([
                    fetchOsCandidates({ lang: 'ar', imdbId, season, episode, videoHash, releaseTokens, limit: 8 }),
                    fetchSubdlCandidates({ lang: 'ar', imdbId, season, episode, releaseTokens, limit: 8 })
                ]);

                const allArabicPhase2 = [
                    ...arSubdlCandidates.map(c => ({ ...c, _fetchFn: () => getZipSrt(c.downloadUrl, c.refererUrl) })),
                    ...arOsCandidates.map(c => ({ ...c, _fetchFn: () => getOsSrt(c.fileId) }))
                ];

                for (let i = 0; i < allArabicPhase2.length; i++) {
                    const c = allArabicPhase2[i];
                    const arabicData = await c._fetchFn();
                    if (!arabicData) continue;
                    if (!bestFallback) bestFallback = { candidate: c, text: arabicData.text };

                    // TV Comparison (Single Engine)
                    if (season && episode && tvBaseline) {
                        const result = computePrecisionShift(tvBaseline.text, arabicData.text, `TV Backup`);
                        if (result.passed) successfulTvMatches.push({ candidate: c, ...result });
                    } 
                    // MOVIE Comparison (Dual Engine)
                    else {
                        if (movieOsBaseline) {
                            const resOs = computePrecisionShift(movieOsBaseline.text, arabicData.text, `OS Ruler`);
                            if (resOs.passed) successfulOsMatches.push({ candidate: c, ...resOs });
                        }
                        if (movieSubdlBaseline) {
                            const resSubdl = computePrecisionShift(movieSubdlBaseline.text, arabicData.text, `SubDL Ruler`);
                            if (resSubdl.passed) successfulSubdlMatches.push({ candidate: c, ...resSubdl });
                        }
                    }
                }
            }

            // ==========================================
            // CROWNING THE CHAMPION(S)
            // ==========================================
            let finalOutput = [];
            const SOURCE_WEIGHTS = { 'Addic7ed': 5, 'OS': 2, 'SubDL': 1 };
            const sortFn = (a, b) => {
                const scoreB = b.alignmentPct + (SOURCE_WEIGHTS[b.candidate.source] || 0);
                const scoreA = a.alignmentPct + (SOURCE_WEIGHTS[a.candidate.source] || 0);
                return scoreB === scoreA ? (a.driftMs - b.driftMs) : (scoreB - scoreA);
            };

            // IF TV SHOW (Return Top 1)
            if (season && episode) {
                if (fastTrackWinner) successfulTvMatches = [fastTrackWinner];
                if (successfulTvMatches.length > 0) {
                    successfulTvMatches.sort(sortFn);
                    const champ = successfulTvMatches[0];
                    const cacheId = `elite_tv_${Date.now()}.srt`;
                    subtitleCache.set(cacheId, champ.fixedText);
                    finalOutput.push({
                        id: cacheId, url: `http://127.0.0.1:${PORT}/dl/${cacheId}`, lang: "ara",
                        title: `[isSynced: True | ${champ.alignmentPct.toFixed(0)}%] (${champ.offsetMs>0?'+':''}${champ.offsetMs.toFixed(0)}ms)\n[${champ.candidate.source}] ${champ.candidate.releaseName}`
                    });
                }
            } 
            // IF MOVIE (Return Top 1 OS *and* Top 1 SubDL)
            else {
                if (successfulOsMatches.length > 0) {
                    successfulOsMatches.sort(sortFn);
                    const osChamp = successfulOsMatches[0];
                    const cacheId = `elite_os_${Date.now()}.srt`;
                    subtitleCache.set(cacheId, osChamp.fixedText);
                    finalOutput.push({
                        id: cacheId, url: `http://127.0.0.1:${PORT}/dl/${cacheId}`, lang: "ara",
                        title: `[isSynced: OS Ruler | ${osChamp.alignmentPct.toFixed(0)}%] (${osChamp.offsetMs>0?'+':''}${osChamp.offsetMs.toFixed(0)}ms)\n[${osChamp.candidate.source}] ${osChamp.candidate.releaseName}`
                    });
                }
                if (successfulSubdlMatches.length > 0) {
                    successfulSubdlMatches.sort(sortFn);
                    const subdlChamp = successfulSubdlMatches[0];
                    const cacheId = `elite_subdl_${Date.now()}.srt`;
                    subtitleCache.set(cacheId, subdlChamp.fixedText);
                    finalOutput.push({
                        id: cacheId, url: `http://127.0.0.1:${PORT}/dl/${cacheId}`, lang: "ara",
                        title: `[isSynced: SubDL Ruler | ${subdlChamp.alignmentPct.toFixed(0)}%] (${subdlChamp.offsetMs>0?'+':''}${subdlChamp.offsetMs.toFixed(0)}ms)\n[${subdlChamp.candidate.source}] ${subdlChamp.candidate.releaseName}`
                    });
                }
            }

            // Fallback if math engine totally failed
            if (finalOutput.length === 0 && bestFallback) {
                const cacheId = `elite_fallback_${Date.now()}.srt`;
                subtitleCache.set(cacheId, bestFallback.text);
                finalOutput.push({
                    id: cacheId, url: `http://127.0.0.1:${PORT}/dl/${cacheId}`, lang: "ara",
                    title: `[isSynced: False] ⚠️ Unverified Fallback\n[${bestFallback.candidate.source}] ${bestFallback.candidate.releaseName}`
                });
            }

            return { subtitles: finalOutput };

        } catch (error) {
            console.error("❌ Fatal:", error.message);
            return { subtitles: [] };
        } finally {
            setTimeout(() => {
                const entry = mainRequestCache.get(requestKey);
                if (entry && entry.timestamp === now) mainRequestCache.delete(requestKey);
            }, 10000);
        }
    })();

    mainRequestCache.set(requestKey, { promise: handlerPromise, timestamp: now, hasHash: !!videoHash });
    return await handlerPromise;
});

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
app.use(getRouter(builder.getInterface()));
app.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(`🚀 Arabic Elite Engine V17 (+ Addic7ed Test) is LIVE`);
    console.log(`➡️  Add to Stremio: http://127.0.0.1:${PORT}/manifest.json`);
    console.log(`=========================================\n`);
});
