const express = require('express');
const cors = require('cors');
const iconv = require('iconv-lite');
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const parser = require("srt-parser-2").default;
const srtParser = new parser();
const AdmZip = require("adm-zip");

const OS_API_KEY = "0RrM7pMhpM4n2pVN0ldnzNXYnxh72LIL";
const SUBDL_API_KEY = "eOg4zBUtULlU4bnZNw8TxPuIeJabAnxp";

const PORT = process.env.PORT || 7000;
// This will automatically grab your cloud server's web address!
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const subtitleCache = new Map();

const manifest = {
    id: "com.arabic.elite.autoshift",
    version: "17.0.0",
    name: "Arabic Elite Engine (V17 Tri-Core)",
    description: "Slices movies into 5 checkpoints across OS, SubDL, and YTS.",
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
        // Standard User-Agent to prevent getting blocked by anti-bot checks
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36' } });
        if (!res.ok) return [];
        const html = await res.text();

        const langString = langCode.toLowerCase() === 'ar' ? 'arabic' : 'english';
        
        // Regex to hunt down the specific subtitle page links for the requested language
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
                    // Convert "movie-name-arabic-yify-12345" to "movie.name.arabic.yify.12345" for the string scorer
                    releaseName: subId.replace(/-/g, '.'),
                    // YTS has a highly predictable direct ZIP download URL structure
                    downloadUrl: `https://yifysubtitles.org/subtitle/${subId}.zip`,
                    source: 'YTS'
                });
            }
        }
        return candidates;
    } catch (e) { return []; }
}

