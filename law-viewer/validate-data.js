// データ検証ゲート: 巡回後に index.json / 個別JSON の健全性を点検する。
// 異常を検知したら **非ゼロ終了** し、ワークフローを止める＝壊れたデータを Pages に公開させない（外国為替令が空で公開された事故の再発防止）。
// crawl.yml の「データ更新コミット」「Pages公開」より前に実行する。失敗時は既存の失敗時Slack通知が鳴る。
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA = path.join(__dirname, '..', 'law-viewer-site', 'data');
const errs = [];
const warns = [];

// --- index.json ---
let idx;
try { idx = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8')); }
catch (e) { console.error('✗ FATAL: index.json を読めない/parseできない: ' + e.message); process.exit(1); }

const laws = Array.isArray(idx.laws) ? idx.laws : [];

// 1) 件数が極端に減っていないか（取得総崩れの検知）。現状39件・最低ラインを20に設定。
const MIN_LAWS = 20;
if (laws.length < MIN_LAWS) errs.push(`laws件数が異常に少ない: ${laws.length} 件 (期待 >= ${MIN_LAWS})`);

// 2) generatedAt が今生成したものか（24時間以内）。古ければ巡回が実は走っていない＝陳腐化。
const gen = Date.parse(idx.generatedAt || '');
if (!gen || (Date.now() - gen) > 24 * 3600 * 1000) errs.push(`generatedAt が古い/不正: ${idx.generatedAt}`);

// 3) 各エントリの健全性: title=law_id（取得失敗のフォールバック）/ article_count 0 / revision_id 空 / 個別JSON欠落・blocks空
for (const l of laws) {
  const id = l.law_id;
  if (!id) { errs.push('law_id が空のエントリがある'); continue; }
  const tag = `${id}（${l.title || '?'}）`;
  if (!l.title || l.title === id) errs.push(`${id}: title が異常（law_idのまま or 空）= "${l.title}"`);
  if (!(l.article_count > 0)) errs.push(`${tag}: article_count = ${l.article_count}（条文0＝空応答の疑い）`);
  if (!l.revision_id) errs.push(`${tag}: revision_id が空（取得失敗の疑い）`);
  const fp = path.join(DATA, `${id}.json`);
  if (!fs.existsSync(fp)) { errs.push(`${tag}: 個別JSON が存在しない`); continue; }
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!Array.isArray(d.blocks) || d.blocks.length === 0) errs.push(`${tag}: 個別JSON の blocks が空`);
  } catch (e) { errs.push(`${tag}: 個別JSON を parse できない`); }
}

// 4) （ソフト・警告のみ）規制ウォッチ data.json が取得でき、空でないか。別リポ・ネットワーク依存のため build は止めない。
function head(url) {
  return new Promise(res => {
    const req = https.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, body: b })); });
    req.on('error', () => res({ status: 0, body: '' })); req.setTimeout(15000, () => { req.destroy(); res({ status: 0, body: '' }); });
  });
}

(async () => {
  try {
    const r = await head('https://finoject.github.io/finoject-reg-monitor/data.json');
    if (r.status !== 200) warns.push(`規制ウォッチ data.json 取得不可（HTTP ${r.status}）`);
    else { const j = JSON.parse(r.body); const n = (j.items || []).length; if (!n) warns.push('規制ウォッチ data.json の items が空'); else console.log(`  規制ウォッチ data.json: ${n} 件 OK`); }
  } catch (e) { warns.push('規制ウォッチ data.json の確認に失敗: ' + (e.message || e)); }

  if (warns.length) { console.log('⚠ 警告（build は止めない）:'); warns.forEach(w => console.log('  - ' + w)); }

  if (errs.length) {
    console.error(`\n✗ データ検証 NG: ${errs.length} 件の異常を検知（Pages公開を中止します）`);
    errs.slice(0, 60).forEach(e => console.error('  - ' + e));
    process.exit(1);
  }
  console.log(`\n✓ データ検証 OK: ${laws.length} 法令。title / article_count / revision_id / 個別JSON blocks すべて正常。`);
})();
