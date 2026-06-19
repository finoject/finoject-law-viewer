// push された差分を Claude(Sonnet) にレビューさせ、結果を review.md に書き出す（GitHub Actions から実行）。
// 指摘の出力先(Issueへの投稿)はワークフロー側(gh)が担当。ここは「差分→レビュー本文」の生成だけ。
// APIキーは GitHub secret(ANTHROPIC_API_KEY)。差分が無い/キー未設定なら空ファイルを書き投稿をスキップさせる。
const fs = require('fs');

const KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = process.env.REVIEW_MODEL || 'claude-sonnet-4-6';
const sha = (process.env.COMMIT_SHA || '').slice(0, 7);
const msg = (process.env.COMMIT_MSG || '').split('\n')[0];
let diff = '';
try { diff = fs.readFileSync(process.env.DIFF_FILE || 'diff.patch', 'utf8'); } catch {}
diff = diff.slice(0, 120000);   // トークン/コスト制御（先頭12万字＝概ね3万トークン）

function skip(reason){ console.log('レビュースキップ: ' + reason); fs.writeFileSync('review.md', ''); process.exit(0); }
if (!diff.trim()) skip('対象ソースの差分なし');
if (!KEY) skip('ANTHROPIC_API_KEY 未設定（GitHub secretに登録すると有効化）');

const RULES = `【三根さんの恒久ルール（遵守をチェックすること）】
- すべての表示整形・機能改善は特定法令の個別対応でなく「汎用実装」にし、全法令・諸規則・事務ガイドライン＋今後追加分にも自動適用すること（個別ハードコードで一部だけ対応は不可）。
- 元データ(law-viewer-site/data/*.json 等)は改変しない。整形は表示側(render)で行う。表を区切り文字やセンチネル(制御文字)で表すのは禁止＝本物のHTMLテーブルで。
- AI/外部APIのキーをクライアント(静的配信)に絶対出さない。秘密は Cloudflare Worker secret 等に置く。
- 本文中の参照リンクは新しいタブで開く。既存機能(全文/横断検索・参照/相対参照リンク・定義ポップアップ・規制フィード・市況バー・リサイズ/並び替え・AI解説)を壊さない「純加算」で。
- 既定モデルは claude-opus-4-8（コスト都合での Haiku/Sonnet 利用は明示選択時のみ）。`;

const system = `あなたは「finoject 法令ビューア」（日本の金融規制の条文閲覧＋規制ウォッチ＋AI解説。単一HTML/JSフロント＋Cloudflare Worker＋Node巡回スクリプトで構成）の経験豊富な上級レビュアー兼コンプライアンス実務者です。直近コミットの差分を読み、次の観点で率直かつ建設的にレビューします: ①実務価値（金融コンプラ実務者に本当に有益か）②正確性（法令・条番号・用語の誤り）③退行/バグ（既存機能を壊していないか、エッジケース）④セキュリティ（APIキー漏洩・XSS・プロキシ悪用・入力検証）⑤パフォーマンス（巨大法令・大量項目での描画/取得）⑥${RULES}

出力ルール: 日本語のMarkdown。最初に1〜2行の総評。続けて深刻度別の見出し「🔴 重大 / 🟡 中 / 🟢 軽微 / 💡 提案」を使い、各指摘は『該当ファイル: 何が問題か → どう直すか』を1〜3文で具体的に。確信度や重要度で取捨せず気づいた点は漏れなく挙げる（フィルタは人間が行う）。良い点も簡潔に1〜2点。該当の無い深刻度の見出しは省略。最後に「### 次の一手」を最大3つ、優先度順に。差分に無いことは推測で断定しない。`;
const user = `コミット: ${sha}\nメッセージ: ${msg}\n\n=== 変更差分 (unified diff) ===\n${diff}`;

(async () => {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 8000, system,          // thinkingもmax_tokensを消費するため余裕を持たせる（空応答防止）
        messages: [{ role: 'user', content: user }],
        thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
      }),
    });
    if (!r.ok) { const t = await r.text(); fs.writeFileSync('review.md', `### ⚠ AI自動レビュー失敗 — \`${sha}\`\nレビューAPIがHTTP ${r.status} を返しました（${MODEL}）。\n\n\`\`\`\n${t.slice(0,400)}\n\`\`\`\n`); process.exit(0); }
    const d = await r.json();
    let text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) text = `(レビュー本文が空でした。stop_reason=${d.stop_reason||'?'} / 出力トークン=${(d.usage&&d.usage.output_tokens)||'?'}。max_tokens不足やrefusalの可能性。)`;
    const stamp = new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 16);
    fs.writeFileSync('review.md',
      `### 🤖 自動レビュー — \`${sha}\` （${stamp} JST）\n> ${msg}\n\n${text}\n\n<sub>レビュアー: ${MODEL}・自動生成。同系統モデルゆえ盲点は相関し得ます。最終判断は人間が行ってください。</sub>\n`);
    console.log('review.md 生成完了 (' + text.length + '字)');
  } catch (e) {
    fs.writeFileSync('review.md', `### ⚠ AI自動レビュー実行エラー — \`${sha}\`\n\`\`\`\n${String(e.message || e).slice(0,400)}\n\`\`\`\n`);
  }
})();
