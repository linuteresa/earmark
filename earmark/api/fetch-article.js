// Vercel serverless function — runs on the server, so no CORS in the browser.
// Endpoint: /api/fetch-article?url=https://medium.com/...

export default async function handler(req, res) {
  const url = req.query.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  const target = url.startsWith('http') ? url : `https://${url}`;

  // Basic safety: only allow http(s)
  try {
    const parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Only http(s) URLs allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const upstream = await fetch(`https://r.jina.ai/${target}`, {
      headers: {
        'Accept': 'text/plain',
        'User-Agent': 'Earmark/1.0 (article-reader)',
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `Upstream service returned ${upstream.status}. The article might be paywalled or unreachable.`,
      });
    }

    const text = await upstream.text();

    // Cache aggressively at the edge — same URL = same article.
    // 1 day fresh, up to 7 days stale-while-revalidate.
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(text);
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Fetch failed' });
  }
}
