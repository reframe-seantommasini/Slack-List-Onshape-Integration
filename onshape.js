// Vercel serverless function — proxies OnShape API calls server-side to avoid CORS.
// Deployed at: /api/onshape?path=/parts/d/...
// Your index.html calls this instead of cad.onshape.com directly.

export default async function handler(req, res) {
  // Only allow GET (parts list, translation poll, file download)
  // POST is used for translation requests and Slack — those go direct or via /api/slack
  const method = req.method;
  if (method !== 'GET' && method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing path param' });

  // Credentials come from Vercel Environment Variables (set in dashboard)
  // Never hardcoded — keep the repo public safely
  const osKey    = process.env.ONSHAPE_ACCESS_KEY;
  const osSecret = process.env.ONSHAPE_SECRET_KEY;
  if (!osKey || !osSecret) {
    return res.status(500).json({ error: 'OnShape credentials not configured on server' });
  }

  const upstreamUrl = `https://cad.onshape.com/api/v6${path}`;
  const headers = {
    'Authorization': 'Basic ' + Buffer.from(`${osKey}:${osSecret}`).toString('base64'),
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };

  try {
    const body = (method === 'POST') ? JSON.stringify(req.body) : undefined;
    const upstream = await fetch(upstreamUrl, { method, headers, body });

    // Pass through content-type so binary STEP downloads work
    const contentType = upstream.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(upstream.status);

    // Stream binary responses (STEP file downloads) directly
    if (contentType.includes('application/json')) {
      const data = await upstream.json();
      return res.json(data);
    } else {
      const buffer = await upstream.arrayBuffer();
      return res.send(Buffer.from(buffer));
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
