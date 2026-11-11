// Sends one of the four money-fund guides (PDF attached + a link to the page) to an email address the visitor typed.
// Same mail account and style as send-results.js (the calculators), but with a fixed whitelist of guides, a same-site origin check,
// a honeypot and best-effort throttling so it cannot be used as a general mail relay.
const nodemailer = require('nodemailer');

const GUIDES = {
  'buy-money-fund-pagi': 'איך קונים קרן כספית בבנק פאג״י',
  'buy-money-fund-poalim': 'איך קונים קרן כספית בבנק הפועלים',
  'sell-money-fund-pagi': 'איך מוכרים קרן כספית בבנק פאג״י',
  'standing-order-money-fund-poalim': 'איך מקימים הוראת קבע (הו״ק) לקרן כספית בבנק הפועלים'
};

const PROD = 'https://matzpenkalkali.com';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode, body) => ({ statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@<>",;:()\[\]\\]+@[^\s@<>",;:()\[\]\\]+\.[^\s@<>",;:()\[\]\\]{2,}$/;

// Only this site (production or one of its Netlify previews) may call the function. Browsers always send Origin on a cross-origin or POST fetch.
function trustedOrigin(headers) {
  const o = String((headers && (headers.origin || headers.Origin)) || '');
  if (/^https:\/\/(www\.)?matzpenkalkali\.com$/.test(o)) return o.replace('://www.', '://');
  if (/^https:\/\/[a-z0-9-]+--matzpenkalkali\.netlify\.app$/.test(o)) return o;
  return null;
}

// Best-effort limits (kept in memory, so they reset when the function instance is recycled).
const hits = new Map();
function throttled(key, max, windowMs, now) {
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) for (const k of hits.keys()) { if (!(hits.get(k) || []).some((t) => now - t < windowMs)) hits.delete(k); }
  return false;
}

let makeTransport = () => nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });

async function fetchPdf(base, slug) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(base + '/knowledge/guides/' + slug + '/' + slug + '.pdf', { signal: ctl.signal });
    if (!r.ok || !/pdf/i.test(r.headers.get('content-type') || '')) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 0 && buf.length <= 8 * 1024 * 1024 ? buf : null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

function userHtml(title, pageUrl, attached) {
  return `<!DOCTYPE html>
<html dir="rtl" lang="he"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${esc(title)}</title></head>
<body style="margin:0;padding:20px;background:#f8f9fa;font-family:'Segoe UI',Arial,sans-serif;direction:rtl">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <tr><td style="background:#1e3a5f;padding:28px 32px"><div style="font-size:22px;font-weight:700;color:#ffffff">מצפן כלכלי</div><div style="font-size:13px;color:rgba(255,255,255,0.72);margin-top:4px">matzpenkalkali.com</div></td></tr>
    <tr><td style="padding:32px">
      <p style="font-size:19px;font-weight:600;color:#1e3a5f;margin:0 0 8px 0">המדריך שביקשתם</p>
      <p style="font-size:17px;font-weight:600;color:#1a1a2e;margin:0 0 14px 0">${esc(title)}</p>
      <p style="font-size:15px;color:#4a5568;line-height:1.75;margin:0 0 24px 0">${attached ? 'המדריך מצורף למייל זה כקובץ PDF. אפשר גם לפתוח אותו באתר:' : 'לא הצלחנו לצרף את הקובץ, אבל אפשר לפתוח את המדריך ולהוריד אותו מהאתר:'}</p>
      <div style="text-align:center"><a href="${esc(pageUrl)}" style="display:inline-block;background:#1e3a5f;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600">לפתיחת המדריך באתר ←</a></div>
    </td></tr>
    <tr><td style="background:#f8f9fa;padding:18px 32px;border-top:1px solid #e2e8f0;text-align:center"><p style="font-size:12px;color:#718096;margin:0">מצפן כלכלי | <a href="https://matzpenkalkali.com" style="color:#2563eb;text-decoration:none">matzpenkalkali.com</a></p><p style="font-size:11px;color:#a0aec0;margin:4px 0 0 0">מייל זה נשלח כי ביקשתם לקבל את המדריך</p></td></tr>
  </table>
</body></html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'method_not_allowed' });
  const base = trustedOrigin(event.headers);
  if (!base) return reply(403, { ok: false, error: 'forbidden' });
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) { console.error('send-guide: mail account not configured'); return reply(500, { ok: false, error: 'server' }); }

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { ok: false, error: 'bad_request' }); }
  const email = typeof b.userEmail === 'string' ? b.userEmail.trim() : '';
  const slug = typeof b.slug === 'string' ? b.slug : '';
  if (b.website) return reply(200, { ok: true, attached: false });                       // honeypot: pretend success, send nothing
  if (!Object.prototype.hasOwnProperty.call(GUIDES, slug)) return reply(400, { ok: false, error: 'bad_guide' });
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return reply(400, { ok: false, error: 'bad_email' });
  if (b.consent !== true) return reply(400, { ok: false, error: 'consent_required' });

  const now = Date.now(), ip = String((event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'])) || 'unknown');
  if (throttled('ip:' + ip, 6, 3600e3, now) || throttled('mail:' + email.toLowerCase(), 3, 86400e3, now) || throttled('all', 300, 3600e3, now)) return reply(429, { ok: false, error: 'too_many' });

  const title = GUIDES[slug], pageUrl = base + '/knowledge/guides/' + slug + '/';
  try {
    const pdf = await fetchPdf(base, slug);
    const tr = makeTransport();
    await tr.sendMail({
      from: `"מצפן כלכלי" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: `המדריך שביקשתם: ${title} | מצפן כלכלי`,
      text: `המדריך שביקשתם: ${title}\n${pdf ? 'הקובץ מצורף למייל. ' : ''}אפשר גם לפתוח אותו באתר: ${pageUrl}\n\nמצפן כלכלי | matzpenkalkali.com`,
      html: userHtml(title, pageUrl, !!pdf),
      attachments: pdf ? [{ filename: slug + '.pdf', content: pdf, contentType: 'application/pdf' }] : []
    });
    try { // notification to the owner, as the calculators do (values are escaped; a failure here never fails the visitor's request)
      await tr.sendMail({
        from: `"מצפן כלכלי" <${process.env.GMAIL_USER}>`, to: process.env.GMAIL_USER,
        subject: `📧 מדריך נשלח | ${title}`,
        html: `<div dir="rtl" style="font-family:Arial,sans-serif"><p>נשלח מדריך באימייל.</p><p><b>מדריך:</b> ${esc(title)}<br><b>מייל:</b> ${esc(email)}<br><b>מועד:</b> ${esc(new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }))}</p></div>`
      });
    } catch (e) { console.error('send-guide: owner notification failed'); }
    return reply(200, { ok: true, attached: !!pdf });
  } catch (e) {
    console.error('send-guide: send failed', e && e.code ? e.code : '');
    return reply(500, { ok: false, error: 'send_failed' });
  }
};

// Test hooks (not used in production).
exports.__test = { setTransport: (f) => { makeTransport = f; }, reset: () => hits.clear(), GUIDES, trustedOrigin };
