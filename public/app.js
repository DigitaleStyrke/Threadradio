'use strict';
const $ = (s) => document.querySelector(s);

// ---------- settings ----------
const DEFAULTS = {
  sub: 'singularity',
  sort: 'hot',
  voice: 'en-US-AndrewMultilingualNeural',
  rate: 1,
  autoNext: true,
  readReplies: true,
  maxComments: 20,
};
const QUICK_SUBS = ['singularity', 'accelerate', 'OpenAI', 'LocalLLaMA', 'technology'];

function loadSettings() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('tr-settings') || '{}'));
  } catch {
    return Object.assign({}, DEFAULTS);
  }
}
function saveSettings() {
  try { localStorage.setItem('tr-settings', JSON.stringify(S)); } catch {}
}
const S = loadSettings();

// ---------- app state ----------
const state = {
  posts: [],
  postIndex: -1, // which post in the feed is open
  post: null,
  comments: [],
  view: 'feed',
  queue: [], // [{text, el, label}]
  idx: -1,
  mode: null, // 'titles' | 'post'
  playing: false,
  aiVoice: true,
};

// ---------- text cleanup ----------
function speakable(t) {
  return String(t || '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1') // markdown links
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/!\[gif\]\([^)]*\)/gi, ' gif ')
    .replace(/[*_~`>#^|]+/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function chunks(text, max = 900) {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
  const out = [];
  let cur = '';
  for (let s of sentences) {
    while (s.length > max) {
      const cut = s.lastIndexOf(' ', max) > 200 ? s.lastIndexOf(' ', max) : max;
      if (cur) { out.push(cur.trim()); cur = ''; }
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut);
    }
    if ((cur + s).length > max) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}
function shortNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

// ---------- API ----------
// ---------- Reddit (fetched by the phone, not the server) ----------
// Reddit blocks data-centre servers like Vercel, so the PHONE fetches the
// public RSS feed itself through a free CORS relay, and we parse it here.
// This makes the request look like it comes from a real device.

const RELAYS = [
  (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  (u) => 'https://thingproxy.freeboard.io/fetch/' + u,
];

const REDDIT_MSG = {
  blocked: 'Reddit is blocking the request right now. Wait a minute and try again.',
  private: 'That subreddit is private, banned, or quarantined.',
  not_found: 'Nothing found. Check the subreddit name or link.',
  rate_limited: 'Reddit says slow down. Wait a minute and try again.',
  reddit_down: 'Could not reach Reddit right now. Try again in a moment.',
  bad_link: 'That does not look like a Reddit post link.',
  bad_sub: 'Subreddit names use only letters, numbers and underscores.',
};
function rfail(code) { const e = new Error(REDDIT_MSG[code] || REDDIT_MSG.reddit_down); e.code = code; return e; }

const _rssCache = new Map();
async function fetchFeed(redditUrl) {
  const cached = _rssCache.get(redditUrl);
  if (cached && Date.now() - cached.t < 120000) return cached.v;

  let lastErr = rfail('reddit_down');
  for (const make of RELAYS) {
    try {
      const r = await fetch(make(redditUrl), { headers: { Accept: 'application/atom+xml, text/xml, */*' } });
      if (r.status === 404) throw rfail('not_found');
      if (r.status === 429) { lastErr = rfail('rate_limited'); continue; }
      if (r.status === 403) { lastErr = rfail('blocked'); continue; }
      if (!r.ok) { lastErr = rfail('reddit_down'); continue; }
      const text = await r.text();
      if (!/<(feed|rss)[\s>]/i.test(text)) {
        if (/private|banned|quarantined/i.test(text)) throw rfail('private');
        lastErr = rfail('reddit_down'); continue;
      }
      _rssCache.set(redditUrl, { t: Date.now(), v: text });
      if (_rssCache.size > 40) _rssCache.delete(_rssCache.keys().next().value);
      return text;
    } catch (e) {
      if (e.code === 'not_found' || e.code === 'private') throw e;
      lastErr = e.code ? e : rfail('reddit_down');
    }
  }
  throw lastErr;
}

function rDecode(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
function rStrip(html) {
  return rDecode(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n\u2022 ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function rTag(block, name) {
  const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i'));
  return m ? m[1] : '';
}
function rAttr(block, name, a) {
  const m = block.match(new RegExp('<' + name + '\\b[^>]*\\b' + a + '="([^"]+)"', 'i'));
  return m ? rDecode(m[1]) : '';
}
function rEntries(xml) { return xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []; }
function rPostId(link) { const m = (link || '').match(/\/comments\/([a-z0-9]+)/i); return m ? m[1] : ''; }

function rParse(xml) {
  return rEntries(xml).map((e) => {
    const link = rAttr(e, 'link', 'href') || rDecode(rTag(e, 'link'));
    const author = rStrip(rTag(e, 'name')).replace(/^\/u\//, '');
    return { id: rPostId(link), title: rDecode(rTag(e, 'title')).trim(), link, author, contentHtml: rTag(e, 'content') };
  });
}

async function redditSub(sub, sort) {
  const s = ['hot', 'new', 'top', 'rising'].includes(sort) ? sort : 'hot';
  const t = s === 'top' ? '?t=day&limit=30' : '?limit=30';
  const xml = await fetchFeed(`https://www.reddit.com/r/${sub}/${s}/.rss${t}`);
  const posts = rParse(xml).filter((p) => p.id).map((p) => ({ id: p.id, sub, title: p.title, author: p.author, link: p.link }));
  if (!posts.length) throw rfail('not_found');
  return { sub, sort: s, posts };
}

async function redditPost(id, sub) {
  const path = sub ? `/r/${sub}/comments/${id}/.rss` : `/comments/${id}/.rss`;
  const xml = await fetchFeed('https://www.reddit.com' + path + '?limit=50&sort=top');
  const es = rParse(xml);
  if (!es.length) throw rfail('not_found');
  const head = xml.split('<entry')[0];
  const postTitle = rDecode(rTag(head, 'title')).trim();
  const postEntry = es.find((e) => e.title && postTitle && e.title.trim() === postTitle.trim()) || es[0];
  const post = { id, sub: sub || '', title: postTitle || postEntry.title, author: postEntry.author || '', body: rStrip(postEntry.contentHtml).slice(0, 6000) };
  const comments = es.filter((e) => e !== postEntry)
    .map((e) => ({ id: e.id || '', author: e.author || 'someone', body: rStrip(e.contentHtml).slice(0, 5000), depth: 0 }))
    .filter((c) => c.body && c.body !== '[deleted]' && c.body !== '[removed]' && c.author !== 'AutoModerator')
    .slice(0, 60);
  return { post, comments };
}

async function redditResolveShare(link) {
  let u;
  try { u = new URL(link); } catch { throw rfail('bad_link'); }
  const h = u.hostname;
  if (!(h === 'redd.it' || h === 'reddit.com' || h.endsWith('.reddit.com'))) throw rfail('bad_link');
  let id = rPostId(u.pathname);
  if (id) return id;
  if (h === 'redd.it') { const m = u.pathname.match(/^\/([a-z0-9]+)/i); if (m) return m[1]; }
  throw rfail('bad_link');
}

async function api(params) {
  if (params.sub && !params.post && !params.link) {
    const sub = String(params.sub).replace(/^\/?r\//i, '').trim();
    if (!/^[A-Za-z0-9_]{2,21}$/.test(sub)) throw rfail('bad_sub');
    return redditSub(sub, params.sort);
  }
  if (params.post) {
    const id = String(params.post);
    if (!/^[a-z0-9]{2,12}$/i.test(id)) throw rfail('not_found');
    const sub = /^[A-Za-z0-9_]{2,21}$/.test(params.sub || '') ? params.sub : '';
    return redditPost(id, sub);
  }
  if (params.link) {
    return redditPost(await redditResolveShare(String(params.link)), '');
  }
  throw rfail('reddit_down');
}

// ---------- audio engine ----------
const audio = new Audio();
audio.preload = 'auto';
const audioCache = new Map(); // key text|voice -> Promise<objectURL>
let token = 0;

function ttsUrl(text) {
  const key = S.voice + '|' + text;
  if (!audioCache.has(key)) {
    const p = fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: S.voice }),
    })
      .then((r) => {
        if (!r.ok) throw new Error('tts');
        return r.blob();
      })
      .then((b) => {
        if (b.size < 500) throw new Error('tts');
        return URL.createObjectURL(b);
      });
    p.catch(() => audioCache.delete(key));
    audioCache.set(key, p);
    if (audioCache.size > 60) {
      const first = audioCache.keys().next().value;
      audioCache.get(first).then((u) => URL.revokeObjectURL(u)).catch(() => {});
      audioCache.delete(first);
    }
  }
  return audioCache.get(key);
}

