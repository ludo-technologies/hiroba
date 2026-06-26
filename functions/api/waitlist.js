/**
 * POST /api/waitlist — Cloudflare Pages Function.
 *
 * Receives a waitlist sign-up from the marketing site and emails it to the team
 * via Resend. The static site cannot call Resend directly (the API key must stay
 * server-side), so this function holds the key and does the call.
 *
 * Accepts either JSON (the enhanced fetch path in assets/waitlist.js) or classic
 * form-encoded bodies (the no-JS fallback — a plain <form> POST). It replies in
 * kind: JSON for fetch, a small HTML page for a native form submit.
 *
 * Required env (Cloudflare Pages → Settings → Environment variables):
 *   RESEND_API_KEY   — Resend API key (mark as "encrypted"/secret).
 * Optional env:
 *   WAITLIST_TO      — where leads land. Default: contact@ludo-tech.org
 *   WAITLIST_FROM    — verified Resend sender. Default: Hiroba <waitlist@ludo-tech.org>
 *                      (the domain must be verified in Resend, or sends 403).
 *   WAITLIST_CONFIRM — "off" to skip the confirmation email to the registrant.
 */

const DEFAULTS = {
  to: 'contact@ludo-tech.org',
  from: 'Hiroba <waitlist@ludo-tech.org>',
};

// Deliberately loose: catch obvious typos, not police RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX = { email: 254, text: 200, notes: 2000 };

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

async function readBody(request) {
  const ctype = request.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    try {
      const json = await request.json();
      return { data: json || {}, wantsJson: true };
    } catch {
      return { data: {}, wantsJson: true };
    }
  }
  // form-urlencoded or multipart (no-JS fallback)
  const form = await request.formData();
  const data = {};
  for (const [k, v] of form.entries()) data[k] = typeof v === 'string' ? v : '';
  const accept = request.headers.get('accept') || '';
  return { data, wantsJson: accept.includes('application/json') };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function htmlPage(title, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Hiroba</title>
<style>body{font-family:system-ui,sans-serif;background:#1a1410;color:#f3ece4;
display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:2rem}
a{color:#e8915b}main{max-width:32rem}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
<p><a href="/">← Back to Hiroba</a></p></main></body></html>`;
}

function reply(wantsJson, status, { ok, message, title }) {
  if (wantsJson) {
    return new Response(JSON.stringify({ ok, message }), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return new Response(htmlPage(title || (ok ? 'Thanks' : 'Something went wrong'), message), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function sendEmail(apiKey, payload) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export async function onRequestPost({ request, env }) {
  let parsed;
  try {
    parsed = await readBody(request);
  } catch {
    return reply(true, 400, { ok: false, message: 'Could not read the form.' });
  }
  const { data, wantsJson } = parsed;

  // Honeypot: real users never fill this hidden field. Bots do — pretend success.
  if (clean(data.company_url, MAX.text)) {
    return reply(wantsJson, 200, { ok: true, message: 'Thanks — you are on the list.' });
  }

  const email = clean(data.email, MAX.email).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return reply(wantsJson, 400, {
      ok: false,
      title: 'Check your email',
      message: 'Please enter a valid email address.',
    });
  }

  const org = clean(data.org, MAX.text);
  const headcount = clean(data.headcount, MAX.text);
  const notes = clean(data.notes, MAX.notes);
  const locale = clean(data.locale, 8) || 'en';

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    // Misconfiguration — don't blame the user.
    return reply(wantsJson, 500, {
      ok: false,
      message: 'The waitlist is temporarily unavailable. Please email contact@ludo-tech.org.',
    });
  }

  const to = env.WAITLIST_TO || DEFAULTS.to;
  const from = env.WAITLIST_FROM || DEFAULTS.from;

  const lines = [
    `New Hiroba waitlist sign-up`,
    ``,
    `Email:     ${email}`,
    `Org:       ${org || '—'}`,
    `Headcount: ${headcount || '—'}`,
    `Locale:    ${locale}`,
    ``,
    `Notes:`,
    notes || '—',
  ];

  try {
    await sendEmail(apiKey, {
      from,
      to,
      reply_to: email,
      subject: `[Hiroba] Waitlist: ${email}`,
      text: lines.join('\n'),
    });
  } catch (err) {
    console.error('waitlist notify failed:', err);
    return reply(wantsJson, 502, {
      ok: false,
      message: 'We could not record your sign-up. Please email contact@ludo-tech.org.',
    });
  }

  // Best-effort confirmation to the registrant. Never fails the request.
  if ((env.WAITLIST_CONFIRM || '').toLowerCase() !== 'off') {
    const confirm =
      locale === 'ja'
        ? {
            subject: 'Hiroba ウェイトリストに登録しました',
            text:
              'Hiroba のウェイトリストにご登録ありがとうございます。\n' +
              '準備が整い次第、ダウンロードのご案内をこのメールアドレスにお送りします。\n\n— Hiroba / Ludo Technologies',
          }
        : {
            subject: 'You are on the Hiroba waitlist',
            text:
              'Thanks for joining the Hiroba waitlist.\n' +
              'We will email this address with a download link as soon as we are ready.\n\n— Hiroba / Ludo Technologies',
          };
    try {
      await sendEmail(apiKey, { from, to: email, subject: confirm.subject, text: confirm.text });
    } catch (err) {
      console.error('waitlist confirmation failed (non-fatal):', err);
    }
  }

  return reply(wantsJson, 200, {
    ok: true,
    title: 'You are on the list',
    message: 'Thanks — we will email you a download link when it is ready.',
  });
}

// Anything other than POST.
export async function onRequest({ request }) {
  if (request.method === 'POST') return; // handled by onRequestPost
  return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
}
