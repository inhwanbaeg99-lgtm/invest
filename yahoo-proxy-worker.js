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
//
// RSS/Atom usage: GET https://<your-worker>.workers.dev/rss?url=<encoded feed url>
// Response: the raw XML, passed through with CORS enabled. Restricted to a
// domain whitelist below -- this is NOT an open proxy.

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (url.pathname === '/news') {
      return newsProxy(url, env);
    }

    if (url.pathname === '/rss') {
      return rssProxy(url);
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
  // Passed straight through to NewsAPI's /v2/top-headlines -- e.g. ?sources=bloomberg
  // or ?category=business&country=us. (NewsAPI itself rejects combining sources
  // with category/country, so pick one style per request.)
  const allowed = ['sources', 'category', 'country', 'q', 'pageSize'];
  const upstream = new URLSearchParams();
  for (const key of allowed) {
    const val = url.searchParams.get(key);
    if (val) upstream.set(key, val);
  }
  if (![...upstream.keys()].length) {
    upstream.set('sources', 'reuters,bloomberg,associated-press');
  }
  upstream.set('apiKey', env.NEWSAPI_KEY);
  try {
    const res = await fetch(`https://newsapi.org/v2/top-headlines?${upstream.toString()}`, {
      headers: { 'User-Agent': 'TickrNewsProxy/1.0 (+https://inhwanbaeg99-lgtm.github.io/invest/)' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    const data = await res.json();
    return json(data, res.status);
  } catch (e) {
    return json({ error: 'upstream fetch to newsapi.org failed' }, 502);
  }
}

// Domains Tickr actually needs RSS/Atom feeds from. Keeping this an allowlist
// (rather than fetching whatever `url` is given) stops the worker from being
// usable as a general-purpose CORS-bypass proxy for arbitrary sites.
const RSS_ALLOWED_HOSTS = ['www.prnewswire.com', 'www.globenewswire.com', 'www.sec.gov'];

async function rssProxy(url) {
  const target = url.searchParams.get('url');
  if (!target) {
    return json({ error: 'missing url param' }, 400);
  }
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    return json({ error: 'invalid url param' }, 400);
  }
  if (!RSS_ALLOWED_HOSTS.includes(targetUrl.hostname)) {
    return json({ error: `host not allowed: ${targetUrl.hostname}` }, 403);
  }
  try {
    const res = await fetch(targetUrl.toString(), {
      headers: {
        // SEC specifically requires an identifying User-Agent with contact info
        // (fair-access policy) or it 403s; the other two don't care either way.
        'User-Agent': 'TickrNewsProxy/1.0 (+https://inhwanbaeg99-lgtm.github.io/invest/; contact: inhwanbaeg99@gmail.com)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { 'Content-Type': 'application/xml; charset=utf-8', ...corsHeaders() },
    });
  } catch (e) {
    return json({ error: 'upstream fetch failed' }, 502);
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
