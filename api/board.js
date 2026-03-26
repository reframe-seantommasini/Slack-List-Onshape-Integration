// Vercel serverless function — proxies all kanban board API calls.
// Database: Neon (serverless Postgres) via @neondatabase/serverless
// File storage: Vercel Blob via @vercel/blob
//
// Required Vercel env vars (auto-populated when you connect via Vercel dashboard):
//   DATABASE_URL          — Neon connection string (added automatically by Neon integration)
//   BLOB_READ_WRITE_TOKEN — Vercel Blob token (added automatically by Blob integration)

import { neon } from '@neondatabase/serverless';
import { put, del } from '@vercel/blob';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL not configured — connect Neon in Vercel dashboard' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not configured — connect Blob in Vercel dashboard' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // GET → getCards
    if (req.method === 'GET') {
      const cards = await sql`SELECT * FROM cards ORDER BY created_at DESC`;
      return res.json({ ok: true, cards });
    }

    // POST → action-based
    const { action, card, id, status: newStatus, updates } = req.body || {};

    if (action === 'createCard') {
      const c = card;
      const rows = await sql`
        INSERT INTO cards (
          name, status, project, machine, material, thickness,
          part_type, quantity, finish, assigned_to, cad_link, notes,
          step_file_url, step_file_name, pdf_file_url, pdf_file_name,
          part_id, submitted_by
        ) VALUES (
          ${c.name        || ''},
          ${c.status      || 'Needs Drawing'},
          ${c.project     || null},
          ${c.machine     || null},
          ${c.material    || null},
          ${c.thickness   || null},
          ${c.partType    || null},
          ${c.qty         ? parseInt(c.qty, 10) : null},
          ${c.finish      || null},
          ${c.student     || c.assigned_to || null},
          ${c.cadLink     || c.cad_link    || null},
          ${c.notes       || null},
          ${c.stepFileUrl  || null},
          ${c.stepFileName || null},
          ${c.pdfFileUrl   || null},
          ${c.pdfFileName  || null},
          ${c.partId      || null},
          ${c.submittedBy || c.student || null}
        )
        RETURNING *
      `;
      return res.json({ ok: true, card: rows[0] });

    } else if (action === 'updateCard') {
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const u = updates || {};
      await sql`
        UPDATE cards SET
          name           = COALESCE(${u.name          ?? null}, name),
          status         = COALESCE(${u.status        ?? null}, status),
          project        = CASE WHEN ${u.project        !== undefined} THEN ${u.project        ?? null} ELSE project     END,
          machine        = CASE WHEN ${u.machine        !== undefined} THEN ${u.machine        ?? null} ELSE machine     END,
          material       = CASE WHEN ${u.material       !== undefined} THEN ${u.material       ?? null} ELSE material    END,
          thickness      = CASE WHEN ${u.thickness      !== undefined} THEN ${u.thickness      ?? null} ELSE thickness   END,
          part_type      = CASE WHEN ${u.partType       !== undefined} THEN ${u.partType       ?? null} ELSE part_type   END,
          quantity       = CASE WHEN ${u.quantity       !== undefined} THEN ${u.quantity       ?? null} ELSE quantity    END,
          finish         = CASE WHEN ${u.finish         !== undefined} THEN ${u.finish         ?? null} ELSE finish      END,
          assigned_to    = CASE WHEN ${u.assigned       !== undefined} THEN ${u.assigned       ?? null} ELSE assigned_to END,
          cad_link       = CASE WHEN ${u.cadLink        !== undefined} THEN ${u.cadLink        ?? null} ELSE cad_link    END,
          notes          = CASE WHEN ${u.notes          !== undefined} THEN ${u.notes          ?? null} ELSE notes       END,
          step_file_url  = CASE WHEN ${u.stepFileUrl    !== undefined} THEN ${u.stepFileUrl    ?? null} ELSE step_file_url  END,
          step_file_name = CASE WHEN ${u.stepFileName   !== undefined} THEN ${u.stepFileName   ?? null} ELSE step_file_name END,
          pdf_file_url   = CASE WHEN ${u.pdfFileUrl     !== undefined} THEN ${u.pdfFileUrl     ?? null} ELSE pdf_file_url   END,
          pdf_file_name  = CASE WHEN ${u.pdfFileName    !== undefined} THEN ${u.pdfFileName    ?? null} ELSE pdf_file_name  END,
          updated_at     = NOW()
        WHERE id = ${id}
      `;
      return res.json({ ok: true });

    } else if (action === 'moveCard') {
      if (!id || !newStatus) return res.status(400).json({ error: 'Missing id or status' });
      await sql`UPDATE cards SET status = ${newStatus}, updated_at = NOW() WHERE id = ${id}`;
      return res.json({ ok: true });

    } else if (action === 'deleteCard') {
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const rows = await sql`SELECT step_file_url, pdf_file_url FROM cards WHERE id = ${id}`;
      if (rows[0]?.step_file_url) {
        try { await del(rows[0].step_file_url); } catch (_) {}
      }
      if (rows[0]?.pdf_file_url) {
        try { await del(rows[0].pdf_file_url); } catch (_) {}
      }
      await sql`DELETE FROM cards WHERE id = ${id}`;
      return res.json({ ok: true });

    } else if (action === 'uploadStep') {
      const { filename, cardId, fileBase64 } = req.body || {};
      if (!filename || !fileBase64) return res.status(400).json({ error: 'Missing filename or fileBase64' });

      const fileBuffer = Buffer.from(fileBase64, 'base64');
      const blobPath = `step-files/${cardId || 'unassigned'}/${filename}`;

      const blob = await put(blobPath, fileBuffer, {
        access: 'public',
        contentType: 'application/octet-stream',
        addRandomSuffix: false,
      });

      return res.json({ ok: true, url: blob.url });

    } else if (action === 'uploadPdf') {
      const { filename, cardId, fileBase64 } = req.body || {};
      if (!filename || !fileBase64) return res.status(400).json({ error: 'Missing filename or fileBase64' });

      const fileBuffer = Buffer.from(fileBase64, 'base64');
      const blobPath = `pdf-files/${cardId || 'unassigned'}/${filename}`;

      const blob = await put(blobPath, fileBuffer, {
        access: 'public',
        contentType: 'application/pdf',
        addRandomSuffix: false,
      });

      return res.json({ ok: true, url: blob.url });

    } else if (action === 'getStepUrl') {
      // Vercel Blob URLs are permanent public URLs — just return what's stored on the card
      const { url } = req.body || {};
      if (!url) return res.status(400).json({ error: 'Missing url' });
      return res.json({ ok: true, url });

    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

  } catch (err) {
    console.error('[board.js]', err);
    return res.status(500).json({ error: err.message });
  }
}
