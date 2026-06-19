// 金融ポータル用 市況データ取得（ドル円・日経平均・NYダウ・ビットコイン）。
// サーバ側(GitHub Actions)で取得して law-viewer-site/data/market.json に保存する。
//   理由: 静的サイト(GitHub Pages)からブラウザ直叩きでは、為替・株価指数の無料CORS対応ソースが乏しく、
//         Yahoo Finance等はCORS不可＋UA必須のため、Actions側で取得して同一オリジンのJSONに落とすのが堅実。
//   更新頻度: crawl.yml と同じ 1日3回（07:37/13:37/19:37 JST）。利用者は「巡回時点の値（約15分遅れ）」として参照。
//   出典明示: 為替・株価指数=Yahoo Finance、ビットコイン=CoinGecko。フロントの市況バーにも明記する。
// 取得失敗は致命的でない（市況バーは欠落値を「—」表示）。1項目失敗しても他は出す。
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function yahoo(symbol){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const m = j.chart.result[0].meta;
  return { value: m.regularMarketPrice, prev: m.chartPreviousClose };
}

(async () => {
  const out = { fetchedAt: new Date().toISOString(), items: {} };

  // 為替・株価指数（Yahoo Finance）。symbolはURLエンコード済み（^=%5E）。
  const YF = [
    ['usdjpy', 'JPY%3DX',  'ドル円'],
    ['n225',   '%5EN225',  '日経平均'],
    ['dji',    '%5EDJI',   'NYダウ'],
  ];
  for (const [key, sym, label] of YF){
    try {
      const d = await yahoo(sym);
      out.items[key] = {
        label, value: d.value, prev: d.prev,
        change: (d.prev && d.value != null) ? (d.value - d.prev) / d.prev * 100 : null,
        source: 'Yahoo Finance', note: '約15分遅れ・巡回時点',
      };
    } catch (e){ console.log(key + ' 取得失敗: ' + (e.message || e)); }
  }

  // ビットコイン: Coinbase Exchange stats（last=現在値, open=24時間前）で価格＋24h変化率。CoinGecko(429)/Binance(ブラウザ不可)は不使用。
  // ※これは初期表示の種。フロントは表示中にクライアント側から同ソースで15秒ごとに最新化する。
  try {
    const j = await (await fetch('https://api.exchange.coinbase.com/products/BTC-USD/stats')).json();
    const last = +j.last, open = +j.open;
    if (isFinite(last)) out.items.btc = { label: 'ビットコイン', value: last,
      change: (isFinite(open) && open) ? ((last - open) / open * 100) : null, source: 'Coinbase', note: 'リアルタイム・USD建', unit: '$' };
  } catch (e){ console.log('btc 取得失敗: ' + (e.message || e)); }

  fs.writeFileSync('../law-viewer-site/data/market.json', JSON.stringify(out));
  console.log('market.json 書き出し完了:', JSON.stringify(out.items));
})();
