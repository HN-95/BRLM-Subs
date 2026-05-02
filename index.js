const express = require('express');
const cors = require('cors');
const iconv = require('iconv-lite');
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const parser = require("srt-parser-2").default;
const srtParser = new parser();
const AdmZip = require("adm-zip");

// ─────────────────────────────────────────────────────────────────────────────
// ENVIRONMENT
//
// FIX #1 — THE ROOT CAUSE OF THE RAILWAY BUG:
// The old code hardcoded "http://127.0.0.1:7000" as the URL it told Stremio
// to fetch the subtitle file from. On Railway, Stremio tries to reach 127.0.0.1
// on the USER'S own device, which has no such server. Result: no subtitles.
//
// The fix: read the public URL from a HOST environment variable.
// In Railway → Variables, add:  HOST = https://your-app.up.railway.app
// For local dev, it falls back to 127.0.0.1 automatically.
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
const HOST = (process.env.HOST || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

const ADDIC7ED_COOKIE = process.env.ADDIC7ED_COOKIE || "";

const subtitleCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// MANIFEST
// ─────────────────────────────────────────────────────────────────────────────
const manifest = {
    id: "org.brlm.arabicelitev17",
    version: "1.0.0",
    name: "Arabic Elite Engine V17",
    description: "Dual-Engine Arabic Subtitle Auto-Shifter.",
    types: ["movie", "series"],
    catalogs: [],
    resources: ["subtitles"],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    },
    config: [
        { key: "osKey",    type: "text", title: "OpenSubtitles API Key", required: true },
        { key: "subdlKey", type: "text", title: "SubDL API Key",         required: true }
    ]
};

