'use strict';

/* ==========================================================
   Xブックマークビューア
   - 投稿(posts)とタグ(tags)は IndexedDB の別ストアで管理
   - メモリ上には軽量インデックスだけを持ち、表示中の最大20件だけ DOM 化する
   ========================================================== */
(() => {
  /* ---------------- 定数 ---------------- */
  const APP_VERSION = '6'; // sw.js の CACHE 名と合わせる。画面に表示して、古い版が動いていないか確認できるようにする
  const PAGE_SIZE = 20;
  const MAX_TAGS = 10;
  const MAX_TAG_LEN = 10;
  const IMPORT_CHUNK = 250;
  const SUGGEST_LIMIT = 300;
  const PICK_LIMIT = 100;
  const DB_NAME = 'xbm-viewer';
  const DB_VERSION = 1;
  const UNTAGGED_LABEL = 'タグ未設定'; // 内部状態の名前。ユーザータグとしては登録させない
  const SUG_MAX = 24;
  // 自動ズーム防止のため通常は拡大禁止。スマホでも「PC版サイト」と同じ大きさ感になるよう横幅を広く取る
  const VIEWPORT_FIXED = 'width=1060, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  const VIEWPORT_ZOOM = 'width=1060, maximum-scale=5, user-scalable=yes, viewport-fit=cover';
  const VIDEO_FAIL_MSG = '動画を再生できませんでした。「Xへ」から元の投稿でご確認ください。';

  /** タグマスター(JSON)のファイル。候補リストであり、投稿タグの保存先ではない */
  const MASTER_FILES = { works: 'data/works.json', attribute: 'data/attribute.json', costume: 'data/costume.json', situation: 'data/situation.json' };
  /** カテゴリ (高速タグ付与の工程順そのもの) */
  const CATS = [
    { key: 'work', label: '作品', long: '作品' },
    { key: 'char', label: 'キャラ', long: 'キャラクター' },
    { key: 'attr', label: '属性', long: '属性' },
    { key: 'costume', label: '衣装', long: '衣装' },
    { key: 'situ', label: 'シチュ', long: 'シチュ' },
  ];
  const CAT_SHORT = { work: '作品', char: 'キャラ', attr: '属性', costume: '衣装', situ: 'シチュ', used: '既存' };

  /* ---------------- 小さなユーティリティ ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);

  /** 要素生成。テキストは必ず textContent / Text ノード経由で入れる (XSS対策) */
  function h(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(children)) if (c != null) e.append(c);
    return e;
  }

  const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase();
  const tagKey = (s) => norm(s).trim();
  /** 検索・予測変換用: ひらがなをカタカナに寄せる (あすな → アスナ)。タグの同一判定(tagKey)には使わない */
  const foldKana = (s) => norm(s).replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const cpLen = (s) => [...s].length;
  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  /** タグ入力の分解。区切りはカンマ類・セミコロン・改行。先頭の # は除去 */
  const TAG_SEP = /[,，、;；\r\n]+/;
  function parseTagInput(raw) {
    return String(raw ?? '')
      .split(TAG_SEP)
      .map((s) => s.trim().replace(/^[#＃]+/, '').trim())
      .filter(Boolean);
  }

  /** 投稿日時 → epoch(ms)。解釈できなければ 0 */
  function parseTime(v) {
    if (v == null || v === '') return 0;
    const fromNum = (n) => (n < 1e11 ? n * 1000 : n);
    if (typeof v === 'number') return Number.isFinite(v) ? fromNum(v) : 0;
    const s = String(v).trim();
    if (/^\d{10,13}$/.test(s)) return fromNum(Number(s));
    let t = Date.parse(s);
    if (Number.isNaN(t)) t = Date.parse(s.replace(/\//g, '-').replace(' ', 'T'));
    if (Number.isNaN(t)) {
      const m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})(?:\D+(\d{1,2}):(\d{2}))?/);
      if (m) t = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime();
    }
    return Number.isNaN(t) ? 0 : t;
  }

  const dtf = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  function fmtDate(v) {
    const t = parseTime(v);
    return t ? dtf.format(t) : String(v ?? '');
  }

  /** http(s) のみ許可 (data:image はメディア用途に限り許可)。URL自体は加工しない */
  function safeUrl(v, allowData = false) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s) return null;
    if (allowData && /^data:image\//i.test(s)) return s;
    try {
      const u = new URL(s);
      return u.protocol === 'https:' || u.protocol === 'http:' ? s : null;
    } catch {
      return null;
    }
  }

  let toastTimer;
  function toast(msg, ms = 2800) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  /** タグ追加の検証 (通常のタグ編集・高速タグ付与で共通)。draft は変更しない */
  function validateAdd(draft, parts) {
    const keys = new Set(draft.map(tagKey));
    const added = [];
    const errs = [];
    for (const p of parts) {
      if (cpLen(p) > MAX_TAG_LEN) { errs.push(`「${p}」は${MAX_TAG_LEN}文字を超えています`); continue; }
      const k = tagKey(p);
      if (k === tagKey(UNTAGGED_LABEL)) { errs.push(`「${UNTAGGED_LABEL}」は使用できません`); continue; }
      if (keys.has(k)) { errs.push(`「${p}」は既に追加されています`); continue; }
      if (draft.length + added.length >= MAX_TAGS) { errs.push(`タグは1投稿につき最大${MAX_TAGS}個までです`); break; }
      keys.add(k);
      added.push(p);
    }
    return { added, errs };
  }

  /** 選択状態(aria-pressed)を data-key を持つボタンへ反映。再描画せずスクロール位置を保つ */
  function syncPressed(root, draft) {
    const keys = new Set(draft.map(tagKey));
    for (const b of root.querySelectorAll('[data-key]')) b.setAttribute('aria-pressed', String(keys.has(b.dataset.key)));
  }

  function catBadge(cat) {
    return h('span', { class: `cat cat-${cat}`, text: CAT_SHORT[cat] || '' });
  }

  /** 選択式の候補チップ。item = { key, label, name } */
  function pickChip(item, onclick, { badge = false, sub = null } = {}) {
    return h('button', {
      class: 'chip', type: 'button', dataset: { key: item.key }, 'aria-pressed': 'false',
      title: item.name && item.name !== item.label ? item.name : null, onclick,
    }, [badge ? catBadge(item.cat) : null, item.label, sub ? h('small', { text: sub }) : null]);
  }

  /** 確認ダイアログ (Promise<boolean>) */
  function askConfirm(msg, okLabel = 'OK', cancelLabel = 'キャンセル') {
    return new Promise((resolve) => {
      const d = $('#confirm-dialog');
      $('#confirm-msg').textContent = msg;
      $('#confirm-ok').textContent = okLabel;
      $('#confirm-cancel').textContent = cancelLabel;
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; resolve(v); if (d.open) d.close(); };
      $('#confirm-ok').onclick = () => finish(true);
      $('#confirm-cancel').onclick = () => finish(false);
      d.onclose = () => finish(false);
      d.showModal();
    });
  }

  /* ---------------- IndexedDB ---------------- */
  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB が利用できません')); return; }
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('posts')) d.createObjectStore('posts', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('tags')) d.createObjectStore('tags', { keyPath: 'postId' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('データベースが他のタブでロックされています'));
    });
  }

  const txDone = (tx) =>
    new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('トランザクションが中断されました'));
    });

  /* ---------------- メモリ上の状態 ---------------- */
  /** 軽量インデックス (新しい順)。本文やメディアURLは持たない */
  let index = [];
  /** postId → { tags: string[], keys: string[] }。タグが無い投稿は登録しない (= タグ未設定) */
  const tagMap = new Map();
  let tagCountsCache = null;
  /** 現在の検索結果 (id配列、表示順) */
  let view = { tagged: [], untagged: [] };

  const state = {
    search: { user: '', from: '', to: '', media: 'all', tags: [], mode: 'and' },
    sort: 'new',
    tab: 'tagged',
    page: 1,
  };

  function setTagEntry(postId, tags) {
    tagCountsCache = null;
    if (tags.length) tagMap.set(postId, { tags: [...tags], keys: tags.map(tagKey) });
    else tagMap.delete(postId);
  }

  async function loadTags() {
    tagMap.clear();
    const all = await new Promise((resolve, reject) => {
      const r = db.transaction('tags', 'readonly').objectStore('tags').getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    for (const rec of all) {
      if (rec && Array.isArray(rec.tags)) {
        setTagEntry(rec.postId, rec.tags.filter((t) => typeof t === 'string' && t));
      }
    }
  }

  function makeIndexEntry(p) {
    const u = p.user && typeof p.user === 'object' ? p.user : {};
    const m = p.media && typeof p.media === 'object' ? p.media : {};
    return {
      id: p.id,
      t: parseTime(p.postTime),
      u: norm(`${u.name ?? ''} ${u.id ?? ''}`),
      img: Array.isArray(m.images) ? m.images.length : 0,
      vid: Array.isArray(m.videos) ? m.videos.length : 0,
    };
  }

  async function buildIndex() {
    const out = [];
    await new Promise((resolve, reject) => {
      const cur = db.transaction('posts', 'readonly').objectStore('posts').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { resolve(); return; }
        try { out.push(makeIndexEntry(c.value)); } catch (e) { console.warn('index skip', e); }
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    out.sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : -1));
    return out;
  }

  /** 選択されたIDの投稿本体だけを取得 (最大20件) */
  function loadPosts(ids) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('posts', 'readonly');
      const st = tx.objectStore('posts');
      const out = new Array(ids.length);
      ids.forEach((id, i) => {
        const r = st.get(id);
        r.onsuccess = () => { out[i] = r.result; };
      });
      tx.oncomplete = () => resolve(out.filter(Boolean));
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /* ---------------- 検索・絞り込み・並び替え (データは変更しない) ---------------- */
  function computeView() {
    const s = state.search;
    const userQ = norm(s.user).trim();
    const from = s.from ? new Date(`${s.from}T00:00:00`).getTime() : null;
    const to = s.to ? new Date(`${s.to}T23:59:59.999`).getTime() : null;
    const wantKeys = s.tags.map(tagKey);
    const tagged = [];
    const untagged = [];

    for (const e of index) {
      if (userQ && !e.u.includes(userQ)) continue;
      if (from != null && e.t < from) continue;
      if (to != null && e.t > to) continue;
      if (s.media === 'image' && !e.img) continue;
      if (s.media === 'video' && !e.vid) continue;

      const entry = tagMap.get(e.id);
      if (wantKeys.length) {
        if (!entry) continue;
        const ok = s.mode === 'and'
          ? wantKeys.every((k) => entry.keys.includes(k))
          : wantKeys.some((k) => entry.keys.includes(k));
        if (!ok) continue;
      }
      (entry ? tagged : untagged).push(e.id);
    }

    if (state.sort === 'old') { tagged.reverse(); untagged.reverse(); }
    view = { tagged, untagged };
  }

  /* ---------------- 遅延読み込み ---------------- */
  let lazyQueue = [];
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const t = en.target;
          io.unobserve(t);
          if (t._load) t._load();
          // 横スクロール内の次の画像も先読みする
          const nx = t.nextElementSibling;
          if (nx && nx._load) nx._load();
        }
      }, { rootMargin: '800px 0px' })
    : null;

  function registerLazy(node, loadFn) {
    node._load = loadFn;
    lazyQueue.push(node);
  }

  /* ---------------- 描画 ---------------- */
  const listEl = $('#list');
  const emptyEl = $('#empty');
  let renderToken = 0;

  function updateTabs() {
    $('#tab-tagged .n').textContent = view.tagged.length;
    $('#tab-untagged .n').textContent = view.untagged.length;
    for (const b of document.querySelectorAll('.tab')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
    }
    if (state.tab !== 'quick') listEl.setAttribute('aria-labelledby', `tab-${state.tab}`);
  }

  function renderPagers(pages, total) {
    for (const c of [$('#pager-top'), $('#pager-bottom')]) {
      c.replaceChildren();
      if (!total) { c.hidden = true; continue; }
      c.hidden = false;
      const page = state.page;
      const btn = (label, aria, target, disabled) =>
        h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': aria, disabled, onclick: () => goPage(target) }, label);
      const sel = h('select', { 'aria-label': 'ページを選択', onchange: (e) => goPage(Number(e.target.value)) });
      for (let i = 1; i <= pages; i++) sel.append(h('option', { value: i, selected: i === page }, `${i}ページ`));
      c.append(
        btn('«', '最初のページ', 1, page <= 1),
        btn('‹', '前のページ', page - 1, page <= 1),
        sel,
        h('span', { class: 'pager-total', text: `/ ${pages}` }),
        btn('›', '次のページ', page + 1, page >= pages),
        btn('»', '最後のページ', pages, page >= pages),
      );
    }
  }

  function goPage(n) {
    state.page = n;
    render({ scroll: true });
  }

  /** 画面外に出た動画は一時停止、戻ってきたら(自動停止したものだけ)再開する */
  const visIO = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const en of entries) {
          const v = en.target;
          if (!v.isConnected) { visIO.unobserve(v); continue; }
          if (!en.isIntersecting) {
            if (!v.paused && !v.ended) { v._autoPaused = true; v.pause(); }
          } else if (v._autoPaused) {
            v._autoPaused = false;
            v.play().catch(() => {});
          }
        }
      }, { threshold: 0.15 })
    : { observe() {}, unobserve() {} };

  /** 表示中のDOMを破棄。読み込み中の画像・動画も止めてメモリを解放する */
  function teardownMedia(root) {
    for (const m of root.querySelectorAll('img, video')) {
      if (m.tagName === 'VIDEO') { visIO.unobserve(m); m.pause(); }
      m.removeAttribute('src');
      if (m.tagName === 'VIDEO') m.load();
    }
  }

  function teardownList() {
    if (io) io.disconnect();
    lazyQueue = [];
    teardownMedia(listEl);
    listEl.replaceChildren();
  }

  /** 1投稿だけ表示する画面(高速タグ付与)用。遅延読み込みを使わず即座に読み込む */
  function flushLazy() {
    const q = lazyQueue;
    lazyQueue = [];
    for (const n of q) if (n._load) n._load();
  }

  function showEmpty() {
    teardownList();
    const other = state.tab === 'tagged' ? 'untagged' : 'tagged';
    let hint = '';
    if (!index.length) hint = '右上の「JSONを読み込む」からブックマークのJSONを追加してください。';
    else if (!view.tagged.length && !view.untagged.length) hint = '条件に合う投稿がありません。検索条件を変えてみてください。';
    else if (view[other].length) hint = 'もう一方のタブに投稿があります。';
    $('#empty-hint').textContent = hint;
    emptyEl.hidden = false;
  }

  async function render({ scroll = false } = {}) {
    const token = ++renderToken;
    updateTabs();
    const quick = state.tab === 'quick';
    document.body.classList.toggle('quick-mode', quick);
    $('#quick').hidden = !quick;
    if (quick) {
      // 高速タグ付与は通常一覧とは別UI。一覧のDOMは破棄する
      teardownList();
      emptyEl.hidden = true;
      window.scrollTo(0, 0);
      if (!qs.active) startQuick(); else renderQuick(false);
      return;
    }
    const ids = view[state.tab];
    const total = ids.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), pages);
    updateTabs();
    renderPagers(pages, total);

    if (!total) { showEmpty(); return; }
    emptyEl.hidden = true;

    let posts;
    try {
      posts = await loadPosts(ids.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE));
    } catch (e) {
      console.error(e);
      toast('投稿の読み込みに失敗しました');
      return;
    }
    if (token !== renderToken) return; // より新しい描画要求が来ている

    teardownList();
    const frag = document.createDocumentFragment();
    for (const p of posts) {
      try {
        frag.append(buildCard(p));
      } catch (e) {
        // 1件の失敗で全体を止めない
        console.error('card error', p && p.id, e);
        frag.append(h('article', { class: 'card' }, h('p', { class: 'slide-msg', text: '投稿を表示できませんでした' })));
      }
    }
    listEl.append(frag);
    afterRender();
    if (scroll) $('#list-top').scrollIntoView({ block: 'start' });
  }

  function afterRender() {
    // 遅延読み込み対象を登録
    for (const n of lazyQueue) {
      if (io) io.observe(n); else if (n._load) n._load();
    }
    lazyQueue = [];
    // 本文が3行を超えるカードにだけ「続きを表示」を出す (読み取りを先にまとめてレイアウト再計算を最小化)
    const texts = [...listEl.querySelectorAll('.text.clamp')];
    const overflow = texts.map((t) => t.scrollHeight > t.clientHeight + 1);
    texts.forEach((t, i) => {
      if (overflow[i]) t.closest('.card').querySelector('.more').hidden = false;
    });
  }

  /* ---------------- 投稿カード ---------------- */
  function buildCard(p) {
    const u = p.user && typeof p.user === 'object' ? p.user : {};
    const card = h('article', { class: 'card', dataset: { id: p.id } });

    // ヘッダー
    const handle = u.id ? (String(u.id).startsWith('@') ? String(u.id) : `@${u.id}`) : '';
    const t = parseTime(p.postTime);
    card.append(
      h('header', { class: 'card-head' }, [
        buildAvatar(u),
        h('div', { class: 'who' }, [
          h('div', { class: 'who-line' }, [
            h('span', { class: 'name', text: u.name || '(名前なし)' }),
            h('span', { class: 'handle', text: handle }),
          ]),
          h('time', { class: 'when', datetime: t ? new Date(t).toISOString() : null, text: fmtDate(p.postTime) }),
        ]),
      ]),
    );

    // 本文 (初期は折りたたみ、タップで展開)
    if (p.text) {
      const text = h('p', { class: 'text clamp', text: String(p.text) });
      const more = h('button', { class: 'more', type: 'button', hidden: true, 'aria-expanded': 'false', text: '続きを表示' });
      const toggle = () => {
        const collapsed = text.classList.toggle('clamp');
        more.textContent = collapsed ? '続きを表示' : '閉じる';
        more.setAttribute('aria-expanded', String(!collapsed));
        if (!collapsed) more.hidden = false;
      };
      text.addEventListener('click', () => {
        if (String(window.getSelection && window.getSelection()).length) return; // 文字選択中は無視
        toggle();
      });
      more.addEventListener('click', toggle);
      card.append(h('div', { class: 'text-wrap' }, [text, more]));
    }

    // メディア
    const media = buildMedia(p);
    if (media) card.append(media);

    // タグ
    const tagsEl = h('div', { class: 'tags' });
    fillTags(tagsEl, tagMap.get(p.id)?.tags || []);
    card.append(tagsEl);

    // 操作
    const link = safeUrl(p.url);
    card.append(
      h('div', { class: 'actions' }, [
        h('button', { class: 'btn', type: 'button', onclick: () => openTagEditor(p) }, 'タグ編集'),
        link
          ? h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener noreferrer', 'aria-label': '元のX投稿を開く' }, [xIcon(), 'Xへ'])
          : h('span', { class: 'btn', 'aria-disabled': 'true' }, [xIcon(), 'Xへ']),
      ]),
    );
    return card;
  }

  function xIcon() {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z');
    s.append(p);
    return s;
  }

  function fillTags(container, tags) {
    container.replaceChildren();
    if (!tags.length) {
      container.append(h('span', { class: 'tag none', text: UNTAGGED_LABEL }));
      return;
    }
    for (const t of tags) container.append(h('span', { class: 'tag', text: t }));
  }

  function buildAvatar(u) {
    const initial = String(u.name || u.id || '?').trim().slice(0, 1) || '?';
    const wrap = h('div', { class: 'avatar', 'aria-hidden': 'true' }, h('span', { text: initial }));
    const url = safeUrl(u.icon, true);
    if (url) {
      const img = h('img', { alt: '', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' });
      img.addEventListener('error', () => { if (img.getAttribute('src')) img.remove(); });
      wrap.append(img);
      registerLazy(wrap, () => { if (!img.getAttribute('src')) img.src = url; });
    }
    return wrap;
  }

  function buildMedia(p) {
    const m = p.media && typeof p.media === 'object' ? p.media : {};
    const images = Array.isArray(m.images) ? m.images : [];
    const videos = Array.isArray(m.videos) ? m.videos : [];
    if (!images.length && !videos.length) return null;

    const zoom = []; // ライトボックス用 (有効な画像のみ・X上の順序を維持)
    const strip = h('div', {
      class: `strip${images.length + videos.length > 1 ? ' multi' : ''}`,
      tabindex: '0', role: 'group', 'aria-label': '添付メディア',
    });

    images.forEach((im, i) => {
      const url = safeUrl(im && im.url, true);
      let zi = -1;
      if (url) { zi = zoom.length; zoom.push({ url, postId: p.id, n: i }); }
      strip.append(buildImageSlide(url, i, zi, zoom));
    });
    videos.forEach((v, i) => strip.append(buildVideoSlide(v, i)));

    return h('div', { class: 'media' }, strip);
  }

  function failSlide(slide) {
    slide.classList.remove('loading');
    slide.classList.add('failed');
    slide.replaceChildren(h('p', { class: 'slide-msg', text: 'ファイルの読み込みに失敗しました' }));
  }

  function buildImageSlide(url, i, zi, zoom) {
    const slide = h('div', { class: 'slide slide-img loading' });
    if (!url) { failSlide(slide); return slide; }
    const img = h('img', { alt: `投稿画像 ${i + 1}`, decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' });
    img.addEventListener('load', () => slide.classList.remove('loading'));
    img.addEventListener('error', () => {
      if (!img.isConnected || !img.getAttribute('src')) return; // 破棄時の副作用は無視
      failSlide(slide);
    });
    img.addEventListener('click', () => openLightbox(zoom, zi));
    slide.append(img);
    registerLazy(slide, () => { if (!img.getAttribute('src')) img.src = url; });
    return slide;
  }

  const HLS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js';
  const MEDIA_ERR = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
  let hlsLoading = null;

  /** HLS(.m3u8) 用ライブラリを必要になったときだけ読み込む (mp4 には不要) */
  function loadHlsLib() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (!hlsLoading) {
      hlsLoading = new Promise((resolve, reject) => {
        const sc = h('script', { src: HLS_URL, async: true });
        sc.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('Hls not found')));
        sc.onerror = () => { hlsLoading = null; sc.remove(); reject(new Error('script load failed')); };
        document.head.append(sc);
      });
    }
    return hlsLoading;
  }

  /** 壊れやすい部分だけ補正 (HTMLエスケープ残り・httpsページでのhttp)。それ以外はURLをそのまま使う */
  function normalizeVideoUrl(u) {
    let x = u.replace(/&amp;/g, '&');
    if (location.protocol === 'https:' && /^http:\/\//i.test(x)) x = x.replace(/^http:/i, 'https:');
    return x;
  }

  const isHlsUrl = (u) => /\.m3u8(?:[?#]|$)/i.test(u);

  /**
   * 動画スライド。Xの動画URL (video.twimg.com の直接URL) をそのまま <video> に渡す。
   * - mp4: <video src> で再生。ネットワークエラーは1回だけ自動再試行
   * - m3u8(HLS): ネイティブ再生 → だめなら hls.js の順に自動で切り替え
   * - 失敗時: 原因(形式/エラーコード)と「動画を直接開く」リンクを表示。ポスターに戻るので再タップで再試行できる
   * - blob: は使わない / ユーザーのタップを起点に再生 / 他の動画は停止
   */
  function buildVideoSlide(v, i) {
    const rawSrc = safeUrl(v && v.url);
    const src = rawSrc ? normalizeVideoUrl(rawSrc) : null;
    const thumb = safeUrl(v && v.thumbnail, true);
    const slide = h('div', { class: 'slide slide-video loading' });

    const poster = h('button', {
      class: `poster${src ? '' : ' noplay'}`, type: 'button',
      'aria-label': src ? `動画${i + 1}を再生` : `動画${i + 1}（再生不可）`,
    });
    if (thumb) {
      // 動画サムネイルは通常の画像スライドとは別扱い (拡大対象にしない)
      const img = h('img', { alt: `動画${i + 1}のサムネイル`, decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' });
      img.addEventListener('load', () => slide.classList.remove('loading'));
      img.addEventListener('error', () => {
        if (!img.isConnected || !img.getAttribute('src')) return;
        img.remove();
        slide.classList.remove('loading');
        poster.append(h('span', { class: 'slide-msg', text: 'ファイルの読み込みに失敗しました' }));
      });
      poster.append(img);
      registerLazy(slide, () => { if (!img.getAttribute('src')) img.src = thumb; });
    } else {
      slide.classList.remove('loading');
      slide.style.minHeight = '160px';
    }
    if (src) poster.append(h('span', { class: 'play', 'aria-hidden': 'true' }));
    slide.append(poster);

    const clearNote = () => { const o = slide.querySelector('.video-note'); if (o) o.remove(); };
    const showNote = (detail) => {
      clearNote();
      slide.append(h('div', { class: 'video-note', role: 'status' }, [
        h('p', { text: VIDEO_FAIL_MSG }),
        detail ? h('small', { text: detail }) : null,
        src ? h('a', { class: 'video-open', href: src, target: '_blank', rel: 'noopener noreferrer', text: '動画を直接開く' }) : null,
      ]));
    };

    if (!src) { showNote(''); return slide; }

    const kind = isHlsUrl(src) ? 'HLS' : 'MP4';
    let video = null;
    let hls = null;
    let timer = 0;
    let plan = [];

    const destroy = () => {
      clearTimeout(timer);
      if (hls) { try { hls.destroy(); } catch { /* noop */ } hls = null; }
      if (video) {
        const dead = video;
        video = null;
        visIO.unobserve(dead);
        dead.pause();
        dead.removeAttribute('src');
        dead.load();
        dead.remove();
      }
    };

    const fail = (detail) => {
      destroy();
      slide.classList.remove('buffering');
      poster.hidden = false; // もう一度タップして再試行できる
      showNote(`形式: ${kind} / ${detail}`);
    };

    /** 失敗時: 次の手段が残っていれば自動で切り替え、無ければ失敗表示 */
    const onError = (detail) => {
      const next = plan.shift();
      if (next) { setTimeout(() => begin(next), next === 'retry' ? 500 : 0); return; }
      fail(detail);
    };

    const begin = (mode) => {
      destroy();
      clearNote();
      const vid = h('video', { controls: true, playsinline: true, 'webkit-playsinline': true, preload: 'auto', loop: true });
      vid.loop = true; // ネイティブループ (再読み込みなしで先頭へ戻るため最もシームレス)
      video = vid;
      if (thumb) vid.setAttribute('poster', thumb);
      slide.classList.add('buffering');

      vid.addEventListener('loadedmetadata', () => clearTimeout(timer));
      vid.addEventListener('canplay', () => slide.classList.remove('buffering'));
      vid.addEventListener('playing', () => slide.classList.remove('buffering'));
      vid.addEventListener('waiting', () => slide.classList.add('buffering'));
      vid.addEventListener('play', () => {
        for (const o of document.querySelectorAll('video')) if (o !== vid) o.pause(); // 他の動画は停止
      });
      // loop が効かない環境(一部のHLS等)向けの保険: 終了したら即座に先頭から再生
      vid.addEventListener('ended', () => { if (vid === video) { vid.currentTime = 0; vid.play().catch(() => {}); } });
      visIO.observe(vid); // 画面外に出たら一時停止して負荷を下げる
      vid.addEventListener('error', () => {
        if (vid !== video || !vid.isConnected) return; // 破棄時の副作用は無視
        const code = vid.error ? vid.error.code : 0;
        if (code === 1) return; // MEDIA_ERR_ABORTED (ユーザー操作・破棄)
        onError(`エラー: ${MEDIA_ERR[code] || code}`);
      });
      // メタデータすら取得できないまま長時間経った場合は失敗として扱う
      timer = setTimeout(() => { if (vid === video && vid.readyState === 0) onError('エラー: タイムアウト'); }, 30000);

      poster.hidden = true;
      slide.append(vid);
      for (const o of document.querySelectorAll('video')) if (o !== vid) o.pause();

      const tryPlay = () => {
        const pr = vid.play();
        if (pr && pr.catch) {
          pr.catch((err) => {
            if (vid !== video) return;
            const n = err && err.name;
            if (n === 'NotAllowedError') { slide.classList.remove('buffering'); return; } // コントロールから再生できる
            if (n === 'AbortError') return; // load()/pause() による中断
            onError(`エラー: ${n || 'play()失敗'}`);
          });
        }
      };

      if (mode === 'hls') {
        loadHlsLib().then((Hls) => {
          if (vid !== video) return;
          if (!Hls.isSupported()) throw new Error('この端末はHLS(MSE)非対応');
          const inst = new Hls({ enableWorker: true });
          hls = inst;
          inst.on(Hls.Events.ERROR, (_e, data) => {
            if (data && data.fatal && vid === video) onError(`HLS: ${data.type}/${data.details}`);
          });
          inst.on(Hls.Events.MANIFEST_PARSED, tryPlay);
          inst.loadSource(src);
          inst.attachMedia(vid);
        }).catch((e) => { if (vid === video) onError(`HLS: ${e && e.message ? e.message : e}`); });
      } else {
        vid.src = src; // video.twimg.com の直接URLをそのまま使う
        vid.load();
        tryPlay(); // タップ(ユーザー操作)の中で呼ぶ
      }
    };

    poster.addEventListener('click', () => {
      if (video) return; // 二重タップ防止
      if (kind === 'HLS') {
        const native = document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';
        plan = native ? ['hls'] : [];
        begin(native ? 'native' : 'hls');
      } else {
        plan = ['retry']; // ネットワークエラー等に備えて1回だけやり直す
        begin('native');
      }
    });
    return slide;
  }

  /* ---------------- ライトボックス ---------------- */
  const lbDlg = $('#lightbox');
  const lbImg = $('#lb-img');
  const lbMsg = $('#lb-msg');
  // postNav=true (通常一覧): 左右の大きいボタン = 前/次の「投稿」、画像の切替は上部の小さいボタン/スワイプ
  // postNav=false (高速タグ付与): 左右のボタン = 同じ投稿内の前/次の画像
  const lb = { items: [], i: 0, postNav: false, ids: [], idx: -1, startIdx: -1, postId: null, busy: false, cur: '' };

  /** 投稿から拡大表示できる画像(有効なURLのみ・X上の順序)を取り出す */
  function imageItems(p) {
    const m = p && p.media && typeof p.media === 'object' ? p.media : {};
    const out = [];
    (Array.isArray(m.images) ? m.images : []).forEach((im, n) => {
      const url = safeUrl(im && im.url, true);
      if (url) out.push({ url, postId: p.id, n });
    });
    return out;
  }

  function openLightbox(items, i) {
    if (!items.length || i < 0) return;
    lb.items = items;
    lb.i = i;
    lb.postId = items[0].postId;
    lb.postNav = state.tab !== 'quick';
    lb.ids = lb.postNav ? view[state.tab] : [];
    lb.idx = lb.postNav ? lb.ids.indexOf(lb.postId) : -1;
    if (lb.idx < 0) lb.postNav = false;
    lb.startIdx = lb.idx;
    lb.busy = false;
    setZoomAllowed(true); // 拡大表示中だけピンチ拡大を許可
    showLightbox();
    if (!lbDlg.open) lbDlg.showModal();
  }

  /** X の画像CDN(pbs.twimg.com)は name= でサイズが変わる。拡大表示では原寸(orig)を使う。失敗時は元URLに戻す */
  function bigUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'pbs.twimg.com' && u.pathname.startsWith('/media/')) {
        u.searchParams.set('name', 'orig');
        if (!u.searchParams.has('format') && !/\.[a-z0-9]{3,4}$/i.test(u.pathname)) u.searchParams.set('format', 'jpg');
        return u.toString();
      }
    } catch { /* data: URL など */ }
    return url;
  }

  function showLightbox() {
    const it = lb.items[lb.i];
    lbMsg.hidden = true;
    lbImg.hidden = false;
    lb.cur = bigUrl(it.url);
    lbImg.src = lb.cur;
    const multi = lb.items.length > 1;
    $('#lb-count').textContent = `画像 ${lb.i + 1} / ${lb.items.length}`;
    $('#lb-post').textContent = lb.postNav ? `投稿 ${lb.idx + 1} / ${lb.ids.length}` : '';
    $('#lb-imgnav').hidden = !(lb.postNav && multi);
    if (lb.postNav) {
      $('#lb-prev').hidden = lb.idx <= 0;
      $('#lb-next').hidden = lb.idx >= lb.ids.length - 1;
      $('#lb-prev').setAttribute('aria-label', '前の投稿');
      $('#lb-next').setAttribute('aria-label', '次の投稿');
    } else {
      $('#lb-prev').hidden = !multi;
      $('#lb-next').hidden = !multi;
      $('#lb-prev').setAttribute('aria-label', '前の画像');
      $('#lb-next').setAttribute('aria-label', '次の画像');
    }
  }

  /** 同じ投稿内の画像を前後に */
  function stepLightbox(d) {
    const n = lb.items.length;
    if (n < 2) return;
    lb.i = (lb.i + d + n) % n;
    showLightbox();
  }

  /** 前/次の投稿へ。画像の無い投稿(動画のみ等)は飛ばす。右ボタン = 次の投稿 */
  async function stepPost(d) {
    if (lb.busy || !lb.postNav) return;
    lb.busy = true;
    lbImg.classList.add('loading');
    try {
      let j = lb.idx;
      for (;;) {
        j += d;
        if (j < 0 || j >= lb.ids.length) { toast(d > 0 ? '最後の投稿です' : '最初の投稿です'); return; }
        const [p] = await loadPosts([lb.ids[j]]);
        if (!lbDlg.open) return;
        if (!p) continue;
        const items = imageItems(p);
        if (!items.length) continue;
        lb.items = items;
        lb.i = 0;
        lb.idx = j;
        lb.postId = p.id;
        showLightbox();
        return;
      }
    } catch (e) {
      console.error(e);
      toast('投稿の読み込みに失敗しました');
    } finally {
      lb.busy = false;
      lbImg.classList.remove('loading');
    }
  }

  /** 左右ボタン: 通常一覧では投稿、高速タグ付与では画像 */
  function stepSide(d) { if (lb.postNav) stepPost(d); else stepLightbox(d); }

  /** 拡大表示を閉じたとき、最後に見ていた投稿の位置まで一覧を移動する */
  async function revealPost(id, idx) {
    const page = Math.floor(idx / PAGE_SIZE) + 1;
    if (page !== state.page) {
      state.page = page;
      await render({ scroll: false });
    }
    const card = [...listEl.querySelectorAll('.card')].find((c) => c.dataset.id === id);
    if (card) card.scrollIntoView({ block: 'center' });
  }

  /** 通常は自動ズームを防ぐため拡大禁止。画像の拡大表示中だけピンチ拡大を許可 */
  function setZoomAllowed(on) {
    const vp = document.getElementById('vp');
    if (vp) vp.setAttribute('content', on ? VIEWPORT_ZOOM : VIEWPORT_FIXED);
  }

  function fileNameFor(item, mime) {
    let ext = '';
    try {
      const u = new URL(item.url);
      const last = u.pathname.split('/').filter(Boolean).pop() || '';
      const m = last.match(/\.([a-z0-9]{2,5})$/i);
      ext = (m ? m[1] : u.searchParams.get('format') || '').toLowerCase();
    } catch { /* data: URL など */ }
    if (!ext) ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[mime] || 'jpg';
    return `${item.postId}_${item.n + 1}.${ext}`.replace(/[\\/:*?"<>|]/g, '_');
  }

  async function saveCurrentImage() {
    const item = lb.items[lb.i];
    if (!item) return;
    try {
      const res = await fetch(lb.cur || item.url, { mode: 'cors', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = h('a', { href, download: fileNameFor(item, blob.type) });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 15000);
      toast('画像を保存しました');
    } catch (e) {
      // CORS等で直接取得できない場合は新しいタブで開く (長押し/右クリックで保存)
      console.warn('save fallback', e);
      const w = window.open(lb.cur || item.url, '_blank', 'noopener,noreferrer');
      toast(w ? '直接保存できなかったため、画像を新しいタブで開きました。長押しで保存できます' : '保存できませんでした。ポップアップを許可してください', 5000);
    }
  }

  function initLightbox() {
    lbImg.addEventListener('error', () => {
      if (!lbImg.getAttribute('src')) return;
      const orig = lb.items[lb.i] && lb.items[lb.i].url;
      if (orig && lb.cur !== orig) { lb.cur = orig; lbImg.src = orig; return; } // 原寸が取れなければ元のURLで再試行
      lbImg.hidden = true;
      lbMsg.hidden = false;
    });
    $('#lb-close').addEventListener('click', () => lbDlg.close());
    $('#lb-save').addEventListener('click', saveCurrentImage);
    $('#lb-prev').addEventListener('click', () => stepSide(-1));
    $('#lb-next').addEventListener('click', () => stepSide(1));
    $('#lb-iprev').addEventListener('click', () => stepLightbox(-1));
    $('#lb-inext').addEventListener('click', () => stepLightbox(1));
    lbDlg.addEventListener('close', () => {
      const moved = lb.postNav && lb.idx >= 0 && lb.idx !== lb.startIdx;
      const id = lb.postId;
      const idx = lb.idx;
      lbImg.removeAttribute('src');
      lbImg.classList.remove('loading');
      lb.items = [];
      lb.busy = false;
      setZoomAllowed(false);
      if (moved) revealPost(id, idx);
    });
    lbDlg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') stepSide(-1);
      else if (e.key === 'ArrowRight') stepSide(1);
    });
    const stage = $('#lb-stage');
    stage.addEventListener('click', (e) => { if (e.target === stage) lbDlg.close(); });
    // スワイプで前後 (拡大中は無効)
    let sx = 0, sy = 0, multi = false;
    stage.addEventListener('touchstart', (e) => {
      multi = e.touches.length > 1;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      const zoomed = window.visualViewport && window.visualViewport.scale > 1.02;
      if (multi || zoomed) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) stepLightbox(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  /* ---------------- タグマスター (JSON) ---------------- */
  /** JSONは「タグ候補」。読み込んでもIndexedDBのタグには一切触れない */
  const master = { ready: false, failed: [], works: [], attr: [], costume: [], situ: [], flat: [], byKey: new Map() };

  /** タグとして保存する文字列。10文字以内なら正式名。超える場合は別名 → 区切りで分けた最長の語 の順で短縮 */
  function shortLabel(name, aliases) {
    if (cpLen(name) <= MAX_TAG_LEN) return name;
    for (const a of aliases) if (a && cpLen(a) <= MAX_TAG_LEN) return a;
    const seg = name.split(/[：:・･/]/).map((x) => x.trim()).filter((x) => x && cpLen(x) <= MAX_TAG_LEN);
    if (seg.length) return seg.reduce((x, y) => (cpLen(y) > cpLen(x) ? y : x));
    return [...name].slice(0, MAX_TAG_LEN).join('');
  }

  function mkItem(raw, cat) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name ?? '').trim();
    if (!name) return null;
    const aliases = Array.isArray(raw.aliases) ? raw.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
    const label = shortLabel(name, aliases);
    const key = tagKey(label);
    if (!key || key === tagKey(UNTAGGED_LABEL)) return null;
    return { id: String(raw.id ?? name), name, aliases, label, key, cat, hay: foldKana([label, name, ...aliases].join(' ')) };
  }

  /** attribute.json の「ツノ」は id と name が入れ替わっているため補正する */
  function fixAttributeRaw(raw) {
    if (raw && raw.name === 'horns') return { ...raw, id: 'horns', name: 'ツノ' };
    return raw;
  }

  function buildMaster(data) {
    master.works = []; master.attr = []; master.costume = []; master.situ = [];
    master.flat = []; master.byKey = new Map();
    const add = (it) => { master.flat.push(it); if (!master.byKey.has(it.key)) master.byKey.set(it.key, it); };
    const simple = (json, cat, out, fix) => {
      if (!json) return;
      const seen = new Set();
      for (const raw of json.items) {
        const it = mkItem(fix ? fix(raw) : raw, cat);
        if (!it || seen.has(it.key)) continue;
        seen.add(it.key);
        out.push(it);
        add(it);
      }
    };
    if (data.works) {
      const seenW = new Set();
      for (const raw of data.works.items) {
        const w = mkItem(raw, 'work');
        if (!w || seenW.has(w.key)) continue;
        seenW.add(w.key);
        w.chars = [];
        // characters が無い / 空の作品 (オリジナル等) はキャラクター工程の対象外
        const seenC = new Set();
        for (const c of Array.isArray(raw.characters) ? raw.characters : []) {
          const ci = mkItem(c, 'char');
          if (!ci || seenC.has(ci.key)) continue; // 同一作品内の同名キャラは1つにまとめる
          seenC.add(ci.key);
          ci.work = w.label;
          w.chars.push(ci);
        }
        master.works.push(w);
      }
      for (const w of master.works) add(w);
      for (const w of master.works) for (const c of w.chars) add(c);
    }
    simple(data.attribute, 'attr', master.attr, fixAttributeRaw);
    simple(data.costume, 'costume', master.costume);
    simple(data.situation, 'situ', master.situ);
    master.ready = master.flat.length > 0;
  }

  async function fetchJson(file) {
    const r = await fetch(file, { cache: 'no-cache' }); // 更新したJSONが古いまま使われないように
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  /** 失敗しても例外を投げない。IndexedDBには一切触れない */
  async function loadMaster() {
    const data = {};
    const failed = [];
    await Promise.all(Object.entries(MASTER_FILES).map(async ([k, f]) => {
      try {
        const j = await fetchJson(f);
        if (!j || !Array.isArray(j.items)) throw new Error('items 配列がありません');
        data[k] = j;
      } catch (e) {
        console.warn('master load failed', f, e);
        failed.push(f);
      }
    }));
    try { buildMaster(data); } catch (e) { console.error(e); buildMaster({}); failed.push('(解析エラー)'); }
    master.failed = failed.sort();
    renderMasterNote();
    if (qs.active) renderQuick(false);
  }

  function renderMasterNote() {
    const el = $('#master-note');
    el.replaceChildren();
    el.hidden = !master.failed.length;
    if (!master.failed.length) return;
    el.append(
      h('span', { text: `タグ候補JSON（${master.failed.join('、')}）を読み込めませんでした。手動でのタグ入力は利用できます。` }),
      h('button', { class: 'btn', type: 'button', onclick: () => loadMaster() }, '再読み込み'),
    );
  }

  /* ---------------- タグ編集 ---------------- */
  const tagDlg = $('#tag-dialog');
  const ed = { postId: null, draft: [], all: [], filter: '' };

  function tagCounts() {
    if (tagCountsCache) return tagCountsCache;
    const c = new Map();
    for (const { tags } of tagMap.values()) for (const t of tags) c.set(t, (c.get(t) || 0) + 1);
    tagCountsCache = [...c.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ja'));
    const byKey = new Map();
    for (const { tag, count } of tagCountsCache) byKey.set(tagKey(tag), (byKey.get(tagKey(tag)) || 0) + count);
    tagCountsCache.byKey = byKey;
    return tagCountsCache;
  }

  function setEditorError(msg) {
    const e = $('#tag-error');
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  function openTagEditor(post) {
    ed.postId = post.id;
    ed.draft = [...(tagMap.get(post.id)?.tags || [])];
    ed.all = tagCounts();
    ed.filter = '';
    $('#tag-input').value = '';
    $('#tag-filter').value = '';
    setEditorError('');
    const u = post.user || {};
    const snippet = String(post.text || '').replace(/\s+/g, ' ').slice(0, 40);
    $('#tag-post-hint').textContent = `${u.name || ''} ${u.id || ''}${snippet ? ` / ${snippet}` : ''}`.trim();
    renderPicker();
    renderUsed();
    renderEditor();
    tagDlg.showModal();
  }

  /** 現在のタグ・カウンタ・選択状態だけを更新 (候補一覧は作り直さない) */
  function renderEditor() {
    const cur = $('#tag-current');
    cur.replaceChildren();
    if (!ed.draft.length) {
      cur.append(h('p', { class: 'chip-empty', text: 'タグ未設定（タグを追加すると「タグ設定済」に移動します）' }));
    }
    for (const t of ed.draft) {
      cur.append(
        h('button', {
          class: 'chip', type: 'button', 'aria-label': `${t} を削除`,
          onclick: () => { ed.draft = ed.draft.filter((x) => x !== t); setEditorError(''); renderEditor(); },
        }, [t, h('span', { class: 'x', 'aria-hidden': 'true', text: '×' })]),
      );
    }
    $('#tag-counter').textContent = `${ed.draft.length} / ${MAX_TAGS}`;
    syncPressed(tagDlg, ed.draft);
  }

  function toggleEd(label) {
    const k = tagKey(label);
    if (ed.draft.some((x) => tagKey(x) === k)) {
      ed.draft = ed.draft.filter((x) => tagKey(x) !== k);
      setEditorError('');
      renderEditor();
    } else {
      addToDraft([label]);
    }
  }

  /** JSONマスターからの候補 (カテゴリ別・折りたたみ)。中身は開いたときに初めて作る */
  function renderPicker() {
    const box = $('#tag-master');
    box.replaceChildren();
    if (!master.ready) {
      box.append(h('p', { class: 'chip-empty', text: master.failed.length ? 'タグ候補JSONを読み込めていません。手動入力は利用できます。' : 'タグ候補を読み込み中です…' }));
      return;
    }
    const q = foldKana(ed.filter).trim();
    if (q) {
      const list = master.flat.filter((it) => it.hay.includes(q)).slice(0, PICK_LIMIT);
      if (!list.length) box.append(h('p', { class: 'chip-empty', text: '該当する候補がありません' }));
      const row = h('div', { class: 'chip-row' });
      for (const it of list) row.append(pickChip(it, () => toggleEd(it.label), { badge: true, sub: it.cat === 'char' ? it.work : null }));
      box.append(row);
      syncPressed(box, ed.draft);
      return;
    }
    for (const cat of CATS) {
      const sec = pickSection(cat);
      if (sec) box.append(sec);
    }
  }

  function lazyDetails(summaryChildren, cls, fillFn, openNow) {
    const det = h('details', { class: cls }, h('summary', {}, summaryChildren));
    let filled = false;
    const fill = () => {
      if (filled) return;
      filled = true;
      const body = h('div', { class: 'pick-body' });
      fillFn(body);
      det.append(body);
      syncPressed(body, ed.draft);
    };
    det.addEventListener('toggle', () => { if (det.open) fill(); });
    if (openNow) { det.open = true; fill(); }
    return det;
  }

  function chipRow(items) {
    const row = h('div', { class: 'chip-row' });
    for (const it of items) row.append(pickChip(it, () => toggleEd(it.label)));
    return row;
  }

  function pickSection(cat) {
    if (cat.key === 'char') {
      const total = master.works.reduce((n, w) => n + w.chars.length, 0);
      if (!total) return null;
      return lazyDetails([cat.long, h('small', { text: total })], 'pick-sec', (body) => {
        for (const w of master.works) {
          if (!w.chars.length) continue;
          body.append(lazyDetails([w.label, h('small', { text: w.chars.length })], 'pick-sub', (b) => b.append(chipRow(w.chars)), false));
        }
      }, false);
    }
    const items = cat.key === 'work' ? master.works : master[cat.key];
    if (!items.length) return null;
    return lazyDetails([cat.long, h('small', { text: items.length })], 'pick-sec', (body) => body.append(chipRow(items)), cat.key === 'work');
  }

  /** 使用済みタグ (JSONに無い手動タグなど)。JSONにあるタグは上の候補側に出す */
  function renderUsed() {
    const box = $('#tag-existing');
    box.replaceChildren();
    const q = foldKana(ed.filter).trim();
    const list = ed.all.filter((x) => !master.byKey.has(tagKey(x.tag)) && (!q || foldKana(x.tag).includes(q))).slice(0, PICK_LIMIT);
    if (!list.length) box.append(h('p', { class: 'chip-empty', text: ed.all.length ? '該当するタグがありません' : 'まだタグがありません' }));
    for (const { tag, count } of list) box.append(pickChip({ key: tagKey(tag), label: tag, name: tag }, () => toggleEd(tag), { sub: String(count) }));
    syncPressed(box, ed.draft);
  }

  /** 検証しながら下書きに追加。input は入力文字列、またはタグ名の配列(区切り解釈なし)。追加できたら true */
  function addToDraft(input) {
    const parts = Array.isArray(input) ? input : parseTagInput(input);
    if (!parts.length) {
      setEditorError('タグを入力してください（空白や区切り文字だけは登録できません）');
      return false;
    }
    const { added, errs } = validateAdd(ed.draft, parts);
    ed.draft.push(...added);
    setEditorError(errs.join(' / '));
    renderEditor();
    return added.length > 0 && !errs.length;
  }

  async function commitTags(postId, tags) {
    const tx = db.transaction('tags', 'readwrite');
    const st = tx.objectStore('tags');
    if (tags.length) st.put({ postId, tags: [...tags], updatedAt: Date.now() });
    else st.delete(postId); // タグ0件 = 「タグ未設定」(レコード無し)
    await txDone(tx);
    const hadTags = tagMap.has(postId);
    setTagEntry(postId, tags);
    return hadTags;
  }

  async function saveEditor() {
    const postId = ed.postId;
    const before = tagMap.get(postId)?.tags || [];
    if (before.length === ed.draft.length && before.every((t, i) => t === ed.draft[i])) {
      tagDlg.close();
      return;
    }
    try {
      const hadTags = await commitTags(postId, ed.draft);
      tagDlg.close();
      afterTagChange(postId, hadTags, ed.draft.length > 0);
      toast('タグを保存しました');
    } catch (e) {
      console.error(e);
      setEditorError('保存に失敗しました。保存領域の空き容量を確認してください。');
    }
  }

  /** そのタグが付いている投稿数 */
  const countOf = (label) => tagCounts().byKey.get(tagKey(label)) || 0;

  /** タグの増減後に検索候補・付与済みタグ一覧を更新 */
  function refreshTagSuggest() {
    if (sugOpen) renderSearchSuggest();
    renderTagAll();
  }

  function afterTagChange(postId, hadTags, hasTags) {
    computeView();
    refreshTagSuggest();
    const moved = hadTags !== hasTags;
    if (moved || state.search.tags.length) {
      render(); // 他タブへ移動 / タグ検索結果が変わる場合は再描画
      if (moved) toast(hasTags ? 'タグ設定済に移動しました' : 'タグ未設定に移動しました');
    } else {
      // 同じタブ内の変更はカードのタグ表示だけ更新 (展開状態やスクロール位置を保つ)
      for (const c of listEl.querySelectorAll('.card')) {
        if (c.dataset.id === postId) fillTags(c.querySelector('.tags'), tagMap.get(postId)?.tags || []);
      }
      updateTabs();
    }
  }

  function initTagEditor() {
    const input = $('#tag-input');
    const add = () => { if (addToDraft(input.value)) input.value = ''; };
    $('#tag-add').addEventListener('click', add);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); add(); }
    });
    $('#tag-filter').addEventListener('input', debounce((e) => {
      ed.filter = e.target.value;
      renderPicker();
      renderUsed();
    }, 120));
    $('#tag-cancel').addEventListener('click', () => tagDlg.close());
    $('#tag-save').addEventListener('click', saveEditor);
  }

  /* ---------------- 検索UI ---------------- */
  function updateBadge() {
    const s = state.search;
    let n = 0;
    if (s.user.trim()) n++;
    if (s.from || s.to) n++;
    if (s.media !== 'all') n++;
    if (s.tags.length) n++;
    const b = $('#filter-badge');
    b.hidden = !n;
    b.textContent = n;
  }

  function readSearchUI() {
    const s = state.search;
    s.user = $('#s-user').value;
    s.from = $('#s-from').value;
    s.to = $('#s-to').value;
    s.media = $('input[name="media"]:checked').value;
    s.mode = $('input[name="tagmode"]:checked').value;
  }

  function applySearch() {
    readSearchUI();
    state.page = 1;
    computeView();
    updateBadge();
    render();
  }

  function renderSearchTagChips() {
    const box = $('#s-tag-chips');
    box.replaceChildren();
    for (const t of state.search.tags) {
      const it = master.byKey.get(tagKey(t));
      box.append(
        h('button', {
          class: 'chip', type: 'button', 'aria-label': `${t} を条件から外す`,
          onclick: () => { state.search.tags = state.search.tags.filter((x) => x !== t); renderSearchTagChips(); applySearch(); },
        }, [it ? catBadge(it.cat) : null, t, h('span', { class: 'x', 'aria-hidden': 'true', text: '×' })]),
      );
    }
    syncPressed($('#s-tag-all-list'), state.search.tags);
  }

  /* ---- 検索のタグ候補 (JSONマスター + 使用済みタグ。カテゴリ表示つき) ---- */
  let sugOpen = false;

  function suggestTags(q) {
    const nq = foldKana(q).trim();
    const out = [];
    const seen = new Set();
    const push = (tag, cat, sub) => {
      const k = tagKey(tag);
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ tag, cat, sub });
    };
    if (nq) {
      const first = [];
      const rest = [];
      for (const it of master.flat) {
        if (!it.hay.includes(nq)) continue;
        (it.hay.startsWith(nq) ? first : rest).push(it);
      }
      for (const it of first.concat(rest)) {
        push(it.label, it.cat, it.cat === 'char' ? it.work : '');
        if (out.length >= SUG_MAX) break;
      }
      for (const { tag } of tagCounts()) {
        if (out.length >= SUG_MAX + 6) break;
        if (!master.byKey.has(tagKey(tag)) && foldKana(tag).includes(nq)) push(tag, 'used', '');
      }
    } else {
      for (const { tag } of tagCounts().slice(0, 12)) {
        const it = master.byKey.get(tagKey(tag));
        push(tag, it ? it.cat : 'used', it && it.cat === 'char' ? it.work : '');
      }
    }
    return out;
  }

  function renderSearchSuggest() {
    const box = $('#s-tag-suggest');
    box.replaceChildren();
    const chosen = new Set(state.search.tags.map(tagKey));
    const list = sugOpen ? suggestTags($('#s-tag').value).filter((x) => !chosen.has(tagKey(x.tag))) : [];
    box.hidden = !list.length;
    for (const x of list) {
      box.append(
        h('button', {
          class: 'chip', type: 'button',
          onclick: () => { addSearchTags(x.tag); $('#s-tag').value = ''; renderSearchSuggest(); },
        }, [catBadge(x.cat), x.tag, x.sub ? h('small', { text: x.sub }) : null, h('span', { class: 'cnt', text: `${countOf(x.tag)}件` })]),
      );
    }
  }

  /** 付与済みタグの一覧と、そのタグが付いた投稿数。カテゴリごとに分け、各カテゴリ内は件数の多い順。開いているときだけ描画 */
  function renderTagAll() {
    const det = $('#s-tag-all');
    const all = tagCounts();
    $('#s-tag-all-n').textContent = String(all.length);
    if (!det.open) return;
    const box = $('#s-tag-all-list');
    box.replaceChildren();
    const q = foldKana($('#s-tag').value).trim();
    const list = q ? all.filter((x) => foldKana(x.tag).includes(q)) : all;
    if (!list.length) box.append(h('p', { class: 'chip-empty', text: all.length ? '該当するタグがありません' : 'まだタグが付与されていません' }));

    // all は件数の多い順なので、振り分けても各グループ内の順序は保たれる
    const groups = new Map([...CATS.map((c) => [c.key, []]), ['used', []]]);
    for (const x of list) {
      const it = master.byKey.get(tagKey(x.tag));
      groups.get(it ? it.cat : 'used').push({ ...x, it });
    }
    const titles = { used: 'その他（手動タグ）' };
    for (const c of CATS) titles[c.key] = c.long;

    let shown = 0;
    const LIMIT = 600;
    for (const [cat, items] of groups) {
      if (!items.length || shown >= LIMIT) continue;
      box.append(h('h4', { class: 'tag-group', text: `${titles[cat]}（${items.length}）` }));
      for (const { tag, count, it } of items) {
        if (shown >= LIMIT) break;
        shown++;
        box.append(
          h('button', {
            class: 'chip', type: 'button', dataset: { key: tagKey(tag) }, 'aria-pressed': 'false',
            onclick: () => {
              if (state.search.tags.some((t) => tagKey(t) === tagKey(tag))) {
                state.search.tags = state.search.tags.filter((t) => tagKey(t) !== tagKey(tag));
                renderSearchTagChips();
                applySearch();
              } else {
                addSearchTags(tag);
              }
            },
          }, [it ? catBadge(it.cat) : null, tag, h('span', { class: 'cnt', text: `${count}件` })]),
        );
      }
    }
    if (list.length > LIMIT) box.append(h('p', { class: 'chip-empty', text: `ほか ${list.length - LIMIT} 件（入力で絞り込めます）` }));
    syncPressed(box, state.search.tags);
  }

  function addSearchTags(raw) {
    const keys = new Set(state.search.tags.map(tagKey));
    let changed = false;
    for (const p of parseTagInput(raw)) {
      const k = tagKey(p);
      if (keys.has(k)) continue;
      keys.add(k);
      state.search.tags.push(p);
      changed = true;
    }
    if (changed) { renderSearchTagChips(); applySearch(); }
  }

  function initSearch() {
    const form = $('#search-form');
    form.addEventListener('submit', (e) => e.preventDefault());
    const debounced = debounce(applySearch, 250);
    // ユーザー名は入力に合わせてデバウンス検索、日付・メディア・AND/ORは変更時に即反映
    form.addEventListener('input', (e) => { if (e.target.id === 's-user') debounced(); });
    form.addEventListener('change', (e) => {
      if (e.target.id !== 's-tag' && e.target.id !== 's-user') applySearch();
    });

    const tagInput = $('#s-tag');
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        addSearchTags(tagInput.value);
        tagInput.value = '';
      }
    });
    tagInput.addEventListener('input', (e) => {
      if (!e.isComposing && /[,，、]/.test(tagInput.value)) { addSearchTags(tagInput.value); tagInput.value = ''; }
      sugOpen = true;
      renderSearchSuggest();
      renderTagAll();
    });
    $('#s-tag-all').addEventListener('toggle', renderTagAll);
    tagInput.addEventListener('focus', () => { sugOpen = true; renderSearchSuggest(); });
    // 候補チップのタップで入力欄がblurしても、途中の文字列が勝手にタグ化されないよう少し待つ
    tagInput.addEventListener('change', () => {
      setTimeout(() => {
        if (tagInput.value.trim()) { addSearchTags(tagInput.value); tagInput.value = ''; renderSearchSuggest(); }
      }, 250);
    });
    document.addEventListener('pointerdown', (e) => {
      if (sugOpen && !e.target.closest('#s-tag-field')) { sugOpen = false; renderSearchSuggest(); }
    });

    $('#btn-reset').addEventListener('click', () => {
      form.reset();
      state.search.tags = [];
      renderSearchTagChips();
      applySearch();
      renderSearchSuggest();
    });

    // 並び替え (検索エリアとは独立)
    for (const r of document.querySelectorAll('input[name="sort"]')) {
      r.addEventListener('change', () => {
        state.sort = r.value;
        state.page = 1;
        computeView();
        render();
      });
    }

    for (const b of document.querySelectorAll('.tab')) {
      b.addEventListener('click', async () => {
        const to = b.dataset.tab;
        if (state.tab === to) return;
        if (state.tab === 'quick') {
          if (qs.active && qs.draft.length && !(await askConfirm('保存していないタグがあります。高速タグ付与を終了しますか？', '終了する', '続ける'))) return;
          endQuickSession();
        } else if (to === 'quick') {
          qs.prevTab = state.tab;
        }
        state.tab = to;
        state.page = 1;
        render({ scroll: to !== 'quick' });
      });
    }

    if (window.matchMedia('(min-width: 720px)').matches) $('#search').open = true;
  }

  /* ---------------- JSON 読み込み ---------------- */
  let importing = false;

  function setStatus(msg) {
    const s = $('#status');
    s.hidden = !msg;
    s.textContent = msg || '';
  }

  /** IDBRequest を Promise化。swallow:true ならエラー時にイベントを握りつぶしてトランザクションを継続させる */
  function reqProm(req, { swallow = false } = {}) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = (ev) => {
        if (swallow) { ev.preventDefault(); ev.stopPropagation(); }
        reject(req.error);
      };
    });
  }

  /** オブジェクトをキー順を揃えて文字列化 (キーの並び順に依存せず内容だけを比較するため) */
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }

  /** 既存の投稿に対し、画像/動画のURL(と動画サムネイル)だけを新しい内容で差し替えた複製を返す。他のフィールドは既存のまま維持 */
  function mergeMediaUrls(existing, incoming) {
    const out = JSON.parse(JSON.stringify(existing));
    const nm = incoming.media && typeof incoming.media === 'object' ? incoming.media : null;
    if (!nm) return out;
    if (!out.media || typeof out.media !== 'object') out.media = { images: [], videos: [] };
    for (const [key, fields] of [['images', ['url']], ['videos', ['url', 'thumbnail']]]) {
      const src = Array.isArray(nm[key]) ? nm[key] : null;
      if (!src) continue;
      const dst = Array.isArray(out.media[key]) ? out.media[key] : (out.media[key] = []);
      src.forEach((n, i) => {
        if (!n || typeof n !== 'object') return;
        if (!dst[i] || typeof dst[i] !== 'object') { dst[i] = { ...n }; return; }
        for (const f of fields) if (typeof n[f] === 'string' && n[f]) dst[i][f] = n[f];
      });
    }
    return out;
  }

  /**
   * 1つの JSON を保存。id が既存と一致する場合は内容を比較し、
   * 少しでも差異があれば(画像・動画URLの変更を含め)既存レコードを新しい内容で完全に上書きする。
   * 内容が完全一致する場合のみ重複としてスキップ (無駄な書き込みをしない)。
   * tags ストアには一切触れない (再インポート・上書きでタグは消えない)
   */
  async function importData(data, onProgress) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.posts)) {
      throw new Error('形式が正しくありません（posts 配列がありません）');
    }
    const res = { total: data.posts.length, added: 0, updated: 0, dup: 0, invalid: 0, failed: 0, warn: '', error: '' };
    if (data.version !== undefined && data.version !== 1) res.warn = `version ${data.version} は想定外ですが、読み込みを試みました`;

    for (let s = 0; s < data.posts.length; s += IMPORT_CHUNK) {
      const tx = db.transaction('posts', 'readwrite');
      const st = tx.objectStore('posts');
      for (const raw of data.posts.slice(s, s + IMPORT_CHUNK)) {
        if (!raw || typeof raw !== 'object' || raw.id == null || String(raw.id).trim() === '') { res.invalid++; continue; }
        // 投稿の形式はそのまま保存。id が数値の場合のみ文字列キーに揃える
        const post = typeof raw.id === 'string' ? raw : { ...raw, id: String(raw.id) };
        try {
          const existing = await reqProm(st.get(post.id));
          if (!existing) {
            await reqProm(st.add(post), { swallow: true });
            res.added++;
          } else {
            // 同一idは画像・動画のURLだけ差し替える (本文など他のフィールドとタグは維持)
            const merged = mergeMediaUrls(existing, post);
            if (stableStringify(merged) !== stableStringify(existing)) {
              await reqProm(st.put(merged), { swallow: true });
              res.updated++;
            } else {
              res.dup++;
            }
          }
        } catch (e) {
          res.failed++;
        }
      }
      try {
        await txDone(tx);
      } catch (e) {
        res.error = `保存中にエラーが発生しました: ${e && e.message ? e.message : e}`;
        break;
      }
      onProgress(Math.min(s + IMPORT_CHUNK, data.posts.length), data.posts.length);
      await new Promise((r) => setTimeout(r)); // UIスレッドに処理を返す
    }
    return res;
  }

  async function importFiles(fileList) {
    const files = [...fileList];
    if (!files.length || importing) return;
    importing = true;
    $('#btn-import').disabled = true;
    const results = [];

    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const label = `(${i + 1}/${files.length}) ${f.name}`;
        setStatus(`読み込み中… ${label}`);
        try {
          const data = JSON.parse(await f.text());
          const r = await importData(data, (done, total) => setStatus(`保存中… ${label} ${done}/${total}件`));
          results.push({ name: f.name, ...r });
        } catch (e) {
          results.push({ name: f.name, error: e && e.message ? e.message : String(e) });
        }
      }
      setStatus('一覧を更新しています…');
      await refreshAll({ pickTab: true });
    } catch (e) {
      console.error(e);
      toast('一覧の更新に失敗しました。ページを再読み込みしてください');
    } finally {
      importing = false;
      $('#btn-import').disabled = false;
      $('#file-input').value = '';
      setStatus('');
    }
    showImportResult(results);
  }

  function showImportResult(results) {
    const body = $('#import-body');
    body.replaceChildren();
    const sum = results.reduce(
      (a, r) => ({ added: a.added + (r.added || 0), updated: a.updated + (r.updated || 0), dup: a.dup + (r.dup || 0) }),
      { added: 0, updated: 0, dup: 0 },
    );
    body.append(h('p', { text: `新規追加 ${sum.added}件 / URL更新 ${sum.updated}件 / 変更なしでスキップ ${sum.dup}件（タグは保持）` }));
    for (const r of results) {
      const box = h('div', { class: 'result' }, [h('p', { class: 'fname', text: r.name })]);
      if (r.error) box.append(h('p', { class: 'ng', text: r.error }));
      if (r.total != null) {
        box.append(h('p', { text: `追加 ${r.added}件 / URL更新 ${r.updated}件 / 重複 ${r.dup}件` + (r.invalid ? ` / IDなし等で無効 ${r.invalid}件` : '') + (r.failed ? ` / 保存失敗 ${r.failed}件` : '') }));
      }
      if (r.warn) box.append(h('p', { class: 'muted', text: r.warn }));
      body.append(box);
    }
    $('#import-dialog').showModal();
  }

  function initImport() {
    const input = $('#file-input');
    $('#btn-import').addEventListener('click', () => input.click());
    input.addEventListener('change', () => importFiles(input.files));
    $('#import-close').addEventListener('click', () => $('#import-dialog').close());
    // ドラッグ&ドロップ (PC向け)
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); importFiles(e.dataTransfer.files); }
    });
  }

  /* ---------------- タグのバックアップ ---------------- */
  const EXPORT_KEY = 'xbm-last-export';
  const EXPORT_REMIND_MS = 7 * 24 * 60 * 60 * 1000;

  async function exportTags() {
    try {
      const rows = await new Promise((resolve, reject) => {
        const r = db.transaction('tags', 'readonly').objectStore('tags').getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      if (!rows.length) { toast('書き出すタグがありません'); return; }
      const payload = { kind: 'xbm-tags', version: 1, exportedAt: new Date().toISOString(), tags: rows };
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const a = h('a', { href, download: `xbm-tags-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 15000);
      try { localStorage.setItem(EXPORT_KEY, String(Date.now())); } catch { /* noop */ }
      toast(`タグ ${rows.length}件を書き出しました`);
    } catch (e) {
      console.error(e);
      toast('書き出しに失敗しました');
    }
  }

  /** カテゴリ未設定(タグマスターJSONに無い手動タグ)を jsonmaker 用に書き出す */
  function exportUncategorized() {
    if (!master.ready) { toast('タグ候補JSONを読み込めていないため書き出せません'); return; }
    const list = tagCounts().filter((x) => !master.byKey.has(tagKey(x.tag)));
    if (!list.length) { toast('カテゴリ未設定のタグはありません'); return; }
    const payload = {
      kind: 'xbm-uncategorized-tags', version: 1, exportedAt: new Date().toISOString(),
      tags: list.map(({ tag, count }) => ({ name: tag, count })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const a = h('a', { href, download: `xbm-uncategorized-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 15000);
    toast(`未分類タグ ${list.length}件を書き出しました`);
  }

  function initUncategorizedExport() {
    const det = $('#s-tag-all');
    if (!det || $('#btn-export-uncat')) return;
    const row = h('div', { class: 'form-actions', style: 'padding:0 0 10px' }, [
      h('button', { id: 'btn-export-uncat', class: 'btn btn-sm', type: 'button', onclick: exportUncategorized }, 'カテゴリ未設定タグを書き出し（jsonmaker用）'),
    ]);
    det.append(row);
  }

  /** 永続ストレージを要求し、タグがあるのに1週間以上書き出していなければ知らせる */
  function protectData() {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if (!tagMap.size) return;
    let last = 0;
    try { last = Number(localStorage.getItem(EXPORT_KEY)) || 0; } catch { /* noop */ }
    if (Date.now() - last > EXPORT_REMIND_MS) toast('タグのバックアップを書き出しておくと安心です（右上「タグ書き出し」）', 6000);
  }

  function initBackup() {
    let b = $('#btn-export');
    if (!b) {
      // index.html を変更しなくても使えるよう、無ければ「JSONを読み込む」の隣に作る
      b = h('button', { id: 'btn-export', class: 'btn', type: 'button' }, 'タグ書き出し');
      const imp = $('#btn-import');
      if (imp && imp.parentNode) imp.parentNode.insertBefore(b, imp);
    }
    b.addEventListener('click', exportTags);
    initUncategorizedExport();
  }

  /* ---------------- 全体の再構築 ---------------- */
  function pickTabWithData() {
    if (state.tab === 'quick') return;
    const other = state.tab === 'tagged' ? 'untagged' : 'tagged';
    if (!view[state.tab].length && view[other].length) state.tab = other;
  }

  async function refreshAll({ pickTab = false } = {}) {
    index = await buildIndex();
    computeView();
    if (pickTab) pickTabWithData();
    $('#total-count').textContent = `保存済み ${index.length.toLocaleString('ja-JP')}件 ・ v${APP_VERSION}`;
    refreshTagSuggest();
    updateBadge();
    await render();
  }

  /* ==========================================================
     高速タグ付与
     - 対象は「タグ未設定」の投稿。開始時にID配列だけを取り、1投稿ずつ読み込んで表示する
     - 工程: 作品 → キャラ → 属性 → 衣装 → シチュ (キャラは該当作品にcharactersが無ければ丸ごとスキップ)
     - 選択したタグは通常の文字列タグとして tags ストアへ保存する (マスターJSONへは書かない)
     ========================================================== */
  const qs = {
    active: false, queue: [], pos: -1, saved: 0, skipped: [],
    post: null, step: 'work', draft: [], filter: '', done: false, busy: false, prevTab: 'untagged',
  };
  const QSTEPS = ['work', 'char', 'attr', 'costume', 'situ'];

  function selectedWorks() {
    const keys = new Set(qs.draft.map(tagKey));
    return master.works.filter((w) => keys.has(w.key));
  }

  /** active: キャラ候補あり / pending: 作品が未選択 / skip: 選択した作品にキャラ候補が無い */
  function charState() {
    const ws = selectedWorks();
    if (!ws.length) return 'pending';
    return ws.some((w) => w.chars.length) ? 'active' : 'skip';
  }

  const stepList = () => QSTEPS.filter((k) => k !== 'char' || charState() !== 'skip');
  const stepEnabled = (k) => k !== 'char' || charState() === 'active';

  function nextStepKey() {
    const list = stepList().filter(stepEnabled);
    const i = list.indexOf(qs.step);
    return i >= 0 && i < list.length - 1 ? list[i + 1] : null;
  }

  function startQuick() {
    Object.assign(qs, {
      active: true, queue: [...view.untagged], pos: -1, saved: 0, skipped: [],
      post: null, step: 'work', draft: [], filter: '', done: false, busy: false,
    });
    return nextQuickPost();
  }

  function endQuickSession() {
    teardownMedia($('#q-post'));
    $('#q-post').replaceChildren();
    Object.assign(qs, { active: false, queue: [], post: null, draft: [], skipped: [], done: false, busy: false });
    document.body.classList.remove('kb');
  }

  /** 次の未設定投稿へ。他で既にタグが付いた投稿は飛ばす */
  async function nextQuickPost() {
    qs.busy = true;
    renderQFoot();
    try {
      for (;;) {
        qs.pos++;
        if (qs.pos >= qs.queue.length) { qs.post = null; qs.done = true; break; }
        const id = qs.queue[qs.pos];
        if (tagMap.has(id)) continue;
        const [p] = await loadPosts([id]);
        if (!qs.active) return;
        if (!p) continue;
        Object.assign(qs, { post: p, draft: [], step: 'work', filter: '', done: false });
        break;
      }
    } catch (e) {
      console.error(e);
      toast('投稿の読み込みに失敗しました');
    }
    qs.busy = false;
    renderQuick(true);
  }

  function setQError(msg) {
    const e = $('#q-error');
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  function renderQuick(newPost) {
    const done = qs.done || !qs.post;
    $('#q-main').hidden = done;
    $('#q-done').hidden = !done;
    const filterNote = document.querySelector('#filter-badge').hidden ? '' : ' ・絞り込み中';
    $('#q-progress').textContent = done ? '完了' : `${qs.pos + 1} / ${qs.queue.length}`;
    $('#q-sub').textContent = `保存 ${qs.saved}件 ・スキップ ${qs.skipped.length}件${filterNote}`;
    if (done) {
      teardownMedia($('#q-post'));
      $('#q-post').replaceChildren();
      renderQDone();
      return;
    }
    if (newPost) {
      renderQPost();
      $('#q-filter').value = '';
      $('#q-manual').value = '';
      setQError('');
      $('#q-cands').scrollTop = 0;
    }
    renderQCrumbs();
    renderQCurrent();
    renderQCands();
    renderQFoot();
  }

  function renderQDone() {
    const box = $('#q-done');
    box.replaceChildren();
    const none = !qs.queue.length;
    box.append(h('p', { class: 'empty-msg', text: none ? 'タグ未設定の投稿がありません' : 'すべての投稿を確認しました' }));
    if (!none) box.append(h('p', { class: 'empty-hint', text: `保存 ${qs.saved}件 / スキップ ${qs.skipped.length}件` }));
    const acts = h('div', { class: 'q-done-actions' });
    if (qs.skipped.length) {
      acts.append(h('button', { class: 'btn', type: 'button', onclick: qRestartSkipped }, `スキップした投稿を処理（${qs.skipped.length}件）`));
    }
    acts.append(h('button', { class: 'btn btn-primary', type: 'button', onclick: qExit }, '高速タグ付与を終了'));
    box.append(acts);
  }

  function qRestartSkipped() {
    if (qs.busy) return;
    qs.queue = qs.skipped.filter((id) => !tagMap.has(id));
    qs.skipped = [];
    qs.pos = -1;
    qs.done = false;
    nextQuickPost();
  }

  function renderQPost() {
    const box = $('#q-post');
    teardownMedia(box);
    box.replaceChildren();
    const p = qs.post;
    const u = p.user && typeof p.user === 'object' ? p.user : {};
    const handle = u.id ? (String(u.id).startsWith('@') ? String(u.id) : `@${u.id}`) : '';
    const link = safeUrl(p.url);
    box.append(
      h('div', { class: 'q-who' }, [
        buildAvatar(u),
        h('div', { class: 'who' }, [
          h('div', { class: 'who-line' }, [
            h('span', { class: 'name', text: u.name || '(名前なし)' }),
            h('span', { class: 'handle', text: handle }),
          ]),
          h('time', { class: 'when', text: fmtDate(p.postTime) }),
        ]),
        link
          ? h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener noreferrer', 'aria-label': '元のX投稿を開く' }, [xIcon(), 'Xへ'])
          : null,
      ]),
    );
    if (p.text) {
      // 本文は2行まで表示。タップで全文(高さ上限つきでスクロール)、もう一度タップで戻す
      const text = h('p', { class: 'text clamp q-text', text: String(p.text) });
      text.addEventListener('click', () => {
        if (String(window.getSelection && window.getSelection()).length) return;
        text.classList.toggle('clamp');
      });
      box.append(text);
    }
    const media = buildMedia(p);
    if (media) box.append(media);
    flushLazy();
  }

  function countByCat() {
    const c = { work: 0, char: 0, attr: 0, costume: 0, situ: 0 };
    for (const t of qs.draft) {
      const it = master.byKey.get(tagKey(t));
      if (it) c[it.cat]++;
    }
    return c;
  }

  function renderQCrumbs() {
    const box = $('#q-crumbs');
    box.replaceChildren();
    const counts = countByCat();
    stepList().forEach((k, i) => {
      if (i) box.append(h('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '→' }));
      box.append(
        h('button', {
          class: 'crumb', type: 'button', 'aria-current': k === qs.step ? 'step' : null,
          disabled: !stepEnabled(k), onclick: () => qGoStep(k),
        }, [CATS.find((c) => c.key === k).label, counts[k] ? h('small', { text: counts[k] }) : null]),
      );
    });
  }

  function renderQCurrent() {
    const row = $('#q-cur');
    row.replaceChildren();
    if (!qs.draft.length) row.append(h('span', { class: 'chip-empty', text: 'タグ未選択' }));
    for (const t of qs.draft) {
      row.append(
        h('button', {
          class: 'chip cur', type: 'button', 'aria-label': `${t} を外す`, onclick: () => qRemoveTag(t),
        }, [t, h('span', { class: 'x', 'aria-hidden': 'true', text: '×' })]),
      );
    }
    $('#q-count').textContent = `${qs.draft.length} / ${MAX_TAGS}`;
  }

  function renderQCands() {
    const box = $('#q-cands-list');
    box.replaceChildren();
    const step = qs.step;
    if (!master.ready) {
      box.append(h('p', { class: 'chip-empty', text: master.failed.length ? 'タグ候補JSONを読み込めていません。下の手動入力でタグを追加できます。' : 'タグ候補を読み込み中です…' }));
      return;
    }
    const q = foldKana(qs.filter).trim();
    let groups;
    if (step === 'char') {
      // 選択した作品のうち characters を持つものだけを、作品ごとに分けて表示
      const ws = selectedWorks().filter((w) => w.chars.length);
      if (!ws.length) {
        box.append(h('p', { class: 'chip-empty', text: '作品を選択するとキャラクター候補が表示されます' }));
        return;
      }
      groups = ws.map((w) => ({ title: w.label, items: w.chars }));
    } else {
      groups = [{ title: '', items: step === 'work' ? master.works : master[step] }];
    }
    let shown = 0;
    for (const g of groups) {
      const items = q ? g.items.filter((it) => it.hay.includes(q)) : g.items; // 別名でも検索できる
      if (!items.length) continue;
      if (g.title) box.append(h('h4', { class: 'q-group', text: g.title }));
      const row = h('div', { class: 'chip-row big' });
      for (const it of items) row.append(pickChip(it, () => qToggle(it.label)));
      box.append(row);
      shown += items.length;
    }
    if (!shown) {
      box.append(h('p', { class: 'chip-empty', text: q ? '該当する候補がありません。下の手動入力で追加できます' : (master.failed.length ? 'この候補JSONを読み込めていません。手動入力は利用できます。' : '候補がありません') }));
    }
    syncPressed(box, qs.draft);
  }

  function renderQFoot() {
    $('#q-skip').disabled = qs.busy || !qs.post;
    $('#q-next').disabled = qs.busy || !qs.post || !nextStepKey();
    $('#q-save').disabled = qs.busy || !qs.post || !qs.draft.length;
    $('#q-manual-add').disabled = qs.busy || !qs.post;
  }

  function qGoStep(k) {
    if (qs.busy || !stepEnabled(k) || qs.step === k) return;
    qs.step = k;
    qs.filter = '';
    $('#q-filter').value = '';
    setQError('');
    $('#q-cands').scrollTop = 0;
    renderQCrumbs();
    renderQCands();
    renderQFoot();
  }

  /** 選択の変化を反映 (候補一覧は作り直さず、選択状態だけ同期してスクロール位置を保つ) */
  function qAfterChange() {
    if (qs.step === 'char' && charState() !== 'active') {
      qs.step = 'work'; // キャラ候補が無くなった場合は作品工程へ戻す
      renderQCands();
    }
    syncPressed($('#q-cands'), qs.draft);
    renderQCrumbs();
    renderQCurrent();
    renderQFoot();
  }

  function qToggle(label) {
    if (qs.busy) return;
    const k = tagKey(label);
    if (qs.draft.some((t) => tagKey(t) === k)) { qRemoveTag(label); return; }
    const { added, errs } = validateAdd(qs.draft, [label]);
    qs.draft.push(...added);
    setQError(errs.join(' / '));
    qAfterChange();
  }

  /** タグを外す。作品を外したときは、その作品専用のキャラも一緒に外す (他の選択作品と共通のキャラは残す) */
  function qRemoveTag(label) {
    if (qs.busy) return;
    const k = tagKey(label);
    const work = master.works.find((w) => w.key === k);
    qs.draft = qs.draft.filter((t) => tagKey(t) !== k);
    setQError('');
    if (work && work.chars.length) {
      const keep = new Set(selectedWorks().flatMap((w) => w.chars.map((c) => c.key)));
      const drop = new Set(work.chars.map((c) => c.key));
      const before = qs.draft.length;
      qs.draft = qs.draft.filter((t) => { const tk = tagKey(t); return !(drop.has(tk) && !keep.has(tk)); });
      const n = before - qs.draft.length;
      if (n) toast(`${work.label}のキャラ${n}件も外しました`);
      if (qs.step === 'char') renderQCands();
    }
    qAfterChange();
  }

  function qManualAdd() {
    if (qs.busy || !qs.post) return;
    const input = $('#q-manual');
    const parts = parseTagInput(input.value);
    if (!parts.length) { setQError('タグを入力してください（空白や区切り文字だけは登録できません）'); return; }
    const { added, errs } = validateAdd(qs.draft, parts);
    qs.draft.push(...added);
    setQError(errs.join(' / '));
    if (added.length && !errs.length) input.value = '';
    qAfterChange();
  }

  async function qSave() {
    if (qs.busy || !qs.post || !qs.draft.length) return;
    qs.busy = true;
    renderQFoot();
    try {
      await commitTags(qs.post.id, qs.draft);
    } catch (e) {
      console.error(e);
      qs.busy = false;
      renderQFoot();
      setQError('保存に失敗しました。保存領域の空き容量を確認してください。');
      return;
    }
    qs.saved++;
    computeView(); // 保存した投稿は「タグ設定済」へ移動 (タブの件数も更新)
    updateTabs();
    await nextQuickPost();
  }

  async function qSkip() {
    if (qs.busy || !qs.post) return;
    if (qs.draft.length && !(await askConfirm('選択中のタグは保存されません。この投稿をスキップしますか？', 'スキップ', '戻る'))) return;
    qs.skipped.push(qs.post.id); // タグ未設定のまま残るので、後から再度処理できる
    await nextQuickPost();
  }

  async function qExit() {
    if (qs.active && qs.draft.length && !(await askConfirm('保存していないタグがあります。高速タグ付与を終了しますか？', '終了する', '続ける'))) return;
    endQuickSession();
    state.tab = qs.prevTab === 'tagged' ? 'tagged' : 'untagged';
    state.page = 1;
    computeView();
    render({ scroll: true });
  }

  /** キーボード表示中もボトム操作が隠れないよう、見えている領域(visualViewport)に合わせる */
  function syncViewport() {
    const v = window.visualViewport;
    const st = document.documentElement.style;
    const vh = v ? v.height : window.innerHeight;
    st.setProperty('--vvh', `${vh}px`);
    st.setProperty('--vvt', `${v ? v.offsetTop : 0}px`);
    const a = document.activeElement;
    const typing = !!(a && a.matches && a.matches('#quick input'));
    const shrunk = window.innerHeight - vh > 120 || vh < 480;
    document.body.classList.toggle('kb', typing && shrunk && state.tab === 'quick');
  }

  function initQuick() {
    $('#q-exit').addEventListener('click', qExit);
    $('#q-skip').addEventListener('click', qSkip);
    $('#q-save').addEventListener('click', qSave);
    $('#q-next').addEventListener('click', () => { const k = nextStepKey(); if (k) qGoStep(k); });
    $('#q-manual-add').addEventListener('click', qManualAdd);
    $('#q-manual').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); qManualAdd(); }
    });
    $('#q-filter').addEventListener('input', debounce((e) => { qs.filter = e.target.value; renderQCands(); }, 120));
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewport);
      window.visualViewport.addEventListener('scroll', syncViewport);
    }
    window.addEventListener('resize', syncViewport);
    document.addEventListener('focusin', syncViewport);
    document.addEventListener('focusout', () => setTimeout(syncViewport, 50));
    syncViewport();
    window.addEventListener('beforeunload', (e) => {
      if (qs.active && qs.draft.length) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ---------------- 起動 ---------------- */
  async function init() {
    initSearch();
    initTagEditor();
    initLightbox();
    initImport();
    initQuick();
    initBackup();
    // タグマスター(JSON)はDBとは独立して読む。失敗しても本体と手動タグ入力は使える
    const masterLoading = loadMaster().catch((e) => console.warn('master', e));

    try {
      db = await openDB();
      db.onversionchange = () => { db.close(); toast('別のタブでデータベースが更新されました。再読み込みしてください', 6000); };
      await loadTags();
      await refreshAll({ pickTab: true });
      protectData();
      await masterLoading;
    } catch (e) {
      console.error(e);
      const f = $('#fatal');
      f.hidden = false;
      f.textContent = `データベースを開けませんでした: ${e && e.message ? e.message : e}（プライベートブラウズでは利用できない場合があります）`;
      $('#btn-import').disabled = true;
      return;
    }

    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      // 新しい Service Worker に切り替わったら、一度だけ自動で読み込み直す (古い版が残り続けないように)
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloaded || (qs.active && qs.draft.length)) return;
        reloaded = true;
        location.reload();
      });
      navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
    }
  }

  init();
})();
