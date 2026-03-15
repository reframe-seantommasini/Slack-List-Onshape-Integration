// Vercel serverless function — proxies OnShape API calls server-side to avoid CORS.
// GET  /api/onshape?path=/parts/d/...              → transparent proxy
// POST /api/onshape { action: 'evalFeatureScript' } → maps entity IDs to partIds via FS

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

  // ── POST: evalFeatureScript — maps B-rep entity IDs to partIds ─────────────
  if (method === 'POST') {
    const { action } = req.body || {};

    if (action === 'evalFeatureScript') {
      const { docId, wvmType, wvmId, elementId, entityIds } = req.body;
      if (!docId || !wvmId || !elementId || !Array.isArray(entityIds) || !entityIds.length) {
        return res.status(400).json({ error: 'Missing fields for evalFeatureScript' });
      }

      const wvm = wvmType === 'v' ? 'v' : 'w';
      const fsUrl = `https://cad.onshape.com/api/v6/partstudios/d/${docId}/${wvm}/${wvmId}/e/${elementId}/featurescript`;

      // FeatureScript: for each transient entity ID from the SELECTION event,
      // find the owning part body and return its partId string.
      // qTransient() accepts the selectionId string directly.
      // Note: the script must be a valid FS function expression — no semicolons after
      // the closing brace, no top-level statements.
      const fsScript = [
        'function(context is Context, queries) {',
        '  var result = [];',
        '  for (var eid in queries["ids"]) {',
        '    try {',
        '      var owner = qOwnerPart(qTransient(eid));',
        '      for (var part in evaluateQuery(context, owner)) {',
        '        var pid = getProperty(context, {',
        '          "entity" : part,',
        '          "propertyType" : PropertyType.PART_NUMBER',
        '        });',
        '        result = append(result, pid == undefined ? "" : pid);',
        '      }',
        '    } catch {',
        '      result = append(result, "err:" ~ eid);',
        '    }',
        '  }',
        '  return result;',
        '}'
      ].join('\n');

      // queries payload: keys become the map keys inside the FS function
      const fsPayload = {
        script: fsScript,
        queries: [{ key: 'ids', value: entityIds }]
      };

      let rawText = '';
      try {
        const fsResp = await fetch(fsUrl, {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify(fsPayload)
        });

        rawText = await fsResp.text(); // always read as text first — avoids JSON parse crash
        console.log('[onshape proxy] FS status:', fsResp.status, 'body:', rawText.substring(0, 800));

        if (!fsResp.ok) {
          return res.status(500).json({
            error: `FS endpoint returned ${fsResp.status}`,
            detail: rawText.substring(0, 400)
          });
        }

        let fsData;
        try {
          fsData = JSON.parse(rawText);
        } catch(e) {
          return res.status(500).json({ error: 'FS response is not JSON', detail: rawText.substring(0, 400) });
        }

        console.log('[onshape proxy] FS parsed:', JSON.stringify(fsData).substring(0, 600));

        // The FS result comes back as { result: { type: 'array', value: [ {type:'string', value:'...'}, ... ] } }
        // or sometimes { result: { BSType: 'BTFSValueArray', ...items } }
        let partIds = [];

        const result = fsData.result;
        if (result) {
          const items = result.value ?? result.items ?? [];
          partIds = items
            .map(v => (typeof v === 'string' ? v : (v.value ?? v.message ?? '')))
            .filter(s => s && !s.startsWith('err:') && s.length > 0);
        }

        // Deduplicate
        partIds = [...new Set(partIds)];
        return res.json({ ok: true, partIds, raw: fsData });

      } catch (err) {
        return res.status(500).json({
          error: 'FeatureScript eval failed: ' + err.message,
          detail: rawText.substring(0, 400)
        });
      }
    }

    // Other POST actions — transparent proxy
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
      return res.json(await upstream.json());
    } else {
      // Binary passthrough (STEP file downloads)
      return res.send(Buffer.from(await upstream.arrayBuffer()));
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
