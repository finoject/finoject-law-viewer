// 前条/次条の解決が「文書順の位置」で行われることの回帰テスト。
// 修正前は条番号をキーにしていたため、附則の「第1条」から「次条」を辿ると
// 本則の「第2条」へ飛んでいた（実データ: 39法令中35法令で同一条番号が重複。金商法は最大105回）。
const fs = require('fs'), path = require('path'), assert = require('assert');

// index.html から対象関数だけを取り出して評価する（本番コードを書き写さない＝本番を壊せばテストも落ちる）
const html = fs.readFileSync(path.join(__dirname, '..', 'law-viewer-site', 'index.html'), 'utf8');
function grab(name){
  const i = html.indexOf('function ' + name + '(');
  assert.ok(i > 0, name + ' が index.html に見つかりません');
  let d = 0, started = false, j = i;
  for (; j < html.length; j++){
    const c = html[j];
    if (c === '{'){ d++; started = true; }
    else if (c === '}'){ d--; if (started && d === 0){ j++; break; } }
  }
  return html.slice(i, j);
}
const src = grab('relArt') + '\n' + grab('resolveRel');
const sandbox = { ARTSEQ: [], ARTIDX: {}, ARTSET: new Set() };
const run = new Function('ctx', 'with(ctx){ ' + src + '; return { relArt, resolveRel }; }');
const { relArt, resolveRel } = run(sandbox);

function loadLaw(id){
  const p = path.join(__dirname, '..', 'law-viewer-site', 'data', id + '.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  sandbox.ARTSEQ = d.blocks.filter(b => b.t !== 'h').map(b => ({ num: b.num || '', ap: !!b.ap }));
  sandbox.ARTIDX = {}; sandbox.ARTSEQ.forEach((x,i)=>{ if(x.num && !x.ap && sandbox.ARTIDX[x.num]==null) sandbox.ARTIDX[x.num]=i; });
  sandbox.ARTSET = new Set(sandbox.ARTSEQ.filter(x=>x.num && !x.ap).map(x=>x.num));
  return d;
}

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); }
                          catch(e){ fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

// ---- 資金決済法（「第1条」が13回出る）----
const SHIKIN = '421AC0000000059';
const d = loadLaw(SHIKIN);

t('前提: 同じ条番号が複数回出る法令であること', () => {
  const c = {}; sandbox.ARTSEQ.filter(x=>x.num&&!x.ap).forEach(x=>c[x.num]=(c[x.num]||0)+1);
  const dup = Object.entries(c).filter(([,v])=>v>1);
  assert.ok(dup.length >= 10, '重複する条番号が想定より少ない: ' + dup.length);
});

// 「第1条」の全出現位置を集める
const firstArtPositions = sandbox.ARTSEQ.map((x,i)=>x.num==='第1条'&&!x.ap?i:-1).filter(i=>i>=0);

t('各「第1条」の「次条」は、その直後に実在する条を指す', () => {
  assert.ok(firstArtPositions.length > 5, '「第1条」の出現が少なすぎます');
  for (const pos of firstArtPositions){
    const r = relArt('第1条', 1, pos);
    if (!r) continue;                                  // 文書末尾は解決不能でよい
    assert.strictEqual(r.seq, pos + 1, `位置${pos}の次条が隣接していません (got seq=${r.seq})`);
    assert.strictEqual(r.num, sandbox.ARTSEQ[pos+1].num, `位置${pos}の次条の番号が不一致`);
  }
});

t('★修正前の挙動（番号キー）なら全て本則の同じ条へ潰れることを示す', () => {
  // 修正前相当: ARTIDX[num] を起点にする＝seq を渡さない
  const collapsed = new Set(firstArtPositions.map(() => {
    const r = relArt('第1条', 1, null); return r ? r.seq : null;
  }));
  assert.strictEqual(collapsed.size, 1, '番号キーの解決は1点に潰れるはず');
  // 位置を渡した場合は複数の異なる条へ散る＝修正が効いている
  const spread = new Set(firstArtPositions.map(pos => { const r = relArt('第1条', 1, pos); return r ? r.seq : null; }));
  assert.ok(spread.size > 5, '位置指定でも1点に潰れています（修正が効いていません）: ' + spread.size);
});

t('前条は直前に実在する条を指す', () => {
  for (const pos of firstArtPositions){
    const r = relArt('第1条', -1, pos);
    if (!r) continue;
    assert.strictEqual(r.seq, pos - 1, `位置${pos}の前条が隣接していません`);
  }
});

t('前々条・次々条は2つ飛ぶ', () => {
  const pos = firstArtPositions[firstArtPositions.length - 1];
  const n2 = relArt('第1条', 2, pos);
  if (n2) assert.strictEqual(n2.seq, pos + 2);
  const p2 = relArt('第1条', -2, pos);
  if (p2) assert.strictEqual(p2.seq, pos - 2);
});

t('文書の端では null を返す', () => {
  assert.strictEqual(relArt('第1条', -1, 0), null, '先頭の前条は解決不能であるべき');
  assert.strictEqual(relArt('第1条', 1, sandbox.ARTSEQ.length - 1), null, '末尾の次条は解決不能であるべき');
});

t('別表・様式(ap)は「条」として数えない', () => {
  // 人工データで検証（実データに ap は無いが、フロントは ap を持つ前提で動く）
  const saved = sandbox.ARTSEQ;
  sandbox.ARTSEQ = [{num:'第1条',ap:false},{num:'別表第一',ap:'別表'},{num:'第2条',ap:false}];
  const r = relArt('第1条', 1, 0);
  assert.strictEqual(r && r.num, '第2条', '別表を1条ぶんと数えてしまっています');
  assert.strictEqual(r.seq, 2);
  sandbox.ARTSEQ = saved;
});

t('resolveRel が位置(seq)を返し、リンクに載せられる', () => {
  const pos = firstArtPositions[3];
  const r = resolveRel('次条', { aid:'第1条', seq:pos, curPara:1, myId:SHIKIN, antLaw:null, antArt:null, antPara:null });
  assert.ok(r, '解決できませんでした');
  assert.strictEqual(typeof r.seq, 'number', 'seq がリンクに載りません');
  assert.strictEqual(r.seq, pos + 1);
  assert.strictEqual(typeof r.art, 'string', 'art は条番号の文字列であるべき');
});

// ---- 条ジャンプ(scrollTo)の安全側の挙動（2026-09-17 grok の再レビュー指摘への対応）----
// 位置(i=)が指定されているのに該当要素が無いとき、番号一致で別の条へ黙って飛ばないこと。
t('位置指定が外れたとき、同じ条番号が複数あるなら番号一致へ落とさない', () => {
  const src = html;
  const i = src.indexOf('const scrollTo = () => {');
  assert.ok(i > 0, 'scrollTo が見つかりません');
  const body = src.slice(i, src.indexOf('};', i));
  assert.ok(/hits\.length > 1\) \? null : hits\[0\]/.test(body),
    '位置指定が外れたときに番号一致へ無条件フォールバックしています');
  assert.ok(/t\.dataset\.num !== dec/.test(body),
    '位置指定と条番号の食い違いを確かめていません');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
