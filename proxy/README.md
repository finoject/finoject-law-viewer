# ページ埋め込みプロキシ（Cloudflare Worker）

法令ビューアのトップ画面（金融規制ウォッチ・フィード）で、項目をクリックしたときに**外部ページの本文を画面内に直接表示**するための中継プロキシ。

## なぜ必要か
金融庁・日銀・JPX・日本公認会計士協会のサイトは `X-Frame-Options: SAMEORIGIN` を返すため、そのままでは iframe で画面内に埋め込めない。さらにブラウザの CORS 制約で外部HTMLを直接取得もできない。そこで、この Worker がサーバ側で取得し、埋め込み拒否ヘッダを除去して返すことで画面内表示を可能にする（JSDA・JVCEA は元々埋め込み可なのでプロキシ無しでも表示できる）。

## デプロイ手順（ダッシュボードでコピペ・5分・無料）
1. https://dash.cloudflare.com にログイン（無料アカウントでOK）。
2. 左メニュー **Workers & Pages** →「Create application」→「Create Worker」。
3. 名前を例えば `finoject-proxy` にして「Deploy」（ひな形が作られる）。
4. 「Edit code」を開き、エディタの中身を全部消して [`worker.js`](./worker.js) の内容を貼り付け →「Deploy」。
5. 払い出された URL（例 `https://finoject-proxy.<あなたのサブドメイン>.workers.dev`）を控える。

## 法令ビューアへの設定
`law-viewer-site/index.html` の定数 `PROXY_BASE` に、上記 Worker の URL（末尾スラッシュ無し）を設定する。
```js
const PROXY_BASE = 'https://finoject-proxy.xxxx.workers.dev';
```
設定すると、金融庁・日銀・JPX を含む全6機関の本文がトップ画面内のビューアに表示される。空のままでも JSDA / JVCEA は表示される。

## セキュリティ
オープンプロキシ化を防ぐため、中継先は監視対象6機関のドメイン（`fsa.go.jp`/`boj.or.jp`/`jpx.co.jp`/`jsda.or.jp`/`jvcea.or.jp`/`jicpa.or.jp`）のみに制限している。他ドメインは 403。
