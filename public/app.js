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
async function api(params) {
  const r = await fetch('/api/reddit?' + new URLSearchParams(params));
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j.error || 'Something went wrong (' + r.status + ').');
  return j;
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
