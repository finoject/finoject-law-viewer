// e-Gov 法令API v2 から対象法令の本文を取得し、条文化して law-viewer-site/data/ に保存。
// 前回の law_revision_id と比較し、変わった法令だけ「更新」として記録する。
// ネットワークは curl 経由（一部環境で Node fetch が繋がらないため）。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const API = 'https://laws.e-gov.go.jp/api/2';
const SITE = path.join(__dirname, '..', 'law-viewer-site');
const DATA = path.join(SITE, 'data');
const UA = 'Mozilla/5.0 (compatible; finoject-law-viewer/1.0)';

// 対象法令（暗号資産・決済の中核 ＋ 関連政省令/内閣府令）。law_idは安定なので直接指定。
const TARGETS = [
  { law_id:'421AC0000000059', group:'資金決済', type:'法律' },     // 資金決済に関する法律
  { law_id:'422CO0000000019', group:'資金決済', type:'政令' },     // 同 施行令
  { law_id:'429M60000002007', group:'資金決済', type:'内閣府令' }, // 暗号資産交換業者に関する内閣府令
  { law_id:'422M60000002004', group:'資金決済', type:'内閣府令' }, // 資金移動業者に関する内閣府令
  { law_id:'422M60000002003', group:'資金決済', type:'内閣府令' }, // 前払式支払手段に関する内閣府令
  { law_id:'505M60000002048', group:'資金決済', type:'内閣府令' }, // 電子決済手段等取引業者に関する内閣府令
  { law_id:'419AC0000000022', group:'犯収法',   type:'法律' },     // 犯罪による収益の移転防止に関する法律
  { law_id:'420CO0000000020', group:'犯収法',   type:'政令' },     // 同 施行令
  { law_id:'420M60000F5A001', group:'犯収法',   type:'命令' },     // 同 施行規則
  { law_id:'323AC0000000025', group:'金商法',   type:'法律' },     // 金融商品取引法
  { law_id:'340CO0000000321', group:'金商法',   type:'政令' },     // 同 施行令
  { law_id:'419M60000002052', group:'金商法',   type:'内閣府令' }, // 金融商品取引業等に関する内閣府令
];

function curlText(url){
  return execFileSync('curl', ['-sL','--max-time','60','-A',UA,url], { encoding:'utf8', maxBuffer: 300*1024*1024 });
}
function curlJson(url){ return JSON.parse(curlText(url)); }

// タイトル完全一致で law_id を解決
function resolveLawId(title){
  const j = curlJson(`${API}/keyword?keyword=${encodeURIComponent(title)}&limit=50`);
  for (const it of (j.items||[])){
    if (it.revision_info && it.revision_info.law_title === title) return it.law_info.law_id;
  }
  return null;
}

// ツリーからテキスト抽出
function nodeText(n){
  if (n == null) return '';
  if (typeof n === 'string') return n;
  if (Array.isArray(n.children)) return n.children.map(nodeText).join('');
  return '';
}
// 条文・見出しを文書順に blocks 化
function extractBlocks(root){
  const blocks = [];
  const LV = { Part:1, Chapter:2, Section:3, Subsection:4, Division:5 };
  (function walk(n){
    if (!n || typeof n === 'string') return;
    const tag = n.tag;
    if (LV[tag]){
      const t = (n.children||[]).find(c => c && c.tag && /Title$/.test(c.tag));
      if (t) blocks.push({ t:'h', lv:LV[tag], x:nodeText(t).replace(/\s+/g,' ').trim() });
    }
    if (tag === 'Article'){
      const at  = (n.children||[]).find(c => c && c.tag === 'ArticleTitle');
      const cap = (n.children||[]).find(c => c && c.tag === 'ArticleCaption');
      const paras = [];
      (function rec(m){
        if (!m || typeof m === 'string') return;
        if (m.tag === 'Paragraph'){ paras.push(nodeText(m).replace(/[ \t]+/g,' ').replace(/\s*\n\s*/g,'\n').trim()); return; }
        (m.children||[]).forEach(rec);
      })(n);
      blocks.push({ t:'a', num:nodeText(at).trim(), cap:cap?nodeText(cap).replace(/\s+/g,'').trim():'', body:paras.join('\n') });
      return; // 条文内はこれ以上降りない
    }
    (n.children||[]).forEach(walk);
  })(root);
  return blocks;
}

function main(){
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive:true });
  const idxPath = path.join(DATA, 'index.json');
  let prev = { laws:[] };
  if (fs.existsSync(idxPath)) { try { prev = JSON.parse(fs.readFileSync(idxPath,'utf8')); } catch{} }
  const prevRev = {}; for (const l of prev.laws) prevRev[l.law_id] = l.revision_id;

  const nowIso = new Date().toISOString();
  const laws = []; const changed = []; const report = [];

  for (const tgt of TARGETS){
    const id = tgt.law_id;
    try {
      const j = curlJson(`${API}/law_data/${id}`);
      const ri = j.revision_info || {};
      const title = ri.law_title || id;
      const blocks = extractBlocks(j.law_full_text);
      const articleCount = blocks.filter(b => b.t === 'a').length;
      const rec = {
        law_id: id, title, group: tgt.group, type: tgt.type,
        law_num: (j.law_info && j.law_info.law_num) || '',
        revision_id: ri.law_revision_id || '', updated: ri.updated || '',
        article_count: articleCount,
        egov_url: `https://laws.e-gov.go.jp/law/${id}`,
      };
      laws.push(rec);
      fs.writeFileSync(path.join(DATA, `${id}.json`), JSON.stringify({ ...rec, blocks }), 'utf8');
      if (prevRev[id] !== rec.revision_id) changed.push(title);
      report.push(`${title}: ${id} / ${articleCount}条 ${prevRev[id]&&prevRev[id]!==rec.revision_id?'(更新)':''}`);
    } catch(e){ report.push(`${id}: 失敗 ${String(e.message||e).slice(0,60)}`); }
  }

  const isFirst = !prev.laws.length;
  // グループ順を固定
  const G = ['資金決済','犯収法','金商法'];
  laws.sort((a,b)=> (G.indexOf(a.group)-G.indexOf(b.group)) || a.title.localeCompare(b.title,'ja'));
  fs.writeFileSync(idxPath, JSON.stringify({ generatedAt: nowIso, laws, changed, isFirst }, null, 2), 'utf8');

  console.log('=== 取得結果 ==='); report.forEach(r => console.log(' - ' + r));
  console.log(`法令数: ${laws.length} / 更新: ${isFirst?'(初回baseline)':changed.length+'件'} -> ${DATA}`);
}
main();
