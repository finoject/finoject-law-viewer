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
// ※ MIN_LAWS だけでは1〜2件の脱落を止められない（39→38でも通る）。前回との突合を 1b) で行う。
const MIN_LAWS = 20;
if (laws.length < MIN_LAWS) errs.push(`laws件数が異常に少ない: ${laws.length} 件 (期待 >= ${MIN_LAWS})`);

// 1b) 前回コミット版（HEAD）との突合。件数の下限だけでは
//     「ガイドライン1件が取得失敗で一覧から消える」「法令が数百条から数条へ縮む」を検知できない。
//     どちらも例外にならず report に1行出るだけなので、ここで止めないと黙って公開される。
//     git が使えない環境（ローカル実行等）では警告に留めて build は止めない。
const { execFileSync } = require('child_process');
let prevIdx = null;
try {
  const raw = execFileSync('git', ['show', 'HEAD:law-viewer-site/data/index.json'],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  prevIdx = JSON.parse(raw);
} catch (e) { warns.push('前回版 index.json を git から取得できず、前回比の検証をスキップしました'); }

if (prevIdx && Array.isArray(prevIdx.laws) && prevIdx.laws.length) {
  const prevById = new Map(prevIdx.laws.map(l => [l.law_id, l]));
  const nowIds = new Set(laws.map(l => l.law_id));
  // 対象法令を運用判断で減らすことはある（統廃合・改称等）。そのときまで公開が止まると困るので、
  // .expected-removals に law_id を1行ずつ書けば、その回に限り削除を許す（コミットに残るので理由も追える）。
  const RMFILE = path.join(__dirname, '.expected-removals');
  let expectedRemovals = new Set();
  try {
    expectedRemovals = new Set(fs.readFileSync(RMFILE, 'utf8').split('\n')
      .map(l => l.replace(/#.*$/, '').trim()).filter(Boolean));
  } catch (e) { /* ファイルが無いのが通常 */ }
  for (const [id, pl] of prevById) {
    if (nowIds.has(id)) continue;
    if (expectedRemovals.has(id)) { console.log(`  意図した削除として許可: ${pl.title || id} (${id})`); continue; }
    errs.push(`前回あった法令が消えた: ${pl.title || id} (${id})` +
      `  ← 意図した削除なら law-viewer/.expected-removals に ${id} を1行足してください`);
  }
  // 逆に、既に消え切った law_id が .expected-removals に残り続けると次の脱落を見逃す。前回にも今回にも無ければ掃除を促す。
  for (const id of expectedRemovals) {
    if (!prevById.has(id) && !nowIds.has(id)) warns.push(`.expected-removals の ${id} は既に不要です（次の脱落を見逃さないよう削除してください）`);
  }
  // 取得に失敗し続けている法令（fetcher.js の keepPrev が前回値を維持し続けている状態）。
  // 一時障害なら数時間で解消するが、当局側のURL変更・廃止だと半永久的に古い内容を出し続ける。
  const STALE_DAYS = 7;
  for (const l of laws) {
    if (!l.staleSince) continue;
    const days = (Date.now() - Date.parse(l.staleSince)) / 86400000;
    if (days >= STALE_DAYS) errs.push(`${l.title || l.law_id}: ${Math.floor(days)}日間 取得に失敗し続けています（前回値を表示中。取得元URLの変更・廃止を確認してください）`);
    else warns.push(`${l.title || l.law_id}: 取得失敗が続いています（${l.staleSince} から前回値を表示中）`);
  }

  const SHRINK_RATIO = 0.5;      // 前回の半分未満まで縮んだら異常
  const SHRINK_MIN   = 10;       // ただし小さな文書の±数条は無視（減少幅10以上のときだけ見る）
  for (const l of laws) {
    const pl = prevById.get(l.law_id);
    if (!pl || !(pl.article_count > 0)) continue;
    const drop = pl.article_count - (l.article_count || 0);
    if (drop >= SHRINK_MIN && (l.article_count || 0) < pl.article_count * SHRINK_RATIO) {
      // 全面改正・統廃合で条数が正当に大きく減ることはある。削除と同じく .expected-removals で許可する。
      if (expectedRemovals.has(l.law_id)) { console.log(`  意図した条数変更として許可: ${l.title || l.law_id}（${pl.article_count} → ${l.article_count}）`); continue; }
      errs.push(`${l.title || l.law_id}: 条数が激減 ${pl.article_count} → ${l.article_count}（部分応答の疑い）` +
        `  ← 正当な全面改正なら law-viewer/.expected-removals に ${l.law_id} を1行足してください`);
    }
  }
}

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