let fallbackVoice = null;
function pickFallbackVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  const en = vs.filter((v) => /^en[-_]/i.test(v.lang));
  fallbackVoice =
    en.find((v) => /google/i.test(v.name) && /us/i.test(v.lang) && !v.localService) ||
    en.find((v) => /google/i.test(v.name)) ||
    en.find((v) => /natural|neural|enhanced|premium/i.test(v.name)) ||
    en[0] || null;
}
if (window.speechSynthesis) {
  pickFallbackVoice();
  speechSynthesis.onvoiceschanged = pickFallbackVoice;
}

function speakFallback(text, my, done) {
  if (!window.speechSynthesis) { done(); return; }
  const u = new SpeechSynthesisUtterance(text);
  if (fallbackVoice) { u.voice = fallbackVoice; u.lang = fallbackVoice.lang; } else u.lang = 'en-US';
  u.rate = S.rate;
  u.onend = () => { if (my === token) done(); };
  u.onerror = (e) => {
    if (my !== token) return;
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    done();
  };
  speechSynthesis.speak(u);
}

function stopSound() {
  token++;
  audio.pause();
  if (window.speechSynthesis) speechSynthesis.cancel();
}

function setVoiceTag() {
  const tag = $('#voiceTag');
  tag.textContent = state.aiVoice ? 'AI voice' : 'Backup voice';
  tag.classList.toggle('backup', !state.aiVoice);
}

