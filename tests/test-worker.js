// Cloudflare Worker (/ai) の入力検証・CORS の回帰テスト。
// Workers ランタイムは使わず、worker.js から純粋な部分だけを取り出して Node で評価する。
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'proxy', 'worker.js'), 'utf8');

// 検証対象の定義だけを切り出す（本番を書き写さない）
function grab(re, label){ const m = src.match(re); assert.ok(m, label + ' が worker.js に見つかりません'); return m[0]; }
const defs = [
  grab(/const AI_ORIGINS = \[[^\]]*\];/, 'AI_ORIGINS'),
  grab(/const AI_BASE = \{[^\n]*\};/, 'AI_BASE'),
  grab(/function aiCors\(request\) \{[\s\S]*?\n\}/, 'aiCors'),
  grab(/const AI_MAX_BODY_BYTES = [^\n]*;/, 'AI_MAX_BODY_BYTES'),
  grab(/const cut = [^\n]*;/, 'cut'),
].join('\n');
const { aiCors, cut, AI_MAX_BODY_BYTES, AI_ORIGINS } = new Function(defs + '\nreturn { aiCors, cut, AI_MAX_BODY_BYTES, AI_ORIGINS };')();
const req = origin => ({ headers: { get: h => (h === 'origin' ? origin : null) } });

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok   ' + n); } catch(e){ fail++; console.log('  FAIL ' + n + '\n       ' + e.message); } };

t('許可オリジンにだけ CORS を返す', () => {
  assert.strictEqual(aiCors(req('https://finoject.github.io'))['access-control-allow-origin'], 'https://finoject.github.io');
});
t('未許可オリジンには allow-origin を返さない（以前は * で誰でも叩けた）', () => {
  assert.strictEqual(aiCors(req('https://evil.example'))['access-control-allow-origin'], undefined);
  assert.strictEqual(aiCors(req(null))['access-control-allow-origin'], undefined);
});
t('ワイルドカードが残っていない', () => {
  assert.ok(!/access-control-allow-origin['"]?\s*:\s*['"]\*/.test(src.slice(0, src.indexOf('export default'))),
    '/ai 側に allow-origin: * が残っています');
});
t('cut が上限で切る', () => {
  assert.strictEqual(cut('あ'.repeat(1000), 10).length, 10);
  assert.strictEqual(cut(null, 10), '');
  assert.strictEqual(cut(12345, 3), '123', '数値も文字列化して切る');
  assert.strictEqual(cut({a:1}, 100), '[object Object]');
});
t('lawrefs が配列でなくても落ちない（文字列/数値/オブジェクト）', () => {
  // worker.js 本体の正規化式をそのまま取り出して評価する。
  // テスト側に同じ式を書き写すと、本体を巻き戻してもテストが通ってしまう（素通りする）。
  const line = grab(/const lawrefs = \(Array\.isArray\(p\.lawrefs\)[^\n]*/, 'lawrefs の正規化');
  const norm = new Function('cut', 'p', line + '\nreturn lawrefs;').bind(null, cut);
  assert.deepStrictEqual(norm({ lawrefs: '資金決済法' }), []);
  assert.deepStrictEqual(norm({ lawrefs: 42 }), []);
  assert.deepStrictEqual(norm({ lawrefs: {0:'a'} }), []);
  assert.deepStrictEqual(norm({ lawrefs: ['資金決済法','犯収法'] }), ['資金決済法','犯収法']);
  assert.strictEqual(norm({ lawrefs: new Array(100).fill('x') }).length, 20, 'lawrefs の件数上限が効いていません');
  assert.strictEqual(norm({ lawrefs: ['あ'.repeat(500)] })[0].length, 60, 'lawrefs の1件あたりの長さ上限が効いていません');
});
t('本文サイズ上限が定義されている', () => {
  assert.strictEqual(typeof AI_MAX_BODY_BYTES, 'number');
  assert.ok(AI_MAX_BODY_BYTES > 0 && AI_MAX_BODY_BYTES <= 256 * 1024);
});
t('payload の各フィールドに上限が掛かっている（title/agency/law/num）', () => {
  for (const f of ['p.agency', 'p.title', 'p.law', 'p.num']) {
    assert.ok(src.includes('cut(' + f + ','), f + ' に上限が掛かっていません');
  }
});
t('上流エラーの生本文をクライアントへ返していない', () => {
  assert.ok(!/detail:\s*tx\.slice/.test(src), 'detail: tx.slice が残っています');
  assert.ok(!/raw:\s*txt\.slice/.test(src), 'raw: txt.slice が残っています');
});
t('POSTの応答を Cache API で実際にキャッシュしている', () => {
  assert.ok(/caches\.default/.test(src) && /cache\.put\(cacheKey/.test(src) && /cache\.match\(cacheKey\)/.test(src),
    'cache-control ヘッダだけでは POST はキャッシュされない');
});
t('リダイレクト後の最終URLも許可リストで検証している', () => {
  assert.ok(/upstream\.url/.test(src) && /redirect target not allowed/.test(src));
});

// ---- 2026-09-17 codex の修正後レビューで指摘された点 ----
t('キャッシュキーにモデルとプロンプト版を含めている', () => {
  assert.ok(/const PROMPT_REV = /.test(src), 'プロンプト版の定数がありません');
  assert.ok(/const cacheSeed = `\$\{PROMPT_REV\}\|\$\{env\.CLAUDE_MODEL/.test(src),
    'キャッシュキーが本文のハッシュだけです（モデル/プロンプトを変えても旧応答が返ります）');
  assert.ok(/digest\('SHA-256', new TextEncoder\(\)\.encode\(cacheSeed\)\)/.test(src),
    'ハッシュの対象が cacheSeed になっていません');
});

t('本文の上限を実バイト数で判定している', () => {
  assert.ok(/const rawBytes = new TextEncoder\(\)\.encode\(rawBody\);/.test(src), 'バイト列に変換していません');
  assert.ok(/rawBytes\.length > AI_MAX_BODY_BYTES/.test(src),
    'String.length で判定しています（UTF-16コード単位なので日本語は実バイト超過を通します）');
  // 実際に差が出ることを示す
  const ja = 'あ'.repeat(40000);
  assert.strictEqual(ja.length, 40000);
  assert.strictEqual(new TextEncoder().encode(ja).length, 120000, '日本語は1文字3バイト');
  assert.ok(ja.length <= 64 * 1024 && new TextEncoder().encode(ja).length > 64 * 1024,
    '旧判定なら通り、新判定なら弾かれる入力であること');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
