// e-Gov 法令API v2 から対象法令の本文を取得し、条文化して law-viewer-site/data/ に保存。
// 前回の law_revision_id と比較し、変わった法令だけ「更新」として記録する。
// ネットワークは curl 経由（一部環境で Node fetch が繋がらないため）。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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
  if (Array.isArray(n.children)){
    let s = '';
    for (const c of n.children){
      // 定義号などの Column（用語｜定義）間に半角スペースを入れ「番号等 番号…」と読めるようにする
      if (c && c.tag === 'Column' && s && !/\s$/.test(s)) s += ' ';
      s += nodeText(c);
    }
    return s;
  }
  return '';
}

// ===== 漢数字 → 算用数字（実用優先・誤変換ガード付き） =====
const KD = {'〇':0,'零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
const KS = {'十':10,'百':100,'千':1000};
const KB = {'万':1e4,'億':1e8,'兆':1e12};
const NUMCHARS = '〇零一二三四五六七八九十百千万億兆';
const COUNTERS = '条項号年月日時秒円人件倍割種章節款目編回度歳名個所点通'; // 「分・厘」は十分(=じゅうぶん)等の語を守るため除外
const BLOCKWORDS = new Set(['万一']);                                       // 数でない慣用語
const REFCOUNTERS = '条項号章節款目編';                                      // 枝番(○の二)が付く参照単位
// 複数文字の単位語（数字+語＝数量。「四半期」等の語頭が数字の語は含めない）
const COUNTERWORDS = ['事業年度','会計年度','営業年度','営業日','取引日','受渡日','暦日','暦月','暦年','箇月','か月','ヶ月','ケ月','箇年','か年','ヶ年','週間','日以内','年以内','月以内'];
function parseKan(s){
  if (/^[〇零一二三四五六七八九]+$/.test(s)) return [...s].map(c=>KD[c]).join(''); // 桁なし(例 二〇二六→2026)
  let total=0, sec=0, cur=0;
  for (const ch of s){
    if (ch in KD) cur = KD[ch];
    else if (ch in KS){ sec += (cur||1)*KS[ch]; cur=0; }
    else if (ch in KB){ sec += cur; total += sec*KB[ch]; sec=0; cur=0; }
  }
  return String(total + sec + cur);
}
function kanjiNum(text){
  if (!text) return text;
  const re = new RegExp('['+NUMCHARS+']+', 'g');
  let out = text.replace(re, (m, off, str) => {
    if (BLOCKWORDS.has(m)) return m;
    const prev = str[off-1]||'', next = str[off+m.length]||'', prev2 = str[off-2]||'';
    const next2 = str[off+m.length+1]||'', next3 = str[off+m.length+2]||'', prev3 = str[off-3]||'';
    // 変換条件: 2文字以上の数のかたまり / 直後が数詞(第三条→第3条,五年→5年) /
    //           枝番「(条項号等)の二」（の直前が参照単位/数字の時。「業務の一部」等は保護）/
    //           分数・歩合「百分の二・三分の二」（分子/分母とも。「十分な」は分の後が数字でないので保護）
    let convert = m.length >= 2 || COUNTERS.includes(next)
      || COUNTERWORDS.some(w => str.startsWith(w, off + m.length))   // 三事業年度→3事業年度 等
      || (prev === 'の' && (REFCOUNTERS.includes(prev2) || NUMCHARS.includes(prev2)))
      || (next === '分' && next2 === 'の' && NUMCHARS.includes(next3))
      || (prev === 'の' && prev2 === '分' && NUMCHARS.includes(prev3));
    // 「数十年」「何十」「第三者(者は数詞でない)」等は1文字数字を守る
    if (m.length === 1 && (prev === '数' || prev === '何' || prev === '幾')) convert = false;
    return convert ? parseKan(m) : m;
  });
  // 全角の英数字 → 半角（２→2、ＦＡＴＦ→FATF）。全角ハイフン → 半角（Ⅱ－２→Ⅱ-2）
  out = out.replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  out = out.replace(/[－−]/g, '-');
  // 5桁以上の数値に3桁区切りカンマ（実務上の視認性優先。10000000→10,000,000）
  out = out.replace(/\d{5,}/g, s => s.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  return out;
}
// 号・項の番号は必ず数字化（"三の二"→"3の2"、"十の五"→"10の5"。イ/ロ/（１）等の非数字はそのまま）
function forceNum(s){
  if (!s) return s;
  return s.replace(new RegExp('['+NUMCHARS+']+','g'), m => parseKan(m))
          .replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));
}
// 指定タグの見出しテキスト
function childTitle(node, tag){ const c=(node.children||[]).find(x=>x&&x.tag===tag); return c?nodeText(c).trim():''; }
// この階層の文だけ（下位の項・号・各種Title・番号は除外）
function levelSentence(node){
  let s='';
  for(const c of (node.children||[])){
    if(typeof c==='string'){ s+=c; continue; }
    const t=c.tag||'';
    if(/^(Item|Subitem\d+|Paragraph)$/.test(t)) continue;
    if(/Title$/.test(t) || t==='ParagraphNum') continue;
    s+=nodeText(c);
  }
  return s.replace(/[ \t　]*\n[ \t　]*/g,'').replace(/[ \t]{2,}/g,' ').trim(); // 単独スペース(Column区切り)は保持
}
// 条文を 項・号・イロハ ごとに改行し、階層インデント付きで整形
function articleBody(article){
  const lines=[];
  const IND={ Item:'　', Subitem1:'　　', Subitem2:'　　　', Subitem3:'　　　　', Subitem4:'　　　　　' };
  (function walk(node){
    if(!node || typeof node==='string') return;
    const tag=node.tag;
    if(tag==='Paragraph'){
      const num=forceNum(childTitle(node,'ParagraphNum'));
      const body=levelSentence(node);
      const line=((num && num!=='1') ? num+' ' : '') + body;
      if(line.trim()) lines.push(line);
      (node.children||[]).forEach(walk); return;
    }
    if(tag==='Item'){
      lines.push(IND.Item + forceNum(childTitle(node,'ItemTitle')) + ' ' + levelSentence(node));
      (node.children||[]).forEach(walk); return;
    }
    if(/^Subitem\d+$/.test(tag)){
      lines.push((IND[tag]||'　　') + childTitle(node, tag+'Title') + ' ' + levelSentence(node));
      (node.children||[]).forEach(walk); return;
    }
    (node.children||[]).forEach(walk);
  })(article);
  return lines.join('\n');
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
      if (t) blocks.push({ t:'h', lv:LV[tag], x:kanjiNum(nodeText(t).replace(/\s+/g,' ').trim()) });
    }
    if (tag === 'Article'){
      const at  = (n.children||[]).find(c => c && c.tag === 'ArticleTitle');
      const cap = (n.children||[]).find(c => c && c.tag === 'ArticleCaption');
      blocks.push({
        t:'a',
        num: kanjiNum(nodeText(at).trim()),
        cap: cap ? kanjiNum(nodeText(cap).replace(/\s+/g,'').trim()) : '',
        body: kanjiNum(articleBody(n)),
      });
      return; // 条文内はこれ以上降りない
    }
    (n.children||[]).forEach(walk);
  })(root);
  return blocks;
}

