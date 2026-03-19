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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', anthropic_key_set: !!process.env.ANTHROPIC_API_KEY });
});

// Main proxy route — forwards requests to Anthropic with the API key
app.post('/api/analyze', upload.fields([
  { name: 'invoice_file', maxCount: 1 },
  { name: 'scope_file', maxCount: 1 }
]), async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_anthropic_api_key_here') {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in .env file' });
  }

  try {
    const { invoice_text, scope_text, sub_name } = req.body;
    const userContent = [];

    // Handle uploaded files
    if (req.files) {
      for (const field of ['invoice_file', 'scope_file']) {
        const fileArr = req.files[field];
        if (fileArr && fileArr[0]) {
          const file = fileArr[0];
          const b64 = file.buffer.toString('base64');
          const mt = file.mimetype;
          if (mt === 'application/pdf') {
            userContent.push({ type: 'document', source: { type: 'base64', media_type: mt, data: b64 } });
          } else if (mt.startsWith('image/')) {
            userContent.push({ type: 'image', source: { type: 'base64', media_type: mt, data: b64 } });
          }
        }
      }
    }

    // Build the prompt
    userContent.push({
      type: 'text',
      text: `You are an expert construction invoice auditor. Reconcile the following invoice against the scope of work.

${sub_name ? 'Subcontractor: ' + sub_name : ''}
${invoice_text ? '\n--- INVOICE ---\n' + invoice_text : ''}
${scope_text ? '\n--- SCOPE OF WORK ---\n' + scope_text : ''}

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "sub_name": "string",
  "invoice_number": "string or null",
  "invoice_total": number,
  "approved_total": number,
  "discrepancy_amount": number,
  "recommendation": "APPROVE" | "REVIEW" | "REJECT",
  "summary": "2-3 sentence plain english summary",
  "line_items": [
    {
      "description": "string",
      "invoiced_amount": number,
      "approved_amount": number or null,
      "status": "OK" | "OVER_BUDGET" | "NOT_IN_SCOPE" | "MISSING_FROM_INVOICE" | "UNVERIFIABLE",
      "note": "string"
    }
  ],
  "flags": [
    {
      "severity": "danger" | "warning" | "info",
      "title": "string",
      "detail": "string"
    }
  ]
}`
    });

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    const data = await anthropicResp.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    const raw = (data.content || []).map(b => b.text || '').join('');
    const result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ result });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Invoice Reconciler running at http://localhost:${PORT}`);
  console.log(`   Open that URL in your browser to use the app.\n`);
});
