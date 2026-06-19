// finoject 法令ビューア用 ページ埋め込みプロキシ（Cloudflare Worker・無料枠で動作）
// 目的: 金融庁・日銀・JPX 等は X-Frame-Options: SAMEORIGIN で iframe 埋め込みを拒否するため、
//       このプロキシ経由で取得し、埋め込み拒否ヘッダを除去して同オリジンで返すことで、
//       法令ビューアのトップ画面内（規制ウォッチ・フィードの本文ビューア）に直接表示できるようにする。
// セキュリティ: オープンプロキシ化を防ぐため、許可ドメイン（監視対象6機関）のみ中継する。
//
// 使い方: GET https://<your-worker>.workers.dev/?url=<取得したいURL（URLエンコード）>
// 例:      https://finoject-proxy.example.workers.dev/?url=https%3A%2F%2Fwww.fsa.go.jp%2Fnews%2F...

const ALLOW = ['fsa.go.jp', 'boj.or.jp', 'jpx.co.jp', 'jsda.or.jp', 'jvcea.or.jp', 'jicpa.or.jp',
  'yahoo.co.jp', 'shugiin.go.jp', 'sangiin.go.jp', 'finance.yahoo.com'];   // yahoo=関連ニュース(news.yahoo.co.jp)、衆参=議案ページ、finance.yahoo.com=市況(ドル円/日経/ダウ)のJSON取得

// ===== AI解説エンドポイント（/ai） =====
// 法令ビューアの「理解パネル」「条文のやさしく解説」から POST される {task, payload} を受け、Claude messages API を呼んで
// JSON（task=update→{lines:[]}／task=article→{text,points:[]}）を返す。APIキーはWorker secret(ANTHROPIC_API_KEY)に置き、
// クライアントには絶対に出さない。モデルは既定 claude-opus-4-8（CLAUDE_MODEL secretで変更可。コスト重視なら claude-haiku-4-5 等）。
const AI_CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
function aiJson(obj, status, extra) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8', ...AI_CORS, ...(extra || {}) } }); }
async function handleAI(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...AI_CORS, 'access-control-max-age': '86400' } });
  if (request.method !== 'POST') return aiJson({ error: 'method not allowed' }, 405);
  if (!env || !env.ANTHROPIC_API_KEY) return aiJson({ error: 'ANTHROPIC_API_KEY not configured on the worker' }, 500);
  let body; try { body = await request.json(); } catch { return aiJson({ error: 'bad json' }, 400); }
  const task = body && body.task, p = (body && body.payload) || {};
  const MODEL = env.CLAUDE_MODEL || 'claude-opus-4-8';
  let system, user, schema, maxTokens;
  if (task === 'update') {
    system = 'あなたは日本の金融規制に精通したコンプライアンス実務の専門家です。与えられた当局の公表物について、実務担当者向けに日本語で簡潔な「3行の要点」を作ります。各行は ①何が起きたか ②誰に関係するか ③どの法令・論点に関係するか。各行40〜70字程度、事実ベースで、前置き・推測・誇張は避ける。与えられた情報の範囲で書く。';
    user = `機関: ${p.agency || ''}\n日付: ${p.date || ''}\nタイトル: ${p.title || ''}\n関連法令(自動検出): ${(p.lawrefs || []).join('、') || 'なし'}`;
    schema = { type: 'object', properties: { lines: { type: 'array', items: { type: 'string' } } }, required: ['lines'], additionalProperties: false };
    maxTokens = 600;
  } else if (task === 'article') {
    system = 'あなたは日本の金融関連法令に精通した実務家です。与えられた条文を、コンプライアンス実務者向けに日本語でやさしく解説します。text には「この条文が何を言っているか」を2〜3文で平易に。points には「実務でどこで効くか」「確認すべき点」「よく一緒に見る条文や留意点」を簡潔に（各1文・最大4件）。条文に書かれていない断定は避け、事実ベースで。';
    user = `法令: ${p.law || ''}\n条: ${p.num || ''}\n本文:\n${(p.body || '').slice(0, 4000)}`;
    schema = { type: 'object', properties: { text: { type: 'string' }, points: { type: 'array', items: { type: 'string' } } }, required: ['text', 'points'], additionalProperties: false };
    maxTokens = 800;
  } else return aiJson({ error: 'unknown task' }, 400);

  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema } } }),
    });
  } catch (e) { return aiJson({ error: 'upstream: ' + e }, 502); }
  if (!r.ok) { const tx = await r.text(); return aiJson({ error: 'claude ' + r.status, detail: tx.slice(0, 300) }, 502); }
  const data = await r.json();
  const txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let out; try { out = JSON.parse(txt); } catch { return aiJson({ error: 'parse', raw: txt.slice(0, 300) }, 502); }
  return aiJson(out, 200, { 'cache-control': 'public, max-age=86400' });   // 同一入力は24h CDNキャッシュ（コスト削減）
}

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    if (reqUrl.pathname === '/ai') return handleAI(request, env);   // AI解説（Claude）
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
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept-Language': 'ja,en;q=0.8' },
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
