// Reads public Reddit RSS/Atom feeds. No API keys, no login.
// Returns post lists (titles + links) and a post's comments.
const UA = 'web:thread-radio:1.0.0 (personal listening app)';

function fail(status, code) { const e = new Error(code); e.status = status; return e; }

async function getFeed(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/atom+xml, text/xml, */*' } });
  if (r.status === 403) throw fail(403, 'blocked');
  if (r.status === 404) throw fail(404, 'not_found');
  if (r.status === 429) throw fail(429, 'rate_limited');
  if (!r.ok) throw fail(502, 'reddit_down');
  const text = await r.text();
  if (!/<(feed|rss)[\s>]/i.test(text)) {
    if (/private|banned|quarantined/i.test(text)) throw fail(403, 'private');
    throw fail(502, 'reddit_down');
  }
  return text;
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
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i'));
  return m ? m[1] : '';
}
function attr(block, name, a) {
  const m = block.match(new RegExp('<' + name + '\\b[^>]*\\b' + a + '="([^"]+)"', 'i'));
  return m ? decode(m[1]) : '';
}
function entries(xml) {
  return xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
}
function postIdFromLink(link) {
  const m = (link || '').match(/\/comments\/([a-z0-9]+)/i);
  return m ? m[1] : '';
}

function parseFeed(xml) {
  return entries(xml).map((e) => {
    const link = attr(e, 'link', 'href') || decode(tag(e, 'link'));
    const author = stripTags(tag(e, 'name')).replace(/^\/u\//, '');
    return {
      id: postIdFromLink(link),
      title: decode(tag(e, 'title')).trim(),
      link,
      author,
      contentHtml: tag(e, 'content'),
    };
  });
}

function isRedditHost(h) { return h === 'redd.it' || h === 'reddit.com' || h.endsWith('.reddit.com'); }

async function resolveShare(link) {
  let u;
  try { u = new URL(link); } catch { throw fail(400, 'bad_link'); }
  if (!isRedditHost(u.hostname)) throw fail(400, 'bad_link');
  let id = postIdFromLink(u.pathname);
  if (id) return id;
  if (u.hostname === 'redd.it') { const m = u.pathname.match(/^\/([a-z0-9]+)/i); if (m) return m[1]; }
  // /r/sub/s/XXsharelink -> follow redirect
  if (/\/s\/[A-Za-z0-9]+/.test(u.pathname)) {
    try {
      const r = await fetch('https://www.reddit.com' + u.pathname, { redirect: 'follow', headers: { 'User-Agent': UA } });
      id = postIdFromLink(r.url || '');
      if (id) return id;
      const loc = r.headers.get('location') || '';
      id = postIdFromLink(loc);
      if (id) return id;
    } catch {}
  }
  throw fail(400, 'bad_link');
}

async function loadPost(id, sub) {
  const path = sub ? `/r/${sub}/comments/${id}/.rss` : `/comments/${id}/.rss`;
  const xml = await getFeed('https://www.reddit.com' + path + '?limit=50&sort=top');
  const es = parseFeed(xml);
  if (!es.length) throw fail(404, 'not_found');
  // The feed's own <title> is the post title; first entry is the post, rest are comments.
  let postTitle = decode(tag(xml.match(/<feed[\s>][\s\S]*?<entry/i) ? xml.split('<entry')[0] : xml, 'title')).trim();
  const first = es[0];
  // Heuristic: the post entry shares the feed title; comments are replies.
  const postEntry = es.find((e) => e.title && postTitle && e.title.trim() === postTitle.trim()) || first;
  const post = {
    id,
    sub: sub || '',
    title: postTitle || postEntry.title,
    author: postEntry.author || '',
    body: stripTags(postEntry.contentHtml).slice(0, 6000),
  };
  const comments = es
    .filter((e) => e !== postEntry)
    .map((e) => ({ id: e.id || '', author: e.author || 'someone', body: stripTags(e.contentHtml).slice(0, 5000), depth: 0 }))
    .filter((c) => c.body && c.body !== '[deleted]' && c.body !== '[removed]' && c.author !== 'AutoModerator')
    .slice(0, 60);
  return { post, comments };
}

async function loadSub(sub, sort) {
  const s = ['hot', 'new', 'top', 'rising'].includes(sort) ? sort : 'hot';
  const t = s === 'top' ? '?t=day&limit=30' : '?limit=30';
  const xml = await getFeed(`https://www.reddit.com/r/${sub}/${s}/.rss${t}`);
  const posts = parseFeed(xml)
    .filter((p) => p.id)
    .map((p) => ({ id: p.id, sub, title: p.title, author: p.author, link: p.link }));
  return { sub, sort: s, posts };
}

const MESSAGES = {
  blocked: 'Reddit is blocking the request right now. Wait a minute and try again.',
  private: 'That subreddit is private, banned, or quarantined.',
  not_found: 'Nothing found. Check the subreddit name or link.',
  rate_limited: 'Reddit says slow down. Wait a minute and try again.',
  reddit_down: 'Reddit is not responding right now. Try again soon.',
  bad_link: 'That does not look like a Reddit post link.',
  bad_sub: 'Subreddit names use only letters, numbers and underscores.',
  bad_request: 'Missing subreddit or post.',
};

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    let result;
    if (q.link) {
      result = await loadPost(await resolveShare(String(q.link)), '');
    } else if (q.post) {
      const id = String(q.post);
      if (!/^[a-z0-9]{2,12}$/i.test(id)) throw fail(400, 'not_found');
      result = await loadPost(id, /^[A-Za-z0-9_]{2,21}$/.test(q.sub || '') ? q.sub : '');
    } else if (q.sub) {
      const sub = String(q.sub).replace(/^\/?r\//i, '').trim();
      if (!/^[A-Za-z0-9_]{2,21}$/.test(sub)) throw fail(400, 'bad_sub');
      result = await loadSub(sub, q.sort);
    } else {
      throw fail(400, 'bad_request');
    }
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json(result);
  } catch (e) {
    const code = e.message in MESSAGES ? e.message : 'reddit_down';
    res.status(e.status || 500).json({ error: MESSAGES[code], code });
  }
};
