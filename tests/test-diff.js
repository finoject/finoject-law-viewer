// 改正差分の条ペアリングの回帰テスト。
// 修正前は「条番号＋出現順」だけで対応付けていたため、改正附則が1本挿入されると
// 以降の同番号条が1つずつズレ、無改正の条が大量に changed として立った。
const assert = require('assert');
const DIFF = require('../law-viewer/diff.js');
const { computeArticleDiff } = DIFF;

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); }
                          catch(e){ fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const a = (num, body, cap) => ({ t:'a', num, body, cap: cap || '' });
const h = (x, lv) => ({ t:'h', lv, x });

// 本則 + 附則A + 附則B
const OLD = [
  h('第1章 総則', 2), a('第1条', '目的の本文', '（目的）'), a('第2条', '定義の本文', '（定義）'),
  h('附　則', 1),                         a('第1条', '旧・施行期日A'),
  h('附　則（令和4年法律第61号）', 1),    a('第1条', '旧・施行期日B'),
];
// 途中に新しい附則が1本増えただけ（既存条文は無改正）
const NEW = [
  h('第1章 総則', 2), a('第1条', '目的の本文', '（目的）'), a('第2条', '定義の本文', '（定義）'),
  h('附　則', 1),                         a('第1条', '旧・施行期日A'),
  h('附　則（令和7年法律第66号）', 1),    a('第1条', '新設の施行期日'),
  h('附　則（令和4年法律第61号）', 1),    a('第1条', '旧・施行期日B'),
];

t('附則が1本挿入されても、無改正の条は changed にならない', () => {
  const d = computeArticleDiff(OLD, NEW);
  const changed = d.filter(x => x.status === 'changed');
  assert.deepStrictEqual(changed, [], '無改正の条が changed になっています: ' + JSON.stringify(changed));
});

t('挿入された附則の条だけが added になる', () => {
  const d = computeArticleDiff(OLD, NEW);
  const added = d.filter(x => x.status === 'added');
  assert.strictEqual(added.length, 1, 'added が1件でない: ' + JSON.stringify(d));
  assert.strictEqual(added[0].new, '新設の施行期日');
});

t('deleted は出ない', () => {
  const d = computeArticleDiff(OLD, NEW);
  assert.strictEqual(d.filter(x => x.status === 'deleted').length, 0, JSON.stringify(d));
});

t('同じ節の中で本当に本文が変わった条は changed になる（検出力を落としていない）', () => {
  const N2 = JSON.parse(JSON.stringify(NEW));
  N2[1].body = '目的の本文（改正後）';
  const d = computeArticleDiff(OLD, N2);
  const changed = d.filter(x => x.status === 'changed');
  assert.strictEqual(changed.length, 1, JSON.stringify(d));
  assert.strictEqual(changed[0].num, '第1条');
  assert.strictEqual(changed[0].new, '目的の本文（改正後）');
});

t('附則が丸ごと削除されたら deleted として出る', () => {
  const N3 = OLD.filter((_, i) => i < 4 + 1);   // 附則B の見出しと条を落とす
  const d = computeArticleDiff(OLD, N3);
  const del = d.filter(x => x.status === 'deleted');
  assert.strictEqual(del.length, 1, JSON.stringify(d));
  assert.strictEqual(del[0].old, '旧・施行期日B');
});

t('見出しが1つも無いデータ（ガイドライン等）でも従来どおり動く', () => {
  const O = [a('1-1', 'あ'), a('1-2', 'い')];
  const N = [a('1-1', 'あ'), a('1-2', 'いろ')];
  const d = computeArticleDiff(O, N);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].status, 'changed');
  assert.strictEqual(d[0].num, '1-2');
});

// ---- 2026-09-17 codex の修正後レビューで実測された回帰への対応 ----
t('附則見出しの表記ゆれ（空白・全角数字）で changed が added+deleted に化けない', () => {
  const O = [h('附　則（令和4年法律第61号）', 1), a('第1条', '旧文')];
  const N = [h('附 則（令和４年法律第６１号）', 1), a('第1条', '新文')];
  assert.deepStrictEqual(computeArticleDiff(O, N).map(x => x.status), ['changed'],
    '見出しの表記が揺れただけで別の節と判定されています');
});

t('附則以外の lv1 見出し（編等）が増えても節は変わらない', () => {
  const O = [h('附　則', 1), a('第1条', '旧文')];
  const N = [h('附　則', 1), h('編', 1), a('第1条', '新文')];
  assert.deepStrictEqual(computeArticleDiff(O, N).map(x => x.status), ['changed']);
});

t('★別の改正附則へ移った条は、正しく added + deleted になる（検出力を落としていない）', () => {
  const O = [h('附則（令和4年法律第61号）', 1), a('第1条', '文')];
  const N = [h('附則（令和7年法律第66号）', 1), a('第1条', '文')];
  const d = computeArticleDiff(O, N);
  assert.deepStrictEqual(d.map(x => x.status).sort(), ['added', 'deleted'],
    '別の附則の同番号条を同一視しています');
});

t('正常系: 変更が無ければ差分は空（回帰）', () => {
  assert.deepStrictEqual(computeArticleDiff(OLD, JSON.parse(JSON.stringify(OLD))), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
