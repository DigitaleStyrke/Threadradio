// Reads public Reddit RSS/Atom feeds. No API keys, no login.
// Returns post lists (titles + links) and a post's comments.
const UA = 'web:thread-radio:1.0.0 (personal listening app)';

function fail(status, code) { const e = new Error(code); e.status = status; return e; }

// Small in-memory cache. Survives while the serverless instance stays warm,
// so repeat views of the same feed don't hit Reddit again.
const CACHE = new Map();
const CACHE_TTL = 120000; // 2 minutes
function cacheGet(url) {
  const hit = CACHE.get(url);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  if (hit) CACHE.delete(url);
  return null;
}
function cacheSet(url, v) {
  CACHE.set(url, { t: Date.now(), v });
  if (CACHE.size > 50) CACHE.delete(CACHE.keys().next().value);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reddit rate-limits by IP, and Vercel shares IPs, so 429/403 happen even
// with light use. Instead of failing, wait and retry a few times server-side.
async function getFeed(url) {
  const cached = cacheGet(url);
  if (cached) return cached;

  const mirrors = [url];
  if (url.includes('www.reddit.com')) mirrors.push(url.replace('www.reddit.com', 'old.reddit.com'));

  const waits = [600, 1500, 3000]; // backoff between attempts
  let lastErr = fail(502, 'reddit_down');

  for (let attempt = 0; attempt <= waits.length; attempt++) {
    const target = mirrors[attempt % mirrors.length];
    try {
      const r = await fetch(target, { headers: { 'User-Agent': UA, Accept: 'application/atom+xml, text/xml, */*' } });
      if (r.status === 429 || r.status === 403) {
        lastErr = fail(r.status, r.status === 429 ? 'rate_limited' : 'blocked');
        if (attempt < waits.length) { await sleep(waits[attempt]); continue; }
        throw lastErr;
      }
      if (r.status === 404) throw fail(404, 'not_found');
      if (!r.ok) {
        lastErr = fail(502, 'reddit_down');
        if (attempt < waits.length) { await sleep(waits[attempt]); continue; }
        throw lastErr;
      }
      const text = await r.text();
      if (!/<(feed|rss)[\s>]/i.test(text)) {
        if (/private|banned|quarantined/i.test(text)) throw fail(403, 'private');
        lastErr = fail(502, 'reddit_down');
        if (attempt < waits.length) { await sleep(waits[attempt]); continue; }
        throw lastErr;
      }
      cacheSet(url, text);
      return text;
    } catch (e) {
      if (e.status === 404 || e.message === 'private') throw e;
      lastErr = e.status ? e : fail(502, 'reddit_down');
      if (attempt < waits.length) { await sleep(waits[attempt]); continue; }
      throw lastErr;
    }
  }
  throw lastErr;
}

function decode(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
function stripTags(html) {
  return decode(html)
