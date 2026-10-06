// Cloudflare Worker: Yahoo Finance + NewsAPI proxy for Tickr
//
// Browsers can't call Yahoo Finance's chart API directly (no CORS headers,
// request just fails), and NewsAPI's free tier only allows requests from
// localhost. This worker fetches both server-side (no CORS/origin issue
// there) and re-serves the result with CORS enabled, so Tickr's frontend
// can read it from the deployed GitHub Pages domain too.
//
// Yahoo usage: GET https://<your-worker>.workers.dev/?symbols=^VIX,^TNX
// Response: { "^VIX": { "price": 15.31, "changePct": -6.59 }, "^TNX": { ... } }
//
// News usage: GET https://<your-worker>.workers.dev/news?sources=reuters,bloomberg,associated-press
// Response: passthrough of NewsAPI's /v2/top-headlines JSON.
// Requires a NEWSAPI_KEY secret on this worker (dashboard -> Settings ->
// Variables and Secrets, or `wrangler secret put NEWSAPI_KEY`) -- the key
// never appears in this source file or in the deployed frontend.

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (url.pathname === '/news') {
      return newsProxy(url, env);
    }

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

async function newsProxy(url, env) {
  if (!env.NEWSAPI_KEY) {
    return json({ error: 'NEWSAPI_KEY secret not configured on this worker' }, 500);
  }
  const sources = url.searchParams.get('sources') || 'reuters,bloomberg,associated-press';
  try {
    const res = await fetch(
      `https://newsapi.org/v2/top-headlines?sources=${encodeURIComponent(sources)}&apiKey=${env.NEWSAPI_KEY}`,
      {
        headers: { 'User-Agent': 'TickrNewsProxy/1.0 (+https://inhwanbaeg99-lgtm.github.io/invest/)' },
        cf: { cacheTtl: 300, cacheEverything: true },
      },
    );
    const data = await res.json();
    return json(data, res.status);
  } catch (e) {
    return json({ error: 'upstream fetch to newsapi.org failed' }, 502);
  }
}

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