const builder = new addonBuilder(manifest);

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE TOKENISER
// ─────────────────────────────────────────────────────────────────────────────
const RELEASE_TOKENS = [
    'remux','bluray','blu-ray','bdrip','brrip','web-dl','webdl','webrip','web',
    'hdtv','dvdrip','dvdscr','dvd','hdrip','hd','ts','cam',
    '2160p','1080p','720p','480p',
    'hevc','x265','x264','h265','h264','av1',
    'hdr','dv','dolby','atmos',
    'dts','aac','dd5','ac3',
    'yts','yify','galaxy','mkvking','sparks','fgt','ettv','eztv','rarbg',
    'ctrlhd','ntb','flux','evo','ion10','telesync','hdts'
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

// ─────────────────────────────────────────────────────────────────────────────
// ENCODING & FORMATTING
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 1: OPENSUBTITLES
// ─────────────────────────────────────────────────────────────────────────────
async function searchOS(url, apiKey) {
    try {
        const res = await fetch(url, {
            headers: { 'Api-Key': apiKey, 'User-Agent': 'StremioArabicElite v17' }
        });
        if (!res.ok) return { data: [] };
        return await res.json();
    } catch { return { data: [] }; }
}

async function getOsSrt(fileId, apiKey) {
    try {
        const req = await fetch('https://api.opensubtitles.com/api/v1/download', {
            method: 'POST',
            headers: {
                'Api-Key': apiKey, 'Content-Type': 'application/json',
                'User-Agent': 'StremioArabicElite v17', 'Accept': 'application/json'
            },
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

// FIX #2 — SILENT BUG IN fetchOsCandidates:
// The hash-search block fetched results but never pushed them into `results`.
// Hash matches were silently discarded, so the engine always fell back to the
// popularity pool and often picked the wrong cut.
async function fetchOsCandidates({ lang, imdbId, season, episode, videoHash, releaseTokens, limit = 10, apiKey }) {
    let results = [];

    if (videoHash) {
        const url = `https://api.opensubtitles.com/api/v1/subtitles?languages=${lang}&moviehash=${videoHash}`;
        const hashData = await searchOS(url, apiKey);
        if (hashData.data?.length) {
            // Push hash results FIRST — these are the highest-confidence matches
            results.push(...hashData.data.map(s => ({
                fileId: s.attributes.files[0].file_id,
                releaseName: s.attributes.release || '',
                source: 'OS',
                hashMatch: true,
                score: 1
            })));
        }
    }

    let poolUrl = `https://api.opensubtitles.com/api/v1/subtitles?languages=${lang}&imdb_id=${imdbId}&order_by=download_count&order_direction=desc`;
    if (season && episode) poolUrl += `&season_number=${season}&episode_number=${episode}`;
    const poolData = await searchOS(poolUrl, apiKey);

    if (poolData.data?.length) {
        const poolEntries = poolData.data.slice(0, 20).map(s => ({
            fileId: s.attributes.files[0].file_id,
            releaseName: s.attributes.release || '',
            source: 'OS',
            hashMatch: false,
            score: releaseTokens.size ? releaseScore(releaseTokens, tokeniseRelease(s.attributes.release || '')) : 0
        }));
        poolEntries.sort((a, b) => b.score - a.score);
        results.push(...poolEntries);
    }

    // Deduplicate — a hash result may also appear in the popularity pool
    const seen = new Set();
    results = results.filter(r => {
        if (seen.has(r.fileId)) return false;
        seen.add(r.fileId);
        return true;
    });

    return results.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 2: SUBDL
// ─────────────────────────────────────────────────────────────────────────────
async function getSubdlCandidates(imdbId, langCode, season, episode, apiKey) {
    try {
        let url = `https://api.subdl.com/api/v1/subtitles?api_key=${apiKey}&imdb_id=tt${imdbId}&languages=${langCode.toLowerCase()}`;
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

async function fetchSubdlCandidates({ imdbId, lang, season, episode, releaseTokens, limit = 10, apiKey }) {
    const all = await getSubdlCandidates(imdbId, lang, season, episode, apiKey);
    if (!all.length) return [];
    const scored = all.map(c => ({
        ...c,
        score: releaseTokens.size ? releaseScore(releaseTokens, tokeniseRelease(c.releaseName)) : 0
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 3: YTS
// ─────────────────────────────────────────────────────────────────────────────
async function getYtsCandidates(imdbId, langCode) {
    try {
        const url = `https://yifysubtitles.org/movie-imdb/tt${imdbId}`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36' }
        });
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
                    refererUrl: url,
                    source: 'YTS'
                });
            }
        }
        return candidates;
    } catch { return []; }
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

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 4: ADDIC7ED
// ─────────────────────────────────────────────────────────────────────────────
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
        const chunks = html.split('class="language"');
        for (let i = 1; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (chunk.substring(0, 20).includes('Arabic')) {
                const linkMatch = chunk.match(/href="(\/(?:original|updated)\/\d+\/\d+)"/i);
                if (linkMatch) {
                    const downloadPath = linkMatch[1];
                    if (!seen.has(downloadPath)) {
                        seen.add(downloadPath);
                        candidates.push({
                            id: downloadPath,
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
    } catch { return []; }
}

async function fetchAddic7edCandidates({ imdbId, lang, season, episode, limit = 5 }) {
    const all = await getAddic7edCandidates(imdbId, lang, season, episode);
    return all.slice(0, limit);
}

const activeAddic7edFetches = new Map();

async function getAddic7edSrt(downloadUrl, refererUrl) {
    if (activeAddic7edFetches.has(downloadUrl)) {
        console.log(`⏳ [Concurrency Lock] Waiting for active Addic7ed fetch...`);
        return await activeAddic7edFetches.get(downloadUrl);
    }
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
                console.log(`❌ [Addic7ed] Session cookie expired or rate-limited.`);
                return null;
            }
            return { text };
        } catch { return null; }
        finally { setTimeout(() => activeAddic7edFetches.delete(downloadUrl), 5000); }
    })();
    activeAddic7edFetches.set(downloadUrl, fetchPromise);
    return await fetchPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL ZIP EXTRACTOR (SubDL + YTS)
// ─────────────────────────────────────────────────────────────────────────────
async function getZipSrt(zipUrl, refererUrl = null) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
        };
        if (refererUrl) headers['Referer'] = refererUrl;
        const res = await fetch(zipUrl, { headers });
        if (!res.ok) return null;
        const buffer = await res.arrayBuffer();
        const textPreview = Buffer.from(buffer).toString('utf8', 0, 100);
        if (textPreview.includes('<html') || textPreview.includes('<!DOCTYPE')) {
            console.log(`  ❌ [Firewall] ZIP URL returned an HTML page — likely a Captcha.`);
            return null;
        }
        const zip = new AdmZip(Buffer.from(buffer));
        const srtEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.srt'));
        if (!srtEntry) return null;
        return { text: decodeArabicFile(srtEntry.getData()) };
    } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// V17 MATH ENGINE
// ─────────────────────────────────────────────────────────────────────────────
function buildEngIndex(engParsed) {
    return engParsed.map(l => l.startSeconds * 1000).sort((a, b) => a - b);
}

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

    const engIndex   = buildEngIndex(engParsed);
    const durationMs = engParsed[engParsed.length - 1].startSeconds * 1000;
    const chunkSizeMs = durationMs / 5;
    const chunks = [[], [], [], [], []];

    arParsed.forEach(line => {
        const arMs  = line.startSeconds * 1000;
        const engMs = nearestValue(engIndex, arMs);
        const delta = arMs - engMs;
        let ci = Math.floor(arMs / chunkSizeMs);
        if (ci > 4) ci = 4;
        chunks[ci].push(delta);
    });

    const chunkOffsets = chunks
        .map(deltas => deltas.length > 15 ? median(deltas) : null)
        .filter(val => val !== null);

    if (chunkOffsets.length < 3) return { passed: false, alignmentPct: 0 };

    const driftMs     = Math.abs(Math.max(...chunkOffsets) - Math.min(...chunkOffsets));
    const allDeltas   = chunks.flat();
    const globalMedian = median(allDeltas);

    const consensusLines = allDeltas.filter(d => Math.abs(d - globalMedian) < 300).length;
    let alignmentPct = (consensusLines / arParsed.length) * 100;

    console.log(`    [V17] ${label} | Align: ${alignmentPct.toFixed(1)}% | Drift: ${driftMs.toFixed(0)}ms`);

    if (driftMs > 350) {
        alignmentPct -= 40;
        console.log(`      ↳ ⚠️  Drift penalty → ${alignmentPct.toFixed(1)}%`);
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
        console.log(`    [Auto-Shift] −${globalMedian.toFixed(1)}ms applied.`);
    }

    return { passed: true, fixedText, offsetMs: globalMedian, alignmentPct, driftMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONCURRENCY LOCK
// ─────────────────────────────────────────────────────────────────────────────
const mainRequestCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
builder.defineSubtitlesHandler(async (args) => {
    const idPartsStr = args.id.split(':');
    const imdbIdStr  = idPartsStr[0].replace('tt', '');
    const seasonStr  = idPartsStr[1] ?? '0';
    const episodeStr = idPartsStr[2] ?? '0';
    const videoHash  = args.extra?.videoHash ?? null;

    const userOsKey    = args.config?.osKey;
    const userSubdlKey = args.config?.subdlKey;

    if (!userOsKey || !userSubdlKey) {
        console.log(`\n❌ [Access Denied] Missing API keys.`);
        return { subtitles: [] };
    }

    const requestKey = `${imdbIdStr}:${seasonStr}:${episodeStr}`;
    const now = Date.now();

    if (!videoHash) {
        console.log(`\n⏱️  [Blind Request] No hash. Sleeping 1.5s for precision fetch...`);
        await new Promise(r => setTimeout(r, 1500));
        if (mainRequestCache.has(requestKey) && mainRequestCache.get(requestKey).hasHash) {
            console.log(`🛑 [Blind Request] Hash request took the lock. Aborting.`);
            return { subtitles: [] };
        }
    }

    if (mainRequestCache.has(requestKey)) {
        const cachedEntry = mainRequestCache.get(requestKey);
        if (videoHash && !cachedEntry.hasHash) {
            if (now - cachedEntry.timestamp > 1500) {
                console.log(`⏳ [Hash Merge] Blind request already processing. Piggybacking...`);
                return await cachedEntry.promise;
            } else {
                console.log(`\n⚔️  [Hash Override] Breaking blind lock for precision fetch...`);
            }
        } else if (now - cachedEntry.timestamp < 10000) {
            console.log(`⏳ [GLOBAL LOCK] Waiting for primary thread...`);
            return await cachedEntry.promise;
        }
    }

    const handlerPromise = (async () => {
        try {
            const streamName    = args.extra?.filename ?? args.extra?.name ?? null;
            const idParts       = args.id.split(':');
            const imdbId        = idParts[0].replace('tt', '');
            const season        = idParts[1] ?? null;
            const episode       = idParts[2] ?? null;
            const releaseTokens = tokeniseRelease(streamName || '');

            console.log(`\n===========================================`);
            console.log(`[V17] IMDb: ${imdbId} | S${season||'?'}E${episode||'?'} | Hash: ${videoHash||'none'}`);
            console.log(`[HOST] ${HOST}`);

            // ── STEP 1: ENGLISH BASELINES ──────────────────────────────────────
            console.log(`\n[Step 1] Fetching English baselines...`);
            const engOsCandidates    = await fetchOsCandidates({ lang: 'en', imdbId, season, episode, videoHash, releaseTokens, limit: 3, apiKey: userOsKey });
            const engSubdlCandidates = await fetchSubdlCandidates({ imdbId, lang: 'en', season, episode, releaseTokens, limit: 2, apiKey: userSubdlKey });

            let tvBaseline = null, movieOsBaseline = null, movieSubdlBaseline = null;

            if (season && episode) {
                console.log(`[Step 1] TV — Addic7ed > SubDL > OS hierarchy...`);
                const engAddic7edCandidates = await fetchAddic7edCandidates({ imdbId, lang: 'en', season, episode, limit: 2 });
                const allTv = [
                    ...engAddic7edCandidates.map(c => ({ ...c, _fetchFn: () => getAddic7edSrt(c.downloadUrl, c.refererUrl) })),
                    ...engSubdlCandidates.map(c => ({ ...c, _fetchFn: () => getZipSrt(c.downloadUrl, c.refererUrl) })),
                    ...engOsCandidates.map(c => ({ ...c, _fetchFn: () => getOsSrt(c.fileId, userOsKey) }))
                ];
                for (const c of allTv) {
                    tvBaseline = await c._fetchFn();
                    if (tvBaseline) { console.log(`✅ TV baseline via ${c.source}`); break; }
                }
                if (!tvBaseline) { console.log(`❌ No TV baseline found.`); return { subtitles: [] }; }
            } else {
                console.log(`[Step 1] Movie — Dual-Baseline Engine...`);
                for (const c of engOsCandidates) {
                    movieOsBaseline = await getOsSrt(c.fileId, userOsKey);
                    if (movieOsBaseline) { console.log(`✅ OS baseline locked`); break; }
                }
                for (const c of engSubdlCandidates) {
                    movieSubdlBaseline = await getZipSrt(c.downloadUrl, c.refererUrl);
                    if (movieSubdlBaseline) { console.log(`✅ SubDL baseline locked`); break; }
                }
                if (!movieOsBaseline && !movieSubdlBaseline) { console.log(`❌ No movie baseline found.`); return { subtitles: [] }; }
            }

            // ── STEP 2: ARABIC CANDIDATES ──────────────────────────────────────
            let successfulTvMatches = [], successfulOsMatches = [], successfulSubdlMatches = [];
            let fastTrackWinner = null, bestFallback = null;

            // Phase 1: TV fast-track via Addic7ed
            if (season && episode) {
                console.log(`\n[Phase 1] TV Fast-Track (Addic7ed)...`);
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

            // Phase 2: Movies + TV backups via OS / SubDL
            if (!fastTrackWinner) {
                console.log(`\n[Phase 2] OS + SubDL candidates...`);
                const [arOsCandidates, arSubdlCandidates] = await Promise.all([
                    fetchOsCandidates({ lang: 'ar', imdbId, season, episode, videoHash, releaseTokens, limit: 8, apiKey: userOsKey }),
                    fetchSubdlCandidates({ imdbId, lang: 'ar', season, episode, releaseTokens, limit: 8, apiKey: userSubdlKey })
                ]);
                const allPhase2 = [
                    ...arSubdlCandidates.map(c => ({ ...c, _fetchFn: () => getZipSrt(c.downloadUrl, c.refererUrl) })),
                    ...arOsCandidates.map(c => ({ ...c, _fetchFn: () => getOsSrt(c.fileId, userOsKey) }))
                ];
                for (let i = 0; i < allPhase2.length; i++) {
                    const c = allPhase2[i];
                    const arabicData = await c._fetchFn();
                    if (!arabicData) continue;
                    if (!bestFallback) bestFallback = { candidate: c, text: arabicData.text };
                    if (season && episode && tvBaseline) {
                        const result = computePrecisionShift(tvBaseline.text, arabicData.text, `TV Backup #${i+1}`);
                        if (result.passed) successfulTvMatches.push({ candidate: c, ...result });
                    } else {
                        if (movieOsBaseline) {
                            const resOs = computePrecisionShift(movieOsBaseline.text, arabicData.text, `OS Ruler #${i+1}`);
                            if (resOs.passed) successfulOsMatches.push({ candidate: c, ...resOs });
                        }
                        if (movieSubdlBaseline) {
                            const resSubdl = computePrecisionShift(movieSubdlBaseline.text, arabicData.text, `SubDL Ruler #${i+1}`);
                            if (resSubdl.passed) successfulSubdlMatches.push({ candidate: c, ...resSubdl });
                        }
                    }
                }
            }

            // ── STEP 3: CROWN THE CHAMPION(S) ─────────────────────────────────
            const SOURCE_WEIGHTS = { 'Addic7ed': 5, 'OS': 2, 'SubDL': 1 };
            const sortFn = (a, b) => {
                const sB = b.alignmentPct + (SOURCE_WEIGHTS[b.candidate.source] || 0);
                const sA = a.alignmentPct + (SOURCE_WEIGHTS[a.candidate.source] || 0);
                return sB === sA ? (a.driftMs - b.driftMs) : (sB - sA);
            };

            let finalOutput = [];

            // TV: single best result
            if (season && episode) {
                if (fastTrackWinner) successfulTvMatches = [fastTrackWinner];
                if (successfulTvMatches.length > 0) {
                    successfulTvMatches.sort(sortFn);
                    const champ = successfulTvMatches[0];
                    const cacheId = `elite_tv_${Date.now()}.srt`;
                    subtitleCache.set(cacheId, champ.fixedText);
                    finalOutput.push({
                        id: cacheId,
                        url: `${HOST}/dl/${cacheId}`,
                        lang: "ara",
                        title: `[isSynced: True | ${champ.alignmentPct.toFixed(0)}%] (${champ.offsetMs>0?'+':''}${champ.offsetMs.toFixed(0)}ms)\n[${champ.candidate.source}] ${champ.candidate.releaseName}`
                    });
                }
            }
            // Movies: Top 1 from OS ruler + Top 1 from SubDL ruler (your original 2-result design)
            else {
                if (successfulOsMatches.length > 0) {
                    successfulOsMatches.sort(sortFn);
                    const osChamp = successfulOsMatches[0];
                    const cacheId = `elite_os_${Date.now()}.srt`;
                    subtitleCache.set(cacheId, osChamp.fixedText);
                    finalOutput.push({
                        id: cacheId,
                        url: `${HOST}/dl/${cacheId}`,
                        lang: "ara",
                        title: `[isSynced: OS Ruler | ${osChamp.alignmentPct.toFixed(0)}%] (${osChamp.offsetMs>0?'+':''}${osChamp.offsetMs.toFixed(0)}ms)\n[${osChamp.candidate.source}] ${osChamp.candidate.releaseName}`
                    });
                }
                if (successfulSubdlMatches.length > 0) {
                    successfulSubdlMatches.sort(sortFn);
                    const subdlChamp = successfulSubdlMatches[0];
                    const cacheId = `elite_subdl_${Date.now()}.srt`;
                    subtitleCache.set(cacheId, subdlChamp.fixedText);
                    finalOutput.push({
                        id: cacheId,
                        url: `${HOST}/dl/${cacheId}`,
                        lang: "ara",
                        title: `[isSynced: SubDL Ruler | ${subdlChamp.alignmentPct.toFixed(0)}%] (${subdlChamp.offsetMs>0?'+':''}${subdlChamp.offsetMs.toFixed(0)}ms)\n[${subdlChamp.candidate.source}] ${subdlChamp.candidate.releaseName}`
                    });
                }
            }

            if (finalOutput.length > 0) {
                console.log(`\n✅ [Done] ${finalOutput.length} result(s) returned.`);
                return { subtitles: finalOutput };
            }

            // Unverified fallback
            if (bestFallback) {
                console.log(`⚠️  Math engine found no passing candidates. Serving unverified fallback.`);
                const cacheId = `elite_fallback_${Date.now()}.srt`;
                subtitleCache.set(cacheId, bestFallback.text);
                return {
                    subtitles: [{
                        id: cacheId,
                        url: `${HOST}/dl/${cacheId}`,   // ← FIX #1: dynamic HOST
                        lang: "ara",
                        title: `⚠️ Arabic (Unverified Fallback)`
                    }]
                };
            }

            console.log(`\n[Done] No subtitles found.`);
            return { subtitles: [] };

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
    // Derive the install host: env var wins, else infer from the request
    const installHost = process.env.HOST
        ? process.env.HOST.replace(/\/$/, '').replace(/^https?:\/\//, '')
        : req.get('host');

    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Arabic Elite Engine V17 | Setup</title>
        <style>
            body { background-color:#141414; color:#e5e5e5; font-family:'Segoe UI',Tahoma,sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; text-align:center; }
            .container { background-color:#202020; padding:40px; border-radius:12px; border:1px solid #333; max-width:500px; box-shadow:0 10px 30px rgba(0,0,0,.5); }
            h1 { color:#8A5A99; font-size:2rem; margin-top:0; }
            p { color:#a0a0a0; font-size:1rem; margin-bottom:30px; }
            .input-group { text-align:left; margin-bottom:20px; }
            label { font-size:.9rem; color:#bbb; display:block; margin-bottom:8px; font-weight:bold; }
            input { width:100%; padding:12px; border-radius:6px; border:1px solid #444; background-color:#111; color:white; font-size:1rem; box-sizing:border-box; }
            input:focus { outline:none; border-color:#8A5A99; }
            .install-btn { background-color:#8A5A99; color:white; padding:15px; width:100%; border:none; border-radius:8px; font-size:1.2rem; font-weight:bold; cursor:pointer; transition:background-color .2s; margin-top:10px; }
            .install-btn:hover { background-color:#6c4777; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Arabic Elite Engine</h1>
            <p>Provide your API keys to install this private auto-shifting engine into Stremio.</p>
            <p>Made By HN95.</p>
            <div class="input-group">
                <label>OpenSubtitles REST API Key *</label>
                <input type="text" id="osKey" placeholder="Enter OS API Key" required>
            </div>
            <div class="input-group">
                <label>SubDL API Key *</label>
                <input type="text" id="subdlKey" placeholder="Enter SubDL API Key" required>
            </div>
            <button class="install-btn" onclick="installAddon()">Install to Stremio</button>
        </div>
        <script>
            function installAddon() {
                const os    = document.getElementById('osKey').value.trim();
                const subdl = document.getElementById('subdlKey').value.trim();
                if (!os || !subdl) { alert('⚠️ Both API keys are required!'); return; }
                const configStr = encodeURIComponent(JSON.stringify({ osKey: os, subdlKey: subdl }));
                window.location.href = 'stremio://${installHost}/' + configStr + '/manifest.json';
            }
        </script>
    </body>
    </html>
    `);
});

app.use(getRouter(builder.getInterface()));

app.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(`🚀 Arabic Elite Engine V17 is LIVE`);
    console.log(`🌍 Public HOST: ${HOST}`);
    console.log(`➡️  Landing Page: ${HOST}`);
    console.log(`=========================================\n`);
});
