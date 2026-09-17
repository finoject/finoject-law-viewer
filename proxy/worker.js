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
// クライアントには絶対に出さない。モデルは既定 claude-haiku-4-5（最安・短い要約/解説に十分）。CLAUDE_MODEL secretで変更可（品質重視なら claude-sonnet-4-6 等）。
// /ai を叩けるオリジン。以前は '*' だったため、誰のサイトからでもブラウザ経由でこのWorkerの
// Anthropic APIキーに課金できた。CORSはcurl等の非ブラウザ呼び出しを止めないので、
// 下の入力サイズ上限・キャッシュ・（設定時の）レート制限と合わせて多層で抑える。
const AI_ORIGINS = ['https://finoject.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080'];
const AI_BASE = { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'vary': 'origin' };
function aiCors(request) {
  const o = request.headers.get('origin') || '';
  return AI_ORIGINS.includes(o) ? { ...AI_BASE, 'access-control-allow-origin': o } : AI_BASE;   // 未許可オリジンにはCORSヘッダを返さない＝ブラウザ側で結果を読めない
}
// 入力の上限。payload の全フィールドに上限を掛ける。以前は body だけ slice していたため、
// title/agency/law/num/lawrefs に数十万字を積んで1リクエストで大量の入力トークンを焼けた。
const AI_MAX_BODY_BYTES = 64 * 1024;          // リクエスト本文そのものの上限（実バイト数）
const PROMPT_REV = '2026-09-17a';            // ★system prompt / schema / 上限値を変えたら必ず上げる（キャッシュの世代）
const cut = (v, n) => (typeof v === 'string' ? v : (v == null ? '' : String(v))).slice(0, n);
function aiJson(obj, status, extra, cors) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8', ...(cors || AI_BASE), ...(extra || {}) } }); }
async function handleAI(request, env) {
  const CORS = aiCors(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });
  const rawKey = (env && env.ANTHROPIC_API_KEY) || '';
  const KEY = rawKey.replace(/\s/g, '');   // 途中も含め全ての空白・改行を除去（"Invalid header value" 対策。APIキーに空白は含まれない）
  if (request.method === 'GET') {          // ブラウザで開ける簡易ヘルスチェック（鍵の内部情報は出さない）
    return aiJson({ ok: true, deployed: '2026-09-17', model: (env.CLAUDE_MODEL || 'claude-haiku-4-5'), keyConfigured: !!KEY }, 200, null, CORS);
  }
  if (request.method !== 'POST') return aiJson({ error: 'method not allowed' }, 405, null, CORS);
  if (!KEY) return aiJson({ error: 'ANTHROPIC_API_KEY not configured on the worker' }, 500, null, CORS);
  // リクエスト本文の上限。content-length が無い/詐称されている場合に備え、読み取った実バイト数でも確認する。
  const clen = +(request.headers.get('content-length') || 0);
  if (clen > AI_MAX_BODY_BYTES) return aiJson({ error: 'payload too large' }, 413, null, CORS);
  const rawBody = await request.text();
  // 実バイト数で確かめる。String.length は UTF-16 のコード単位数なので、日本語本文だと
  // 実際は64KBを超えていても通過する（content-length を付けない呼び出しで効く）。
  const rawBytes = new TextEncoder().encode(rawBody);
  if (rawBytes.length > AI_MAX_BODY_BYTES) return aiJson({ error: 'payload too large' }, 413, null, CORS);
  let body; try { body = JSON.parse(rawBody); } catch { return aiJson({ error: 'bad json' }, 400, null, CORS); }
  // レート制限バインディング（wrangler.toml に ratelimit バインディングを足したときだけ効く。未設定なら素通り）。
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function') {
    const key = request.headers.get('cf-connecting-ip') || 'anon';
    try { const { success } = await env.RATE_LIMITER.limit({ key }); if (!success) return aiJson({ error: 'rate limited' }, 429, { 'retry-after': '60' }, CORS); }
    catch (e) { /* 制限側の障害でサービスを落とさない */ }
  }
  // 同一入力の再課金を実際に防ぐ。以前は POST 応答に cache-control を付けるだけだったが、
  // POST はブラウザにも CDN にもキャッシュされないため「24hキャッシュでコスト削減」は効いていなかった。
  // Cache API に正規化した入力のハッシュをキーにして自前で載せる。
  const cacheKeyUrl = new URL(request.url);
  // キーには入力だけでなく、応答を左右するもの（モデル・プロンプト版）も含める。
  // 本文のハッシュだけだと、モデルやプロンプトを変えても最大24時間は旧応答が返り続ける。
  // プロンプト・スキーマを書き換えたら PROMPT_REV を上げること。
  const cacheSeed = `${PROMPT_REV}|${env.CLAUDE_MODEL || 'claude-haiku-4-5'}|${rawBody}`;
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cacheSeed)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  cacheKeyUrl.pathname = '/ai-cache';
  cacheKeyUrl.search = '?k=' + digest;
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) { const h = new Headers(hit.headers); for (const [k, v] of Object.entries(CORS)) h.set(k, v); h.set('x-cache', 'HIT');
             return new Response(hit.body, { status: hit.status, headers: h }); }
  const task = body && body.task, p = (body && body.payload) || {};
  const MODEL = env.CLAUDE_MODEL || 'claude-haiku-4-5';   // 既定は最安の Haiku（短い要約/解説に十分）。品質を上げたい時は CLAUDE_MODEL=claude-sonnet-4-6 等を設定
  let system, user, schema, maxTokens;
  if (task === 'update') {
    const body = cut(p.body, 6000);
    const lawrefs = (Array.isArray(p.lawrefs) ? p.lawrefs : []).slice(0, 20).map(x => cut(x, 60));   // 配列でなければ捨てる（文字列だと .join が無くて500になる）
    system = 'あなたは日本の金融規制に精通したコンプライアンス実務の専門家です。当局の公表物の【本文】から、実務担当者が知るべき具体的な内容を3行で抽出します。**タイトルの言い換えや一般論は禁止**。本文にある具体（改正・新設・廃止された条項／基準値・金額・期限／対象事業者／適用開始日／必要な手続）を優先して書く。各行は ①何が具体的に変わった/示されたか ②誰が何をすべきか（対象者と対応） ③いつから／どの法令・どの条項に関わるか。各行40〜80字、事実ベース、本文に無いことは断定しない。本文が乏しい場合のみタイトル・関連法令から最小限の推定をし、その場合も「〜とみられる」等は付けず簡潔に述べる。';
    user = `機関: ${cut(p.agency, 40)}\n日付: ${cut(p.date, 20)}\nタイトル: ${cut(p.title, 300)}\n関連法令(自動検出): ${lawrefs.join('、') || 'なし'}\n\n【本文(抜粋)】\n${body || '(本文の取得なし。タイトル・関連法令から簡潔に。)'}`;
    schema = { type: 'object', properties: { lines: { type: 'array', items: { type: 'string' } } }, required: ['lines'], additionalProperties: false };
    maxTokens = 700;
  } else if (task === 'article') {
    system = 'あなたは日本の金融関連法令に精通した実務家です。与えられた条文を、コンプライアンス実務者向けに日本語でやさしく解説します。text には「この条文が何を言っているか」を2〜3文で平易に。points には「実務でどこで効くか」「確認すべき点」「よく一緒に見る条文や留意点」を簡潔に（各1文・最大4件）。条文に書かれていない断定は避け、事実ベースで。';
    user = `法令: ${cut(p.law, 100)}\n条: ${cut(p.num, 40)}\n本文:\n${cut(p.body, 4000)}`;
    schema = { type: 'object', properties: { text: { type: 'string' }, points: { type: 'array', items: { type: 'string' } } }, required: ['text', 'points'], additionalProperties: false };
    maxTokens = 800;
  } else return aiJson({ error: 'unknown task' }, 400, null, CORS);

  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema } } }),
    });
  } catch (e) { console.log('upstream error: ' + e); return aiJson({ error: 'upstream unavailable' }, 502, null, CORS); }
  // 上流の生エラー本文は返さない（レート制限の内訳・組織情報等が外に出る）。ログにだけ残す。
  if (!r.ok) { console.log('claude ' + r.status + ': ' + (await r.text()).slice(0, 300)); return aiJson({ error: 'claude ' + r.status }, 502, null, CORS); }
  const data = await r.json();
  const txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let out; try { out = JSON.parse(txt); } catch { console.log('parse error: ' + txt.slice(0, 300)); return aiJson({ error: 'parse' }, 502, null, CORS); }
  const res = aiJson(out, 200, { 'cache-control': 'public, max-age=86400', 'x-cache': 'MISS' }, CORS);
  // 成功応答だけを24h保存。キーは入力のSHA-256なので、同じ条文・同じ公表物の解説は課金されない。
  try { await cache.put(cacheKey, new Response(JSON.stringify(out), {
    status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400' } })); }
  catch (e) { /* キャッシュ書込みの失敗で応答を落とさない */ }
  return res;
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

    // リダイレクト後の最終URLも許可リストで検証する。初回URLしか見ていないと、
    // 許可ドメイン上にオープンリダイレクトが1つでもあれば任意の外部サイトの中継に使われる。
    try {
      const fin = new URL(upstream.url || t.href);
      const fh = fin.hostname.replace(/^www\d*\./, '');
      if (!ALLOW.some(d => fh === d || fh.endsWith('.' + d))) return new Response('redirect target not allowed', { status: 403 });
    } catch (e) { return new Response('bad redirect target', { status: 502 }); }

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