async function playIndex(i) {
  stopSound();
  const my = token;
  if (i < 0) i = 0;
  if (i >= state.queue.length) { onQueueEnd(); return; }
  state.idx = i;
  state.playing = true;
  const seg = state.queue[i];
  highlight(seg);
  $('#nowText').textContent = seg.label;
  updateButtons();
  setMediaSession(seg);

  if (state.aiVoice) {
    try {
      const url = await ttsUrl(seg.text);
      if (my !== token) return;
      audio.src = url;
      audio.playbackRate = S.rate;
      audio.preservesPitch = true;
      await audio.play();
      // prefetch the next two pieces so there are no gaps
      for (let k = 1; k <= 2; k++) {
        const nxt = state.queue[i + k];
        if (nxt) ttsUrl(nxt.text).catch(() => {});
      }
      return;
    } catch (e) {
      if (my !== token) return;
      if (e && e.name === 'NotAllowedError') {
        // browser blocked autoplay: wait for a tap
        state.playing = false;
        updateButtons();
        return;
      }
      state.aiVoice = false;
      setVoiceTag();
    }
  }
  speakFallback(seg.text, my, () => playIndex(state.idx + 1));
}

audio.addEventListener('ended', () => {
  if (state.playing) playIndex(state.idx + 1);
});

function pause() {
  state.playing = false;
  token++;
  audio.pause();
  if (window.speechSynthesis) speechSynthesis.cancel();
  updateButtons();
}
function resume() {
  if (!state.queue.length) {
    if (state.view === 'feed') startTitles(0);
    else startPost(0);
    return;
  }
  if (state.aiVoice && audio.src && !audio.ended && audio.currentTime > 0 && state.queue[state.idx]) {
    state.playing = true;
    token++;
    const my = token;
    audio.play().catch(() => { if (my === token) playIndex(state.idx); });
    updateButtons();
  } else {
    playIndex(Math.max(state.idx, 0));
  }
}

