// Vercel serverless function — proxies OnShape API calls server-side to avoid CORS.
// GET  /api/onshape?path=/parts/d/...       → transparent proxy to cad.onshape.com
// POST /api/onshape  { action: 'evalFeatureScript', ... } → maps entity IDs to partIds

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const method = req.method;
  if (method !== 'GET' && method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const osKey    = process.env.ONSHAPE_ACCESS_KEY;
  const osSecret = process.env.ONSHAPE_SECRET_KEY;
  if (!osKey || !osSecret) {
    return res.status(500).json({ error: 'OnShape credentials not configured on server' });
  }

  const authHeader = 'Basic ' + Buffer.from(`${osKey}:${osSecret}`).toString('base64');
  const baseHeaders = {
    'Authorization': authHeader,
    'Accept':        'application/json',
    'Content-Type':  'application/json',
  };

  // ── POST: special actions ──────────────────────────────────────────────────
  if (method === 'POST') {
    const { action } = req.body || {};

    // Map B-rep entity IDs from SELECTION events to partIds via FeatureScript eval.
    // OnShape's /parts API returns partIds like "JFD"; SELECTION events return entity
    // IDs like "LFiqL" which are B-rep face/edge IDs. FeatureScript can bridge them.
    if (action === 'evalFeatureScript') {
      const { docId, wvmType, wvmId, elementId, entityIds } = req.body;
      if (!docId || !wvmId || !elementId || !Array.isArray(entityIds) || !entityIds.length) {
        return res.status(400).json({ error: 'Missing required fields for evalFeatureScript' });
      }

      // FeatureScript: for each entity ID, get the part it belongs to and return its partId.
      // transientQueries are the selectionId strings from the SELECTION event.
      // We build a map query and return the unique set of partIds.
      const fsScript = `
function(context is Context, queries) {
  var result = [];
  for (var q in queries["entityIds"]) {
    var entities = qTransient(q);
    var ownerParts = qOwnerPart(entities);
    for (var part in evaluateQuery(context, ownerParts)) {
      var pid = getProperty(context, { "entity": part, "propertyType": PropertyType.PART_NUMBER });
      // partId is the internal ID — use the FeatureScript id() function
      result = append(result, identityToString(id(part)));
    }
  }
  return result;
}`;

      // Actually the correct FS approach uses qTransient + the /featurescript endpoint
      // The script receives a "queries" map from the payload
      const wvm = wvmType === 'v' ? 'v' : 'w';
      const fsUrl = `https://cad.onshape.com/api/v6/partstudios/d/${docId}/${wvm}/${wvmId}/e/${elementId}/featurescript`;

      try {
        const fsResp = await fetch(fsUrl, {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify({
            script: fsScript,
            queries: [{ key: 'entityIds', value: entityIds }]
          })
        });

        const fsData = await fsResp.json();
        console.log('[onshape proxy] FS eval response:', JSON.stringify(fsData).substring(0, 500));

        // FS returns { result: { type: 'array', value: [...] } }
        // Each value is a string partId
        let partIds = [];
        if (fsData.result?.type === 'array') {
          partIds = fsData.result.value
            .map(v => v.value || v)
            .filter(v => typeof v === 'string' && v.length > 0);
        }

        // Deduplicate
        partIds = [...new Set(partIds)];
        return res.json({ ok: true, partIds, raw: fsData });

      } catch (err) {
        return res.status(500).json({ error: 'FeatureScript eval failed: ' + err.message });
      }
    }

    // For other POST actions (e.g. translation requests), fall through to transparent proxy
    const { path } = req.query;
    if (!path) return res.status(400).json({ error: 'Missing path param for POST proxy' });
    const upstreamUrl = `https://cad.onshape.com/api/v6${path}`;
    try {
      const upstream = await fetch(upstreamUrl, { method: 'POST', headers: baseHeaders, body: JSON.stringify(req.body) });
      const data = await upstream.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── GET: transparent proxy ─────────────────────────────────────────────────
  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing path param' });

  const upstreamUrl = `https://cad.onshape.com/api/v6${path}`;
  try {
    const upstream = await fetch(upstreamUrl, { method: 'GET', headers: baseHeaders });
    const contentType = upstream.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', contentType);
    res.status(upstream.status);

    if (contentType.includes('application/json')) {
      const data = await upstream.json();
      return res.json(data);
    } else {
      // Binary passthrough (STEP file downloads)
      const buffer = await upstream.arrayBuffer();
      return res.send(Buffer.from(buffer));
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
