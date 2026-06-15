# finoject 法令ビューア（資金決済・犯収法・金商法）

暗号資産・決済の中核となる法令・関連政省令を **e-Gov 法令API v2** から取得し、
条文を検索・参照しやすく表示する静的サイト。毎朝07:35（JST）に自動更新。

## 対象法令（12）
資金決済法／同施行令／暗号資産交換業者府令／資金移動業者府令／前払式支払手段府令／電子決済手段等取引業者府令／
犯収法／同施行令／同施行規則／金融商品取引法／同施行令／金融商品取引業等府令

## 仕組み
- `law-viewer/fetcher.js` … e-Gov API v2 (`/law_data/{law_id}`) から本文を取得し、条文(Article)・章節見出しに構造化して `law-viewer-site/data/{law_id}.json` を生成。`law_revision_id` を前回と比較し更新法令を検出。
- `law-viewer-site/index.html` … 法令一覧＋条文表示＋条文内キーワード検索。各条はe-Gov原文へリンク。`?law=ID&art=第九条` でディープリンク可。
- `.github/workflows/crawl.yml` … 毎朝07:35 JSTにcron実行 → 取得 → data更新コミット → GitHub Pages公開。

## 補足
e-Govは「法令（法律・政令・府省令）」のみ。金融庁の監督指針・事務ガイドライン・パブコメ・新旧対照表は法令ではないため別途（規制ウォッチ側／専用レイヤーで）取得する。

## 手動実行
Actionsタブ →「fetch-laws-and-publish」→「Run workflow」。ローカルは `cd law-viewer && node fetcher.js`。
