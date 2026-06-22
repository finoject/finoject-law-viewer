// 金融ポータル用 市況データ取得（為替・株価指数・国債利回り・暗号資産。銘柄はYF配列＋個別取得で定義）。
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
  return { value: m.regularMarketPrice, prev: m.chartPreviousClose, time: m.regularMarketTime };
}

(async () => {
  const out = { fetchedAt: new Date().toISOString(), items: {} };

  // 為替・株価指数・米国債利回り（Yahoo Finance）。symbolはURLエンコード済み（^=%5E）。yield=利回り(変化はbp)。
  const YF = [
    ['usdjpy', 'JPY%3DX',  'ドル円'],
    ['n225',   '%5EN225',  '日経平均'],
    ['dji',    '%5EDJI',   'NY Dow'],
    ['ndx',    '%5ENDX',   'NASDAQ100'],
    ['us10y',  '%5ETNX',   '米国債10年', true],
  ];
  for (const [key, sym, label, yield_] of YF){
    try {
      const d = await yahoo(sym);
      out.items[key] = {
        label, value: d.value, prev: d.prev,
        change: (d.prev != null && d.value != null) ? (yield_ ? (d.value - d.prev) * 100 : (d.value - d.prev) / d.prev * 100) : null,
        source: 'Yahoo Finance', note: '約15分遅れ・巡回時点', t: (d.time ? d.time * 1000 : null),
      };
    } catch (e){ console.log(key + ' 取得失敗: ' + (e.message || e)); }
  }

  // 日本国債10年（財務省 国債金利情報 CSV・Shift_JIS）。新発10年=データ行の列index10。日次（前営業日基準）。
  try {
    const reiwa = s => { const m=(s||'').match(/^R(\d+)\.(\d+)\.(\d+)/); return m ? ((2018 + +m[1])+'/'+(+m[2])+'/'+(+m[3])) : (s||''); };
    const buf = Buffer.from(await (await fetch('https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv')).arrayBuffer());
    const txt = new TextDecoder('shift_jis').decode(buf);
    const rows = txt.split(/\r?\n/).map(l => l.split(',')).filter(c => c.length >= 11 && /^[RSHM]?\d/.test((c[0]||'').trim()) && !isNaN(parseFloat(c[10])));
    if (rows.length){
      const last = rows[rows.length-1], prev = rows[rows.length-2];
      const v = parseFloat(last[10]), pv = prev ? parseFloat(prev[10]) : NaN;
      out.items.jp10y = { label: '日本国債10年', value: v,
        change: isFinite(pv) ? (v - pv) * 100 : null, source: '財務省', note: '日次・新発10年 ' + reiwa(last[0]) };
    }
  } catch (e){ console.log('jp10y 取得失敗: ' + (e.message || e)); }

  // TOPIX（JPX「リアルタイム株価指数値」JSON・約20分遅れ）。Yahoo無料枠に正確な現物TOPIX指数が無いためJPX公式から取得。
  // MainStockIndex.Topix = { currentPrice, previousDayComparison(前日比), previousDayRatio(%) }。フロントは表示中にプロキシ経由で同ソースを15秒ごと最新化。
  try {
    const num = s => { const v = parseFloat(String(s).replace(/,/g, '')); return isFinite(v) ? v : null; };
    const jj = await (await fetch('https://www.jpx.co.jp/market/indices/indices_stock_price3.1.txt')).json();
    const top = jj.MainStockIndex && jj.MainStockIndex.Topix;
    if (top){
      const value = num(top.currentPrice), chg = num(top.previousDayComparison), pct = num(top.previousDayRatio);
      let tm = null;
      try { const m = (await (await fetch('https://www.jpx.co.jp/market/indices/indices_stock_price3.1.time.txt')).text()).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
            if (m) tm = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`); } catch (e2){}
      out.items.topix = { label: 'TOPIX', value, prev: (value!=null && chg!=null) ? value - chg : null, change: pct, source: 'JPX', note: '約20分遅れ', t: tm };
    }
  } catch (e){ console.log('topix 取得失敗: ' + (e.message || e)); }

  // ビットコイン: Coinbase Exchange stats（last=現在値, open=24時間前）で価格＋24h変化率。CoinGecko(429)/Binance(ブラウザ不可)は不使用。
  // ※これは初期表示の種。フロントは表示中にクライアント側から同ソースで15秒ごとに最新化する。
  try {
    const j = await (await fetch('https://api.exchange.coinbase.com/products/BTC-USD/stats')).json();
    const last = +j.last, open = +j.open;
    if (isFinite(last)) out.items.btc = { label: 'Bitcoin', value: last,
      change: (isFinite(open) && open) ? ((last - open) / open * 100) : null, source: 'Coinbase', note: 'リアルタイム・USD建', unit: '$' };
  } catch (e){ console.log('btc 取得失敗: ' + (e.message || e)); }

  fs.writeFileSync('../law-viewer-site/data/market.json', JSON.stringify(out));
  console.log('market.json 書き出し完了:', JSON.stringify(out.items));
})();
