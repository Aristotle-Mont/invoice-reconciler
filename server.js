require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wlqqtavxkpkewnphzijs.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', anthropic_key_set: !!process.env.ANTHROPIC_API_KEY });
});

// ── Auth ────────────────────────────────────────────────────────────────────

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name } = req.body;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password, data: { name } })
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message || data.msg });
    res.json({ user: data.user, session: data.session });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/signin', async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password })
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message || 'Invalid credentials' });
    res.json({ user: data.user, session: { access_token: data.access_token, refresh_token: data.refresh_token } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/user', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY }
    });
    const data = await r.json();
    if (data.error) return res.status(401).json({ error: data.error.message });
    res.json({ user: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Supabase REST helper ─────────────────────────────────────────────────────

async function sbReq(token, path, options = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token}`,
      'Prefer': options.prefer !== undefined ? options.prefer : 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await r.text();
  try { return { data: JSON.parse(text), status: r.status }; }
  catch { return { data: text, status: r.status }; }
}

async function getUserId(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY }
  });
  const d = await r.json();
  return d.id || null;
}

// ── Teams ────────────────────────────────────────────────────────────────────

app.post('/api/teams', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Team name is required' });
  try {
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: 'Invalid session' });
    const { data, status } = await sbReq(token, 'teams', { method: 'POST', body: JSON.stringify({ name, owner_id: userId }) });
    console.log('TEAM CREATE RESPONSE:', status, JSON.stringify(data)); // <-- ADD THIS
    if (status >= 400) return res.status(status).json({ error: JSON.stringify(data) });
    const team = data[0];
    await sbReq(token, 'team_members', { method: 'POST', body: JSON.stringify({ team_id: team.id, user_id: userId, role: 'owner' }) });
    res.json(team);
  } catch (e) {
    console.log('TEAM ERROR:', e.message); // <-- ADD THIS
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/teams', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data } = await sbReq(token, 'teams?select=*,team_members(user_id,role)', { method: 'GET', prefer: '' });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Invites ──────────────────────────────────────────────────────────────────

app.post('/api/invites', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { team_id, email } = req.body;
  try {
    const { data, status } = await sbReq(token, 'invites', { method: 'POST', body: JSON.stringify({ team_id, email }) });
    if (status >= 400) return res.status(status).json({ error: data });
    res.json(data[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/invites/accept', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { invite_token, user_id } = req.body;
  try {
    const { data: invites } = await sbReq(token, `invites?token=eq.${invite_token}&accepted=eq.false`, { method: 'GET', prefer: '' });
    if (!invites?.length) return res.status(404).json({ error: 'Invite not found or already used' });
    const invite = invites[0];
    await sbReq(token, 'team_members', { method: 'POST', body: JSON.stringify({ team_id: invite.team_id, user_id, role: 'member' }) });
    await sbReq(token, `invites?id=eq.${invite.id}`, { method: 'PATCH', body: JSON.stringify({ accepted: true }) });
    res.json({ success: true, team_id: invite.team_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analyze ──────────────────────────────────────────────────────────────────

app.post('/api/analyze', upload.fields([
  { name: 'invoice_file', maxCount: 1 },
  { name: 'scope_file', maxCount: 1 }
]), async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!apiKey || apiKey === 'your_anthropic_api_key_here') return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  if (!token) return res.status(401).json({ error: 'Unauthorized — please sign in' });

  const userId = await getUserId(token);
  if (!userId) return res.status(401).json({ error: 'Invalid session — please sign in again' });

  try {
    const { invoice_text, scope_text, sub_name } = req.body;
    const userContent = [];

    if (req.files) {
      for (const field of ['invoice_file', 'scope_file']) {
        const fileArr = req.files[field];
        if (fileArr?.[0]) {
          const file = fileArr[0];
          const b64 = file.buffer.toString('base64');
          const mt = file.mimetype;
          if (mt === 'application/pdf') userContent.push({ type: 'document', source: { type: 'base64', media_type: mt, data: b64 } });
          else if (mt.startsWith('image/')) userContent.push({ type: 'image', source: { type: 'base64', media_type: mt, data: b64 } });
        }
      }
    }

    userContent.push({
      type: 'text',
      text: `You are an expert construction invoice auditor. Reconcile the following invoice against the scope of work.\n\n${sub_name ? 'Subcontractor: ' + sub_name : ''}${invoice_text ? '\n\n--- INVOICE ---\n' + invoice_text : ''}${scope_text ? '\n\n--- SCOPE OF WORK ---\n' + scope_text : ''}\n\nRespond ONLY with valid JSON (no markdown, no backticks):\n{\n  "sub_name": "string",\n  "invoice_number": "string or null",\n  "invoice_total": number,\n  "approved_total": number,\n  "discrepancy_amount": number,\n  "recommendation": "APPROVE" | "REVIEW" | "REJECT",\n  "summary": "2-3 sentence plain english summary",\n  "line_items": [{ "description": "string", "invoiced_amount": number, "approved_amount": number|null, "status": "OK"|"OVER_BUDGET"|"NOT_IN_SCOPE"|"MISSING_FROM_INVOICE"|"UNVERIFIABLE", "note": "string" }],\n  "flags": [{ "severity": "danger"|"warning"|"info", "title": "string", "detail": "string" }]\n}`
    });

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 1500, messages: [{ role: 'user', content: userContent }] })
    });

    const data = await anthropicResp.json();
    if (data.error) return res.status(400).json({ error: data.error.message });

    const raw = (data.content || []).map(b => b.text || '').join('');
    const result = JSON.parse(raw.replace(/```json|```/g, '').trim());

    await sbReq(token, 'reconciliations', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        sub_name: result.sub_name,
        invoice_number: result.invoice_number,
        invoice_total: result.invoice_total,
        approved_total: result.approved_total,
        discrepancy_amount: result.discrepancy_amount,
        recommendation: result.recommendation,
        summary: result.summary,
        result_json: result,
        invoice_text: invoice_text || '',
        scope_text: scope_text || ''
      })
    });

    res.json({ result });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Reconciliations ──────────────────────────────────────────────────────────

app.get('/api/reconciliations', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data } = await sbReq(token, 'reconciliations?order=created_at.desc&limit=100', { method: 'GET', prefer: '' });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/reconciliations/:id', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await sbReq(token, `reconciliations?id=eq.${req.params.id}`, { method: 'DELETE', prefer: '' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Invoice Reconciler running at http://localhost:${PORT}\n`);
});