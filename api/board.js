// Vercel serverless function — proxies all kanban board API calls to Supabase.
// Supabase credentials never touch the browser.
// Supports: getCards, createCard, updateCard, moveCard, deleteCard

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase credentials not configured' });
  }

  // Helper: call Supabase REST API
  const sb = async (method, path, body) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, data: text ? JSON.parse(text) : null };
  };

  try {
    // GET → getCards
    if (req.method === 'GET') {
      const { status, data } = await sb('GET', '/cards?order=created_at.desc&select=*');
      if (status >= 400) return res.status(status).json({ error: data });
      return res.json({ ok: true, cards: data });
    }

    // POST → action-based
    const { action, card, id, status: newStatus, updates } = req.body || {};

    if (action === 'createCard') {
      const row = {
        name:           card.name          || '',
        status:         card.status        || 'Needs Drawing',
        project:        card.project       || null,
        machine:        card.machine       || null,
        material:       card.material      || null,
        thickness:      card.thickness     || null,
        part_type:      card.partType      || null,
        quantity:       card.qty ? parseInt(card.qty, 10) : null,
        finish:         card.finish        || null,
        assigned_to:    card.student       || card.assigned_to || null,
        cad_link:       card.cadLink       || card.cad_link    || null,
        notes:          card.notes         || null,
        step_file_id:   card.stepFileId    || null,
        step_file_name: card.stepFileName  || null,
        part_id:        card.partId        || null,
        submitted_by:   card.submittedBy   || null,
      };
      const { status, data } = await sb('POST', '/cards', row);
      if (status >= 400) return res.status(status).json({ error: data });
      return res.json({ ok: true, card: Array.isArray(data) ? data[0] : data });

    } else if (action === 'updateCard') {
      const fields = {};
      const map = {
        name: 'name', status: 'status', project: 'project', machine: 'machine',
        material: 'material', thickness: 'thickness', partType: 'part_type',
        quantity: 'quantity', finish: 'finish', assigned: 'assigned_to',
        cadLink: 'cad_link', notes: 'notes',
      };
      for (const [k, col] of Object.entries(map)) {
        if (updates?.[k] !== undefined) fields[col] = updates[k] || null;
      }
      if (Object.keys(fields).length === 0) return res.json({ ok: true });
      const { status, data } = await sb('PATCH', `/cards?id=eq.${encodeURIComponent(id)}`, fields);
      if (status >= 400) return res.status(status).json({ error: data });
      return res.json({ ok: true });

    } else if (action === 'moveCard') {
      const { status, data } = await sb('PATCH', `/cards?id=eq.${encodeURIComponent(id)}`, { status: newStatus });
      if (status >= 400) return res.status(status).json({ error: data });
      return res.json({ ok: true });

    } else if (action === 'deleteCard') {
      const { status, data } = await sb('DELETE', `/cards?id=eq.${encodeURIComponent(id)}`);
      if (status >= 400) return res.status(status).json({ error: data });
      return res.json({ ok: true });

    } else if (action === 'uploadStep') {
      // Upload a STEP file to private Supabase Storage bucket 'step-files'
      // Bucket must be set to PRIVATE in Supabase dashboard
      // Files stored at: {cardId}/{filename}
      const { filename, cardId, fileBase64 } = req.body || {};
      if (!filename || !fileBase64) return res.status(400).json({ error: 'Missing filename or fileBase64' });

      const fileBuffer = Buffer.from(fileBase64, 'base64');
      const storagePath = `${cardId || 'unassigned'}/${filename}`;

      // Upload to private bucket
      const uploadResp = await fetch(
        `${SUPABASE_URL}/storage/v1/object/step-files/${storagePath}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/octet-stream',
          'x-upsert': 'true',
        },
        body: fileBuffer,
      });

      if (!uploadResp.ok) {
        const err = await uploadResp.text();
        return res.status(uploadResp.status).json({ error: 'Storage upload failed: ' + err });
      }

      // Return the storage path (not a public URL — files are private)
      // Use getStepUrl action to generate a signed URL when needed for download
      return res.json({ ok: true, path: storagePath });

    } else if (action === 'getStepUrl') {
      // Generate a short-lived signed URL for downloading a private STEP file
      // Signed URLs expire after 1 hour — enough time to download, not permanent exposure
      const { path: filePath } = req.body || {};
      if (!filePath) return res.status(400).json({ error: 'Missing path' });

      const signResp = await fetch(
        `${SUPABASE_URL}/storage/v1/object/sign/step-files/${filePath}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 3600 }), // 1 hour
      });

      if (!signResp.ok) {
        const err = await signResp.text();
        return res.status(signResp.status).json({ error: 'Signed URL failed: ' + err });
      }

      const signData = await signResp.json();
      const signedUrl = `${SUPABASE_URL}/storage/v1${signData.signedURL}`;
      return res.json({ ok: true, url: signedUrl });

    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
