// finoject 法令ビューア PWA Service Worker
// 方針: 「ネットワーク優先」。オンライン時は常に最新を取得（= git push した新機能が即反映され、今の運用を壊さない）。
//       オフライン時のみキャッシュした最後のアプリ外殻（index.html等）を表示。
// キャッシュ対象は「同一オリジン・クエリ無し」のGETのみ（=アプリの外殻: index.html / manifest / アイコン）。
//   - data/*.json は ?t=… 付きで都度取得＝常にライブ（キャッシュしない＝肥大化と陳腐化を防ぐ）。
//   - CoinGecko / Cloudflare Workerプロキシ(Yahoo) 等の他オリジンは一切横取りしない（CORS・ライブ性を維持）。
const VER = 'v1';
const SHELL = 'finoject-shell-' + VER;

self.addEventListener('install', (e) => { self.skipWaiting(); });          // 新SWを即時待機解除

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)));  // 旧バージョンのキャッシュを掃除
    await self.clients.claim();                                            // 既存タブもすぐ新SW管理下に
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                                        // GET以外は素通し
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;                             // 他オリジン(API/プロキシ)は横取りしない
  if (url.search) return;                                                  // ?t= 付き(=data等)はネットワークのみ＝常にライブ
  // 外殻: ネットワーク優先 → 取得できたらキャッシュ更新、失敗時はキャッシュ、無ければ index.html
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      const cache = await caches.open(SHELL);
      cache.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const idx = await caches.match('./') || await caches.match('./index.html');
        if (idx) return idx;
      }
      throw err;
    }
  })());
});
