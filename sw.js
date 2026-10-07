'use strict';
/* オフライン用 Service Worker
   - アプリ本体 (HTML/CSS/JS) は network-first: オンラインなら常に最新を取得し、オフライン時だけキャッシュを使う
     (stale-while-revalidate だと更新後も1回古い版が表示されるため)
   - タグマスターJSON (works/attribute/costume/situation) は network-first:
     オンラインなら常に最新を取得してキャッシュを更新し、オフライン時だけキャッシュを使う
     (JSONを更新しても古い内容が使われ続けない)
   - 投稿データは IndexedDB に入っているため、本体がキャッシュされていればオフラインでも閲覧可能
   - X上の画像・動画 (外部オリジン) には介入しない */
const CACHE = 'xbm-viewer-v6';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg'];
const MASTER = ['data/works.json', 'data/attribute.json', 'data/costume.json', 'data/situation.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      // HTTPキャッシュ経由で古いファイルを拾わないよう、毎回ネットワークから取得する
      await Promise.all(SHELL.map((f) => c.add(new Request(f, { cache: 'reload' }))));
      // JSONは無くてもインストールを失敗させない
      await Promise.all(MASTER.map((f) => c.add(new Request(f, { cache: 'reload' })).catch(() => {})));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isMaster = (url) => MASTER.some((f) => url.pathname.endsWith(`/${f}`));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isMaster(url)) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  // network-first: 常に最新を取得してキャッシュを更新し、オフライン時だけキャッシュを使う
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