// ===== 金融庁 事務ガイドライン（PDF）取得・章節化 =====
const GBASE = 'https://www.fsa.go.jp/common/law/guide/kaisya/';
const GUIDELINES = [
  { key:'fsa-guide-16', file:'16.pdf', title:'事務ガイドライン 第三分冊：16 暗号資産交換業者関係' },
  { key:'fsa-guide-14', file:'14.pdf', title:'事務ガイドライン 第三分冊：14 資金移動業者関係' },
  { key:'fsa-guide-05', file:'05.pdf', title:'事務ガイドライン 第三分冊：5 前払式支払手段発行者関係' },
  { key:'fsa-guide-17', file:'17.pdf', title:'事務ガイドライン 第三分冊：17 電子決済手段等取引業者関係' },
];
const G_HEAD = /^([Ⅰ-Ⅹ](?:[－\-−][０-９\d〇一二三四五六七八九十]+)+)\s*(.*)$/; // Ⅰ－１－２…（節見出し）
const G_CHAP = /^([Ⅰ-Ⅹ])[ 　\t]*([^\d０-９\-－−\s].*)$/;                       // Ⅱ全ての…（章見出し＝ローマ数字[+空白]＋ダッシュ/数字以外で始まる題）
const G_DOTS = /[．\.]{4,}|…/;
function parseGuideline(text){
  // 本文に連結された章見出し（例:「…該当する。Ⅱ全ての…」）を独立行に分離（ローマ数字の直後がダッシュ/数字でない＝章見出し）
  text = text.replace(/。[ \t　]*([Ⅰ-Ⅹ])[ \t　]*([^\d０-９\-－−\s])/g, '。\n$1$2');
  const lines = text.split('\n');
  let lastToc = -1; for (let i=0;i<lines.length;i++) if (G_DOTS.test(lines[i])) lastToc = i; // 目次(ドットリーダー)末尾
  const body = lines.slice(lastToc+1);
  const blocks = []; let cur = null, headCont = false, headIndent = 0;
  const ENDP = /[。」』）)】]$/;                          // 文末・閉じ記号で終わるか
  for (const raw of body){
    const indent = (raw.match(/^[ \t]*/)[0] || '').length;  // 先頭インデント（pdftotext -layout）
    const t = raw.trim(); if (!t) continue;
    if (/^\d{1,4}$/.test(t)) continue;                  // ページ番号のみの行
    const m = t.match(G_HEAD);
    if (m && !G_DOTS.test(t)){
      const num = m[1];
      if (cur && cur.num === num){ headCont = false; continue; }  // ランニングヘッダの重複は無視
      cur = { t:'a', num, cap:m[2].trim(), lines:[] }; blocks.push(cur);
      headIndent = indent; headCont = !ENDP.test(m[2].trim());    // 見出しが文末記号で終わらなければ折り返しの続きを待つ
      continue;
    }
    const c = !G_DOTS.test(t) && t.match(G_CHAP);     // 章見出し（Ⅱ全ての…）
    if (c){
      if (!(cur && cur.num === c[1])){ cur = { t:'a', num:c[1], cap:c[2].trim(), lines:[] }; blocks.push(cur); headIndent = indent; headCont = !ENDP.test(c[2].trim()); }
      continue;
    }
    // 見出しタイトルの折り返し（pdftotext -layoutで続き行は見出しより深く字下げされる。本文は見出しと同程度の浅い字下げ）→ 本文でなく見出しcapに連結
    // 環境によりインデント量が異なる（ローカル≈33/ランナー≈13、本文≈2-6）ため「見出しより8以上深い」を閾値にする
    if (cur && headCont && indent >= headIndent + 8){
      cur.cap += t;
      if (ENDP.test(t)) headCont = false;
      continue;
    }
    headCont = false;
    if (cur) cur.lines.push(t);
  }
  // 箇条書きマーカー(①〜⑳ / イ．ロ． / ・ / ○● / （注） / （数字）)で始まる行で改行、折り返し行は前行に連結
  // ⑴〜⒇はMARKに含めない（文中参照のⅡ-2-2-1-2⑸/イ⑴又はロ⑵等を項目開始と誤認しないため）。正規の箇条書き⑴は下の「。の後で改行」で分割する。
  const MARK = /^(?:[①-⑳]|[ァ-ヴ][．.]|[・○●]|（注|（参考|（別[紙表添]|（[0-9０-９〇一二三四五六七八九十]+）)/;
  const BARE = /^（(?:注|参考|別[紙表添])[0-9０-９]*）?$/;  // 「（注4）」等ラベルのみの行（内容は次行）
  for (const b of blocks){
    const merged = [];
    for (const ln of b.lines){
      const prev = merged[merged.length-1];
      // 折り返し継続、または直前がラベルのみの行（（注4）の内容が次行に来るケース）は連結
      if (merged.length && (!MARK.test(ln) || BARE.test(prev.trim()))) merged[merged.length-1] += ln;
      else merged.push(ln);
    }
    b.num  = kanjiNum(b.num);                                    // Ⅱ－２－１－３ → Ⅱ-2-1-3
    // 正規の箇条書き⑴⑵…⑽は「。」の直後にのみ改行（文中参照の⑴は分割しない＝Ⅱ-2-2-1-2⑸/イ⑴又はロ⑵等を保つ）
    b.body = kanjiNum(merged.join('\n').replace(/。([⑴-⒇])/g,'。\n$1').replace(/[ \t　]/g,''));
    b.cap  = kanjiNum(b.cap.replace(/[ \t　]/g,''));
    delete b.lines;
  }
  return blocks;
}
function fetchGuidelines(prevRec, nowIso, laws, changed, report){
  const tmp = os.tmpdir(), today = nowIso.slice(0,10);
  for (const g of GUIDELINES){
    try {
      const pdf = path.join(tmp, g.key+'.pdf'), txt = path.join(tmp, g.key+'.txt');
      execFileSync('curl', ['-sL','--max-time','90','-A',UA,'-o',pdf, GBASE+g.file], { maxBuffer:300*1024*1024 });
      execFileSync('pdftotext', ['-enc','UTF-8','-layout','-nopgbrk', pdf, txt]);
      const text = fs.readFileSync(txt,'utf8');
      const blocks = parseGuideline(text);
      if (!blocks.length) throw new Error('章節抽出ゼロ');
      const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0,16);
      const prev = prevRec[g.key];
      const updated = (prev && prev.revision_id === hash) ? prev.updated : today; // 内容変化時のみ更新日
      const rec = { law_id:g.key, title:g.title, group:'ガイドライン', type:'事務ガイドライン',
        law_num:'', revision_id:hash, updated, article_count:blocks.length, egov_url:GBASE+g.file };
      laws.push(rec);
      fs.writeFileSync(path.join(DATA, `${g.key}.json`), JSON.stringify({ ...rec, blocks }), 'utf8');
      if (!prev || prev.revision_id !== hash) changed.push(g.title);
      report.push(`${g.title}: ${blocks.length}節 ${prev&&prev.revision_id!==hash?'(更新)':''}`);
    } catch(e){ report.push(`${g.key}: 失敗 ${String(e.message||e).slice(0,70)}`); }
  }
}

