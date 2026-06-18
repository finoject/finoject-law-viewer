// finoject 法令ビューア用 ページ埋め込みプロキシ（Cloudflare Worker・無料枠で動作）
// 目的: 金融庁・日銀・JPX 等は X-Frame-Options: SAMEORIGIN で iframe 埋め込みを拒否するため、
//       このプロキシ経由で取得し、埋め込み拒否ヘッダを除去して同オリジンで返すことで、
//       法令ビューアのトップ画面内（規制ウォッチ・フィードの本文ビューア）に直接表示できるようにする。
// セキュリティ: オープンプロキシ化を防ぐため、許可ドメイン（監視対象6機関）のみ中継する。
//
// 使い方: GET https://<your-worker>.workers.dev/?url=<取得したいURL（URLエンコード）>
// 例:      https://finoject-proxy.example.workers.dev/?url=https%3A%2F%2Fwww.fsa.go.jp%2Fnews%2F...

const ALLOW = ['fsa.go.jp', 'boj.or.jp', 'jpx.co.jp', 'jsda.or.jp', 'jvcea.or.jp', 'jicpa.or.jp',
  'yahoo.co.jp', 'shugiin.go.jp', 'sangiin.go.jp'];   // yahoo=関連ニュース(news.yahoo.co.jp)、衆参=将来の議案ページ用

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target) return new Response('missing ?url=', { status: 400 });

    let t;
    try { t = new URL(target); } catch { return new Response('bad url', { status: 400 }); }
    if (t.protocol !== 'https:' && t.protocol !== 'http:') return new Response('bad protocol', { status: 400 });

    // 許可ドメイン（およびそのサブドメイン）のみ中継。www / www3 等の接頭辞は無視して判定。
    const host = t.hostname.replace(/^www\d*\./, '');
    const ok = ALLOW.some(d => host === d || host.endsWith('.' + d));
    if (!ok) return new Response('domain not allowed', { status: 403 });

    let upstream;
    try {
      upstream = await fetch(t.href, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; finoject-viewer/1.0)', 'Accept-Language': 'ja,en;q=0.8' },
        redirect: 'follow',
      });
    } catch (e) {
      return new Response('fetch failed: ' + e, { status: 502 });
    }

    const ct = upstream.headers.get('content-type') || '';
    const h = new Headers();
    h.set('content-type', ct || 'application/octet-stream');
    h.set('access-control-allow-origin', '*');         // 法令ビューア（github.io）から利用するため
    h.set('cache-control', 'public, max-age=300');     // 5分キャッシュ
    // ※ X-Frame-Options / Content-Security-Policy(frame-ancestors) は意図的に転送しない＝埋め込み可能にする

    if (ct.includes('text/html')) {
      let html = await upstream.text();
      // 読み取り専用表示の安定化: <script> を除去（外部サイトのJSが iframe 内でハング/真っ白/フレームバスター/
      // コンテンツ非表示を起こすのを防ぐ。本文は静的HTMLに含まれるため除去しても読める）。
      html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<script\b[^>]*\/>/gi, '');
      // 相対パス(CSS/画像/リンク)を元サイトに解決する <base>。target="_blank"=ページ内リンクは新しいタブで開く。
      // ＋万一CSS/JSで本文が隠れている場合に備え可視化を強制。
      const inject = '<base href="' + t.href.replace(/"/g, '&quot;') + '" target="_blank">'
        + '<style>html,body{opacity:1!important;visibility:visible!important;}</style>';
      if (/<head[^>]*>/i.test(html)) html = html.replace(/<head([^>]*)>/i, '<head$1>' + inject);
      else html = inject + html;
      return new Response(html, { status: upstream.status, headers: h });
    }
    // PDF（日銀の金融政策決定会合資料等）やその他はそのまま中継
    return new Response(upstream.body, { status: upstream.status, headers: h });
  }
};
