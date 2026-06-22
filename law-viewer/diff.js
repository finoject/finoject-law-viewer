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

// blocks(t:'a') を突き合わせ、変化した条だけ {status,num,cap,old?,new?} の配列で返す。
function computeArticleDiff(oldBlocks, newBlocks){
  const arts = bs => (bs||[]).filter(b => b && b.t === 'a');
  const oldA = arts(oldBlocks), newA = arts(newBlocks);
  const oldByNum = {};
  for (const b of oldA){ (oldByNum[b.num] = oldByNum[b.num] || []).push(b); }   // num→出現順キュー
  const used = new Set();
  const out = [];
  for (const nb of newA){
    const q = oldByNum[nb.num];
    const ob = (q && q.length) ? q.shift() : null;          // 同番号は出現順に対応付け
    if (!ob){ out.push({ status:'added', num:nb.num, cap:nb.cap || '', new:nb.body || '' }); continue; }
    used.add(ob);
    if ((ob.body || '') !== (nb.body || '') || (ob.cap || '') !== (nb.cap || '')){
      out.push({ status:'changed', num:nb.num, cap:nb.cap || '', oldCap:ob.cap || '', old:ob.body || '', new:nb.body || '' });
    }
  }
  for (const ob of oldA){ if (!used.has(ob)) out.push({ status:'deleted', num:ob.num, cap:ob.cap || '', old:ob.body || '' }); }  // 旧側で対応の付かなかった条＝削除（文書順）
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
