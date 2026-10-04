// Cloudflare Worker: Yahoo Finance proxy for Tickr
//
// Browsers can't call Yahoo Finance's chart API directly (no CORS headers,
// request just fails). This worker fetches it server-side (no CORS issue
// there) and re-serves the result with CORS enabled, so Tickr's frontend
// can read it.
//
// Usage: GET https://<your-worker>.workers.dev/?symbols=^VIX,^TNX
// Response: { "^VIX": { "price": 15.31, "changePct": -6.59 }, "^TNX": { ... } }

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const symbolsParam = url.searchParams.get('symbols') || url.searchParams.get('symbol') || '';
    const symbols = symbolsParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!symbols.length) {
      return json({ error: 'missing symbols param, e.g. ?symbols=^VIX,^TNX' }, 400);
    }

    const results = {};
    await Promise.all(
      symbols.map(async (sym) => {
        try {
          const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
          const res = await fetch(yUrl, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
              Accept: 'application/json',
            },
            cf: { cacheTtl: 60, cacheEverything: true },
          });
          if (!res.ok) return;
          const data = await res.json();
          const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
          if (!meta || meta.regularMarketPrice == null) return;
          const prevClose = meta.previousClose ?? meta.chartPreviousClose;
          const price = meta.regularMarketPrice;
          const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
          results[sym] = { price, changePct };
        } catch (e) {
          // skip this symbol on failure, others still return
        }
      }),
    );

    return json(results, 200);
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