function lookupIds(){   // 一時: ランナーでe-Gov v1一覧から対象法令の正確なIDを抽出してログ出力
  const re = /^(銀行法|会社法|会社計算規則|電子公告規則|個人情報)/;
  for (const type of [2,3,4]){
    try {
      const xml = execFileSync('curl',['-sL','--max-time','120','-A',UA,`https://laws.e-gov.go.jp/api/1/lawlists/${type}`],{encoding:'utf8',maxBuffer:300*1024*1024});
      const m = [...xml.matchAll(/<LawId>([^<]+)<\/LawId>\s*<LawName>([^<]+)<\/LawName>/g)];
      let n=0;
      for (const x of m){ if (re.test(x[2].trim())){ console.log(`LOOKUP t${type}: ${x[1]}  ${x[2].trim()}`); n++; } }
      console.log(`LOOKUP type${type} 一致${n}件 / 全${m.length}件`);
    } catch(e){ console.log(`LOOKUP type${type} 失敗: ${String(e.message).slice(0,80)}`); }
  }
}
function main(){
  lookupIds();   // 一時: ID照会ログ（次回コミットで除去）
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive:true });
  const idxPath = path.join(DATA, 'index.json');
  let prev = { laws:[] };
  if (fs.existsSync(idxPath)) { try { prev = JSON.parse(fs.readFileSync(idxPath,'utf8')); } catch{} }
  const prevRev = {}, prevRec = {}; for (const l of prev.laws) { prevRev[l.law_id] = l.revision_id; prevRec[l.law_id] = l; }

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
        law_num: kanjiNum((j.law_info && j.law_info.law_num) || ''),
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

  // 金融庁 事務ガイドライン（PDF）を取得して統合
  fetchGuidelines(prevRec, nowIso, laws, changed, report);

  const isFirst = !prev.laws.length;
  // グループ順を固定
  const G = ['資金決済','犯収法','金商法','ガイドライン'];
  const gi = x => (G.indexOf(x.group) + 1) || 99;   // 未知グループ(会社法等)は末尾
  laws.sort((a,b)=> (gi(a)-gi(b)) || a.title.localeCompare(b.title,'ja'));
  fs.writeFileSync(idxPath, JSON.stringify({ generatedAt: nowIso, laws, changed, isFirst }, null, 2), 'utf8');

  console.log('=== 取得結果 ==='); report.forEach(r => console.log(' - ' + r));
  console.log(`法令数: ${laws.length} / 更新: ${isFirst?'(初回baseline)':changed.length+'件'} -> ${DATA}`);
}
main();