async function fetchYtsCandidates({ imdbId, lang, season, episode, releaseTokens, limit = 10 }) {
    // YTS does not host TV shows. If season/episode are present, instantly abort.
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

// --- UNIVERSAL ZIP EXTRACTOR (Used by SubDL and YTS) ---
async function getZipSrt(zipUrl) {
    try {
        const res = await fetch(zipUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
        if (!res.ok) return null;
        const buffer = await res.arrayBuffer();
        const zip = new AdmZip(Buffer.from(buffer));
        const srtEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.srt'));
        if (!srtEntry) return null;
        return { text: decodeArabicFile(srtEntry.getData()) };
    } catch { return null; }
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
builder.defineSubtitlesHandler(async (args) => {
    const videoHash   = args.extra?.videoHash  ?? null;
    const streamName  = args.extra?.filename   ?? args.extra?.name ?? null;
    const idParts     = args.id.split(':');
    const imdbId      = idParts[0].replace('tt', '');
    const season      = idParts[1] ?? null;
    const episode     = idParts[2] ?? null;

    const releaseTokens = tokeniseRelease(streamName || '');

    console.log(`\n===========================================`);
    console.log(`[V17 Request] IMDb: ${imdbId} | S${season||'?'}E${episode||'?'} | Hash: ${videoHash||'none'}`);

    try {
        console.log(`\n[Step 1] Fetching English baseline...`);
        const engOsCandidates = await fetchOsCandidates({ lang: 'en', imdbId, season, episode, videoHash, releaseTokens, limit: 3 });
        const engSubdlCandidates = await fetchSubdlCandidates({ imdbId, lang: 'en', season, episode, releaseTokens, limit: 2 });
        const engYtsCandidates = await fetchYtsCandidates({ imdbId, lang: 'en', season, episode, releaseTokens, limit: 2 });

        let englishData = null;
        const allEngCandidates = [
             ...engOsCandidates.map(c => ({ ...c, _fetchFn: () => getOsSrt(c.fileId) })),
             ...engSubdlCandidates.map(c => ({ ...c, _fetchFn: () => getZipSrt(c.downloadUrl) })),
             ...engYtsCandidates.map(c => ({ ...c, _fetchFn: () => getZipSrt(c.downloadUrl) }))
        ];

        for (const c of allEngCandidates) {
            englishData = await c._fetchFn();
            if (englishData) {
                console.log(`✅ Baseline found via ${c.source}`);
                break;
            }
        }
        
        if (!englishData) return { subtitles: [] };

        console.log(`\n[Step 2] Fetching Top Arabic candidates from OS, SubDL, and YTS...`);
        const [arOsCandidates, arSubdlCandidates, arYtsCandidates] = await Promise.all([
            fetchOsCandidates({ lang: 'ar', imdbId, season, episode, videoHash, releaseTokens, limit: 8 }),
            fetchSubdlCandidates({ imdbId, lang: 'ar', season, episode, releaseTokens, limit: 8 }),
            fetchYtsCandidates({ imdbId, lang: 'ar', season, episode, releaseTokens, limit: 4 })
        ]);

        const allArabic = [
            ...arOsCandidates.map(c => ({ ...c, _fetchFn: () => getOsSrt(c.fileId) })),
            ...arSubdlCandidates.map(c => ({ ...c, _fetchFn: () => getZipSrt(c.downloadUrl) })),
            ...arYtsCandidates.map(c => ({ ...c, _fetchFn: () => getZipSrt(c.downloadUrl) }))
        ];

        console.log(`\n[Step 3] Tri-Core Scan of ${allArabic.length} candidates...`);

        let bestFallback = null;
        let successfulMatches = [];

        for (let i = 0; i < allArabic.length; i++) {
            const candidate = allArabic[i];
            console.log(`--> #${i + 1} ${candidate.source} | "${candidate.releaseName}"`);

            const arabicData = await candidate._fetchFn();
            if (!arabicData) continue;

            if (!bestFallback) bestFallback = { candidate: candidate, text: arabicData.text };

            const result = computePrecisionShift(englishData.text, arabicData.text, `#${i+1}`);

            if (result.passed) {
                successfulMatches.push({
                    candidate: candidate,
                    fixedText: result.fixedText,
                    offsetMs: result.offsetMs,
                    alignmentPct: result.alignmentPct,
                    driftMs: result.driftMs,
                    index: i + 1
                });
            }
        }

        if (successfulMatches.length > 0) {
            successfulMatches.sort((a, b) => b.alignmentPct - a.alignmentPct);
            
            const champion = successfulMatches[0];
            console.log(`\n🏆 [APEX CHAMPION] Candidate #${champion.index} (${champion.candidate.source}) won with ${champion.alignmentPct.toFixed(1)}% match!`);

            const cacheId = `elite_true_${Date.now()}.srt`;
            subtitleCache.set(cacheId, champion.fixedText);
            
            let offsetDisplay = champion.offsetMs > 0 ? `+${champion.offsetMs.toFixed(0)}` : `${champion.offsetMs.toFixed(0)}`;

            return {
                subtitles: [{
                    id: cacheId,
                    url: `${BASE_URL}/dl/${cacheId}`,
                    lang: "ara",
                    title: `[isSynced: True | ${champion.alignmentPct.toFixed(0)}%] Auto-Shifted (${offsetDisplay}ms) | Drift: ${champion.driftMs.toFixed(0)}ms\n[${champion.candidate.source}] ${champion.candidate.releaseName}`
                }]
            };
        }

        if (bestFallback) {
            console.log(`\n[Done] No passing candidate found. Serving fallback.`);
            const cacheId = `elite_false_${Date.now()}.srt`;
            subtitleCache.set(cacheId, bestFallback.text);
            return {
                subtitles: [{
                    id: cacheId, url: `${BASE_URL}/dl/${cacheId}`, lang: "ara",
                    title: `[isSynced: False] ⚠️ Unverified Fallback\n[${bestFallback.candidate.source}] ${bestFallback.candidate.releaseName}`
                }]
            };
        }

        return { subtitles: [] };

    } catch (error) {
        console.error("❌ Fatal:", error.message);
        return { subtitles: [] };
    }
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
    console.log(`🚀 Arabic Elite Engine V17 (Tri-Core) is LIVE`);
    console.log(`➡️  Add to Stremio: http://127.0.0.1:${PORT}/manifest.json`);
    console.log(`=========================================\n`);
});