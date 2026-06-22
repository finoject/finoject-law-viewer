'use strict';
// ===== 改正差分の遡及生成（git履歴から）=====
// 目的: fetcher.js は「次に巡回でrevisionが変わったとき」から差分を出すが、
//       過去の改正分を今すぐ見せるため、git履歴をさかのぼって「直近で revision_id が変わった版」を探し、
//       その旧版と現行版の条文差分を data/diff/{id}.json として一括生成する。
// 使い方: cd law-viewer && node make-diffs.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const DIFF = require('./diff.js');

const SITE = path.join(__dirname, '..', 'law-viewer-site');
const DATA = path.join(SITE, 'data');
const REPO = path.join(__dirname, '..');                       // gitリポジトリのルート
const rel = id => `law-viewer-site/data/${id}.json`;          // リポジトリ相対パス（git用・スラッシュ固定）

function git(args){ return execFileSync('git', args, { cwd:REPO, encoding:'utf8', maxBuffer:300*1024*1024 }); }
function showAt(hash, relPath){ try { return JSON.parse(git(['show', `${hash}:${relPath}`])); } catch(e){ return null; } }

function main(){
  const files = fs.readdirSync(DATA).filter(f => /\.json$/.test(f) && f !== 'index.json' && f !== 'market.json');
  let made = 0, scanned = 0;
  for (const f of files){
    const id = f.replace(/\.json$/, '');
    let cur; try { cur = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch(e){ continue; }
    if (!cur || !cur.blocks || !('revision_id' in cur)) continue;     // 法令データ以外（market等）は除外
    scanned++;
    // この法令ファイルを変更したコミットを新しい順に列挙
    let hashes = [];
    try { hashes = git(['log', '--format=%H', '--', rel(id)]).split('\n').filter(Boolean); } catch(e){}
    // 新しい順に辿り、現行と revision_id が異なる最初の版＝「改正前」を探す
    let before = null;
    for (const h of hashes.slice(0, 80)){
      const v = showAt(h, rel(id));
      if (v && v.revision_id && v.revision_id !== cur.revision_id){ before = v; break; }
    }
    if (!before) continue;                                            // 過去に改正が無い（baseline以降変化なし）
    const arts = DIFF.computeArticleDiff(before.blocks, cur.blocks);
    if (!arts.length) continue;
    DIFF.writeLawDiff(DATA, { law_id:id, title:cur.title, group:cur.group || '', type:cur.type || '',
      from_revision:before.revision_id, to_revision:cur.revision_id, to_updated:cur.updated || '' }, arts);
    made++;
    console.log(` - ${cur.title}: ${arts.length}条 (変更${arts.filter(a=>a.status==='changed').length}/追加${arts.filter(a=>a.status==='added').length}/削除${arts.filter(a=>a.status==='deleted').length})`);
  }
  const diffs = DIFF.writeDiffIndex(DATA);
  console.log(`=== 遡及生成完了: ${scanned}法令を走査 / ${made}法令に差分生成 / index=${diffs.length}件 ===`);
}
main();
