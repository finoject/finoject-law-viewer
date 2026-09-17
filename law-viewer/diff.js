'use strict';
// ===== 改正差分（新旧対照）生成の共通ロジック =====
// fetcher.js（前進生成：巡回時にrevisionが変わった法令の差分を出力）と
// make-diffs.js（遡及生成：git履歴の旧版から差分を一括生成）で共用する。
// 設計方針:
//  - 「改正条文のみ」を出力する（全文diffではなく、実務者が確認すべき差分だけ）。
//  - 条は num（条番号）＋出現順でペアリング（附則等で番号が重複しても順序で対応）。
//  - 本文/見出しが変わった条＝changed、新側だけ＝added、旧側だけ＝deleted。
//  - 旧本文・新本文は全文を保持し、語句レベルのハイライトはフロント側で行う（データは素直に）。
const fs = require('fs');
const path = require('path');

// ※ 同じ展開ロジックが law-viewer-site/index.html の blockPlainText() にもある（Node と ブラウザで
//    共有できないため意図的な二重実装）。**片方だけ直すと差分検出と検索/AI入力がズレる**。必ず両方直すこと。
// ブロックの比較・表示用テキスト。本文の表占位子 ⟦TBL:i⟧ を実際の表テキストへ展開する。
// 別表は本文が占位子だけで実文が tables にあるため、body だけを比較すると
// 「別表のセルが改正されても差分に一切現れない」という検出漏れになる（条文内の読替表も同じ）。
// フロントの新旧対照は文字単位LCSなので、展開したテキストをそのまま渡してよい。
function blockText(b){
  if (!b) return '';
  const tbl = i => {
    const t = b.tables && b.tables[i];
    if (!t) return '';
    const rows = t.rows || t;
    return rows.map(r => ((r && r.cells) || []).map(c => ((c && c.t) || '').replace(/\n/g, ' ')).join(' ｜ ')).join('\n');
  };
  return (b.body || '').replace(/⟦TBL:(\d+)⟧/g, (m, i) => tbl(+i));
}
// 条を「どの節（本則／どの改正附則）に属するか」で区別するためのキー。
// 条番号だけでは足りない: 実測で39法令中35法令が同じ条番号を複数持ち、金商法は「第1条」が105回出る。
// 直前の lv1 見出し（e-Gov の SupplProvision ラベル＝「附　則（令和7年6月13日法律第66号）」等）を接頭辞にする。
// これが無いと、途中に改正附則が1本挿入されただけで以降の同番号条が1つずつズレて対応し、
// 実際には無改正の条が大量に changed として差分一覧に立つ。
const SUPPL_HEAD = /附\s*則/;                                          // 附則の扉（e-Gov の SupplProvisionLabel 由来）
const AMEND_NUM  = /((?:明治|大正|昭和|平成|令和)[^（）()]*?第[０-９0-9]+号)/;  // 「令和7年6月13日法律第66号」
const zen2han = t => t.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
// 条が属する節（本則 / どの改正附則か）を表すキー。
// 見出しの文字列そのものを使うと、全角空白の有無などの表記ゆれだけで別の節と判定され、
// 無改正の条が changed でなく added+deleted に化ける（2026-09-17 の再レビューで実測）。
// 改正法令番号だけを取り出して正規化し、番号の無い制定時附則は固定キーにする。
// 附則以外の lv1 見出し（編・章の扉など）は節の切れ目として扱わない。
function sectionKey(x){
  const m = (x || '').match(AMEND_NUM);
  return m ? zen2han(m[1]).replace(/[\s　]/g, '') : '附則(制定時)';
}
function sectionKeys(blocks){
  const keys = new Map(); let sec = '';
  for (const b of (blocks||[])){
    if (!b) continue;
    if (b.t === 'h'){ if ((b.lv|0) <= 1 && SUPPL_HEAD.test(b.x || '')) sec = sectionKey(b.x); continue; }
    if (b.t === 'a') keys.set(b, sec + '\u0000' + (b.num || ''));
  }
  return keys;
}
// blocks(t:'a') を突き合わせ、変化した条だけ {status,num,cap,old?,new?} の配列で返す。
function computeArticleDiff(oldBlocks, newBlocks){
  const arts = bs => (bs||[]).filter(b => b && b.t === 'a');
  const oldA = arts(oldBlocks), newA = arts(newBlocks);
  const oldKey = sectionKeys(oldBlocks), newKey = sectionKeys(newBlocks);
  const oldByNum = {};
  for (const b of oldA){ const k = oldKey.get(b) || ('\u0000' + (b.num||'')); (oldByNum[k] = oldByNum[k] || []).push(b); }   // 節+num→出現順キュー
  const used = new Set();
  const out = [];
  for (const nb of newA){
    const k = newKey.get(nb) || ('\u0000' + (nb.num||''));
    const q = oldByNum[k];
    const ob = (q && q.length) ? q.shift() : null;          // 同じ節の同番号どうしを出現順に対応付け
    if (!ob){ out.push({ status:'added', num:nb.num, cap:nb.cap || '', new:blockText(nb) }); continue; }
    used.add(ob);
    const oldT = blockText(ob), newT = blockText(nb);       // 表の中身まで含めて比較する（別表・読替表の改正を取りこぼさない）
    if (oldT !== newT || (ob.cap || '') !== (nb.cap || '')){
      out.push({ status:'changed', num:nb.num, cap:nb.cap || '', oldCap:ob.cap || '', old:oldT, new:newT });
    }
  }
  for (const ob of oldA){ if (!used.has(ob)) out.push({ status:'deleted', num:ob.num, cap:ob.cap || '', old:blockText(ob) }); }  // 旧側で対応の付かなかった条＝削除（文書順）
  return out;
}

