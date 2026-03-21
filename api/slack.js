// Vercel serverless function — proxies all Slack API calls server-side.
// Slack token never touches the browser or the public repo.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const slackToken   = process.env.SLACK_TOKEN;
  const slackChannel = process.env.SLACK_CHANNEL;
  if (!slackToken || !slackChannel) {
    return res.status(500).json({ error: 'Slack credentials not configured on server' });
  }

  const { action, payload } = req.body;

  try {
    if (action === 'postMessage') {
      // Post the manufacturing card to Slack
      const p = payload;
      const fields = [
        ['Project', p.project],
        ['Status', p.status||'Not set'],
        ['Machine', p.machine||'TBD'], ['Material', p.material||'TBD'],
        ['Thickness', p.thickness||'TBD'], ['Type of Part', p.partType||'TBD'],
        ['Quantity', p.qty], ['Finish', p.finish||'None'],
        ['Assigned To', p.student||'Unassigned'],
        ['CAD Link', p.cadLink ? `<${p.cadLink}|Open in OnShape>` : 'N/A'],
        ['Part File', p.fileName||'None attached']
      ];
      const body = {
        channel: slackChannel,
        text: `🔧 NEW MANUFACTURING CARD: ${p.name}`,
        blocks: [
          { type:'header', text:{ type:'plain_text', text:`🔧 ${p.name}`, emoji:true } },
          { type:'section', fields: fields.slice(0,8).map(([k,v])=>({ type:'mrkdwn', text:`*${k}*\n${v}` })) },
          { type:'section', fields: fields.slice(8).map(([k,v])=>({ type:'mrkdwn', text:`*${k}*\n${v}` })) },
          ...(p.notes ? [{ type:'section', text:{ type:'mrkdwn', text:`*Notes*\n${p.notes}` } }] : []),
          { type:'divider' }
        ]
      };
      const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+slackToken },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Slack error');
      return res.json({ ok: true });

    } else if (action === 'getUploadURL') {
      // Step A of file upload: get upload URL
      const resp = await fetch('https://slack.com/api/files.getUploadURLExternal', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+slackToken },
        body: JSON.stringify({ filename: payload.filename, length: payload.length })
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error);
      return res.json({ ok: true, upload_url: data.upload_url, file_id: data.file_id });

    } else if (action === 'completeUpload') {
      // Step C of file upload: complete and share to channel
      const resp = await fetch('https://slack.com/api/files.completeUploadExternal', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+slackToken },
        body: JSON.stringify({
          files: [{ id: payload.file_id, title: payload.title }],
          channel_id: slackChannel
        })
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error);
      return res.json({ ok: true });

    } else if (action === 'getListSchema') {
      // Temporary helper — fetches existing items to discover column_id + select option IDs.
      // Remove this action once column mapping is wired up.
      const listId = process.env.SLACK_LIST_ID || 'F09T4DXL3L5';
      const resp = await fetch('https://slack.com/api/slackLists.items.list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + slackToken },
        body: JSON.stringify({ list_id: listId, limit: 5 })
      });
      const data = await resp.json();
      return res.json(data);

    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