function onQueueEnd() {
  state.playing = false;
  updateButtons();
  if (state.mode === 'post' && S.autoNext && state.postIndex >= 0 && state.postIndex < state.posts.length - 1) {
    openPost(state.postIndex + 1, true);
    return;
  }
  clearHighlight();
  $('#nowText').textContent = state.mode === 'titles' ? 'That was every title. Tap a post to hear its comments.' : 'Finished.';
}

function updateButtons() {
  $('#icPlay').hidden = state.playing;
  $('#icPause').hidden = !state.playing;
  $('#playBtn').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
}

function setMediaSession(seg) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: seg.label.slice(0, 120),
      artist: 'r/' + (state.post ? state.post.sub : S.sub),
      album: 'Thread Radio',
      artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch {}
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  set('play', () => resume());
  set('pause', () => pause());
  set('nexttrack', () => playIndex(state.idx + 1));
  set('previoustrack', () => playIndex(state.idx - 1));
}

// ---------- highlighting ----------
let lastEl = null;
function clearHighlight() {
  if (lastEl) lastEl.classList.remove('reading');
  lastEl = null;
}
function highlight(seg) {
  clearHighlight();
  if (seg.el && document.contains(seg.el)) {
    seg.el.classList.add('reading');
    lastEl = seg.el;
    const r = seg.el.getBoundingClientRect();
    if (r.top < 70 || r.bottom > window.innerHeight - 170) {
      seg.el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
}

// ---------- feed ----------
function renderQuickSubs() {
  const box = $('#quickSubs');
  box.textContent = '';
  for (const s of QUICK_SUBS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'r/' + s;
    b.classList.toggle('on', s.toLowerCase() === S.sub.toLowerCase());
    b.onclick = () => { $('#subInput').value = s; loadFeed(s); };
    box.appendChild(b);
  }
}
function renderSorts() {
  document.querySelectorAll('#sorts button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.sort === S.sort));
  });
}

async function loadFeed(sub) {
  sub = String(sub || '').replace(/^\/?r\//i, '').trim();
  if (!sub) return;
  S.sub = sub; saveSettings();
  renderQuickSubs();
  const msg = $('#feedMsg');
  msg.className = 'msg';
  msg.textContent = 'Loading r/' + sub + '…';
  $('#postList').textContent = '';
  $('#playTitlesBtn').disabled = true;
  try {
    const data = await api({ sub, sort: S.sort });
    state.posts = data.posts.filter((p) => !p.stickied);
    if (!state.posts.length) state.posts = data.posts;
    renderFeed();
    msg.textContent = state.posts.length ? '' : 'No posts here yet.';
    $('#playTitlesBtn').disabled = !state.posts.length;
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message;
  }
}

function renderFeed() {
  const list = $('#postList');
  list.textContent = '';
  state.posts.forEach((p, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const t = document.createElement('span');
    t.className = 'post-title';
    t.textContent = p.title;
    if (p.author) {
      const meta = document.createElement('span');
      meta.className = 'meta';
      const s = document.createElement('span'); s.textContent = 'u/' + p.author; meta.appendChild(s);
      b.append(t, meta);
    } else {
      b.append(t);
    }
    b.onclick = () => openPost(i, true);
    li.appendChild(b);
    p._el = b;
    list.appendChild(li);
  });
}

function startTitles(from) {
  state.mode = 'titles';
  state.queue = state.posts.map((p, i) => ({
    text: speakable(`${i + 1}. ${p.title}`),
    label: p.title,
    el: p._el,
  }));
  playIndex(from);
}

// ---------- post ----------
function describeKind(p) {
  return p.body ? '' : 'This post has no text — it may be an image, video, or link. Here are the comments.';
}

async function openPost(i, autoplay, linkData) {
  stopSound();
  state.playing = false;
  updateButtons();
  state.postIndex = i;
  showView('post');
  const art = $('#postArticle');
  art.textContent = '';
  $('#commentList').textContent = '';
  const pm = $('#postMsg');
  pm.className = 'msg';
  pm.textContent = 'Loading comments…';
  if (i >= 0 && state.posts[i]) {
    $('#heading').textContent = 'r/' + state.posts[i].sub;
  }
  try {
    const data = linkData || (await api({ post: state.posts[i].id, sub: state.posts[i].sub }));
    state.post = data.post;
    state.comments = data.comments.filter((c) => S.readReplies || c.depth === 0);
    let top = 0;
    state.comments = state.comments.filter((c) => {
      if (c.depth === 0) top++;
      return top <= S.maxComments;
    });
    renderPost();
    pm.textContent = state.comments.length ? '' : 'No comments yet.';
    if (autoplay) startPost(0);
  } catch (e) {
    pm.className = 'msg err';
    pm.textContent = e.message;
  }
}

function renderPost() {
  const p = state.post;
  $('#heading').textContent = 'r/' + p.sub;
  const art = $('#postArticle');
  art.textContent = '';
  const h = document.createElement('h2');
  h.className = 'article-title';
  h.textContent = p.title;
  if (p.author) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const s = document.createElement('span'); s.textContent = 'u/' + p.author; meta.appendChild(s);
    art.append(h, meta);
  } else {
    art.append(h);
  }
  p._titleEl = h;
  p._bodyEl = null;
  const bodyText = p.body || describeKind(p);
  if (bodyText) {
    const b = document.createElement('div');
    b.className = 'article-body';
    b.textContent = bodyText;
    art.appendChild(b);
    p._bodyEl = b;
  }
  const list = $('#commentList');
  list.textContent = '';
  state.comments.forEach((c, idx) => {
    const li = document.createElement('li');
    if (c.depth > 0) li.className = 'reply';
    const a = document.createElement('div');
    a.className = 'c-author';
    a.textContent = 'u/' + c.author;
    const b = document.createElement('div');
    b.className = 'c-body';
    b.textContent = c.body;
    li.append(a, b);
    li.onclick = () => startPost(null, idx);
    c._el = li;
    list.appendChild(li);
  });
  $('#commentsHeading').hidden = !state.comments.length;
}

function buildPostQueue() {
  const p = state.post;
  const q = [];
  q.push({ text: speakable(p.title), label: p.title, el: p._titleEl });
  const body = p.body ? speakable(p.body) : describeKind(p);
  if (body) for (const c of chunks(body)) q.push({ text: c, label: p.title, el: p._bodyEl });
  state.comments.forEach((c, idx) => {
    const intro = c.depth > 0 ? `Reply from ${c.author}. ` : `${c.author} says: `;
    const parts = chunks(speakable(c.body));
    parts.forEach((part, k) => {
      q.push({ text: (k === 0 ? intro : '') + part, label: c.body.slice(0, 160), el: c._el, commentIdx: idx });
    });
  });
  return q;
}

function startPost(from, commentIdx) {
  if (!state.post) return;
  state.mode = 'post';
  state.queue = buildPostQueue();
  let i = from || 0;
  if (commentIdx != null) {
    i = state.queue.findIndex((s) => s.commentIdx === commentIdx);
    if (i < 0) i = 0;
  }
  playIndex(i);
}

// ---------- views ----------
function showView(v) {
  state.view = v;
  $('#feedView').hidden = v !== 'feed';
  $('#postView').hidden = v !== 'post';
  $('#backBtn').hidden = v !== 'post';
  $('#nextPostBtn').hidden = !(v === 'post' && state.postIndex >= 0 && state.postIndex < state.posts.length - 1);
  if (v === 'feed') $('#heading').textContent = 'Thread Radio';
  window.scrollTo(0, 0);
}

$('#backBtn').onclick = () => {
  if (state.mode === 'post') { pause(); state.queue = []; state.idx = -1; }
  clearHighlight();
  showView('feed');
  if (!state.posts.length) loadFeed(S.sub);
};
$('#nextPostBtn').onclick = () => {
  if (state.postIndex < state.posts.length - 1) openPost(state.postIndex + 1, true);
};

// ---------- controls ----------
$('#playBtn').onclick = () => (state.playing ? pause() : resume());
$('#nextBtn').onclick = () => {
  if (!state.queue.length) return;
  // skip to the start of the next comment / title, not just the next chunk
  const cur = state.queue[state.idx];
  let i = state.idx + 1;
  while (cur && state.queue[i] && state.queue[i].el === cur.el) i++;
  playIndex(i);
};
$('#prevBtn').onclick = () => {
  if (!state.queue.length) return;
  const cur = state.queue[state.idx];
  let i = state.idx;
  while (i > 0 && cur && state.queue[i - 1].el === cur.el) i--; // start of this item
  if (i === state.idx || (state.aiVoice && audio.currentTime < 2)) {
    i = Math.max(0, i - 1);
    const prev = state.queue[i];
    while (i > 0 && prev && state.queue[i - 1].el === prev.el) i--;
  }
  playIndex(i);
};
$('#playTitlesBtn').onclick = () => startTitles(0);

$('#subForm').onsubmit = (e) => {
  e.preventDefault();
  $('#subInput').blur();
  loadFeed($('#subInput').value);
};
document.querySelectorAll('#sorts button').forEach((b) => {
  b.onclick = () => { S.sort = b.dataset.sort; saveSettings(); renderSorts(); loadFeed(S.sub); };
});

// ---------- settings dialog ----------
const dlg = $('#settings');
$('#settingsBtn').onclick = () => {
  $('#voiceSel').value = S.voice;
  $('#rateRange').value = S.rate;
  $('#rateOut').textContent = Number(S.rate).toFixed(1) + '×';
  $('#autoNext').checked = S.autoNext;
  $('#readReplies').checked = S.readReplies;
  $('#maxComments').value = String(S.maxComments);
  dlg.showModal();
};
$('#voiceSel').onchange = (e) => { S.voice = e.target.value; saveSettings(); };
$('#rateRange').oninput = (e) => {
  S.rate = Number(e.target.value);
  $('#rateOut').textContent = S.rate.toFixed(1) + '×';
  audio.playbackRate = S.rate;
  saveSettings();
};
$('#autoNext').onchange = (e) => { S.autoNext = e.target.checked; saveSettings(); };
$('#readReplies').onchange = (e) => { S.readReplies = e.target.checked; saveSettings(); };
$('#maxComments').onchange = (e) => { S.maxComments = Number(e.target.value); saveSettings(); };
$('#retryVoice').onclick = () => {
  state.aiVoice = true;
  setVoiceTag();
  dlg.close();
  if (state.queue.length) playIndex(Math.max(state.idx, 0));
};

// ---------- shared links (Share → Thread Radio from the Reddit app) ----------
function findRedditLink(params) {
  const all = [params.get('url'), params.get('text'), params.get('title')].filter(Boolean).join(' ');
  const m = all.match(/https?:\/\/[^\s]*(?:reddit\.com|redd\.it)[^\s]*/i);
  return m ? m[0] : null;
}

async function handleShare() {
  const params = new URLSearchParams(location.search);
  if (!params.has('url') && !params.has('text') && !params.has('title')) return false;
  history.replaceState(null, '', '/');
  const link = findRedditLink(params);
  if (!link) {
    showView('feed');
    $('#feedMsg').className = 'msg err';
    $('#feedMsg').textContent = 'That share did not include a Reddit link.';
    return false;
  }
  showView('post');
  state.postIndex = -1;
  $('#postMsg').className = 'msg';
  $('#postMsg').textContent = 'Opening the shared post…';
  try {
    const data = await api({ link });
    await openPost(-1, false, data);
    $('#nextPostBtn').hidden = true;
    // Try to start right away; if the phone blocks it, show a big button.
    state.mode = 'post';
    state.queue = buildPostQueue();
    try {
      const url = await ttsUrl(state.queue[0].text);
      audio.src = url;
      await audio.play();
      audio.pause();
      startPost(0);
    } catch {
      $('#shareStart').hidden = false;
    }
  } catch (e) {
    $('#postMsg').className = 'msg err';
    $('#postMsg').textContent = e.message;
  }
  return true;
}
$('#shareStartBtn').onclick = () => {
  $('#shareStart').hidden = true;
  startPost(0);
};

// ---------- start ----------
$('#subInput').value = S.sub;
renderQuickSubs();
renderSorts();
setVoiceTag();
handleShare().then((shared) => {
  if (!shared) { showView('feed'); loadFeed(S.sub); }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