// 1法令分の差分ファイルを書く（差分が無ければ書かない＝旧い差分を温存）。
// meta: { law_id, title, group, type, from_revision, to_revision, to_updated }
function writeLawDiff(DATA, meta, articles){
  if (!articles || !articles.length) return false;
  const DIFF = path.join(DATA, 'diff');
  if (!fs.existsSync(DIFF)) fs.mkdirSync(DIFF, { recursive:true });
  const rec = { ...meta, generatedAt:new Date().toISOString(), articles };
  fs.writeFileSync(path.join(DIFF, `${meta.law_id}.json`), JSON.stringify(rec), 'utf8');
  return true;
}

// 旧ファイル（上書き前のdata/{id}.json）を読み、revision変化かつ条文差分があれば差分を書く。
// 巡回時(fetcher)の3経路（法令/事務GL/監督指針）から1行で呼べるようにした薄いラッパ。
function maybeWriteDiff(DATA, oldFilePath, newBlocks, meta){
  if (!meta.from_revision || meta.from_revision === meta.to_revision) return false;   // 初回baseline/変化なしはスキップ
  let oldData = null;
  try { oldData = JSON.parse(fs.readFileSync(oldFilePath, 'utf8')); } catch(e){ return false; }
  if (!oldData || !oldData.blocks) return false;
  const arts = computeArticleDiff(oldData.blocks, newBlocks);
  return writeLawDiff(DATA, meta, arts);
}

// data/diff/ 配下の全差分を走査して index.json を再構築（蓄積した差分の一覧。新しい改正日が上）。
function buildDiffIndex(DATA){
  const DIFF = path.join(DATA, 'diff');
  const out = [];
  if (!fs.existsSync(DIFF)) return out;
  for (const f of fs.readdirSync(DIFF)){
    if (!/\.json$/.test(f) || f === 'index.json') continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIFF, f), 'utf8'));
      if (!d.articles || !d.articles.length) continue;
      const c = { changed:0, added:0, deleted:0 };
      for (const a of d.articles) c[a.status] = (c[a.status] || 0) + 1;
      out.push({ law_id:d.law_id, title:d.title, group:d.group || '', type:d.type || '',
        to_updated:d.to_updated || '', generatedAt:d.generatedAt || '', counts:c });
    } catch(e){}
  }
  out.sort((a,b)=> String(b.to_updated).localeCompare(String(a.to_updated)) || String(b.generatedAt).localeCompare(String(a.generatedAt)));
  return out;
}

function writeDiffIndex(DATA){
  const DIFF = path.join(DATA, 'diff');
  if (!fs.existsSync(DIFF)) fs.mkdirSync(DIFF, { recursive:true });
  const diffs = buildDiffIndex(DATA);
  fs.writeFileSync(path.join(DIFF, 'index.json'), JSON.stringify({ generatedAt:new Date().toISOString(), diffs }, null, 2), 'utf8');
  return diffs;
}

module.exports = { computeArticleDiff, writeLawDiff, maybeWriteDiff, buildDiffIndex, writeDiffIndex };
