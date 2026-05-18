const nodemailer = require('nodemailer');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) };
  }

  const { userEmail, calculatorType, resultsHtml, resultsData } = body;

  if (!userEmail || !calculatorType) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };
  }

  const calcName = calculatorType === 'pension'
    ? 'מחשבון פרישה מתקדם'
    : 'מחשבון נדל"ן מקצועי';

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  // ── Email to user ──────────────────────────────────────────────────────────
  const userHtml = `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>התוצאות שלך — מצפן כלכלי</title>
</head>
<body style="margin:0;padding:20px;background:#f8f9fa;font-family:'Segoe UI',Arial,sans-serif;direction:rtl">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

    <!-- Header -->
    <tr>
      <td style="background:#1e3a5f;padding:28px 32px">
        <div style="font-size:22px;font-weight:700;color:#ffffff">מצפן כלכלי</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.72);margin-top:4px">יוסי כץ | matzpenkalkali.com</div>
      </td>
    </tr>

    <!-- Body -->
    <tr>
      <td style="padding:32px">
        <p style="font-size:19px;font-weight:600;color:#1e3a5f;margin:0 0 8px 0">הנה התוצאות שלך! 🎯</p>
        <p style="font-size:15px;color:#4a5568;line-height:1.75;margin:0 0 24px 0">
          מאחלים לך שתצליח ושהמספרים יעבדו לטובתך!<br>
          אם יש שאלות או שתרצה לדון בתוצאות עם יועץ —<br>
          נשמח לייעץ לך אישית.
        </p>

        <!-- Results box -->
        <div style="background:#f8f9fa;border-radius:10px;padding:20px;margin-bottom:28px;border:1px solid #e2e8f0">
          <div style="font-size:12px;font-weight:600;color:#1e3a5f;margin-bottom:14px;text-transform:uppercase;letter-spacing:0.6px">${calcName}</div>
          ${resultsHtml || ''}
        </div>

        <!-- CTA -->
        <div style="text-align:center">
          <a href="https://matzpenkalkali.com"
             style="display:inline-block;background:#1e3a5f;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600">
            לאתר מצפן כלכלי ←
          </a>
        </div>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background:#f8f9fa;padding:18px 32px;border-top:1px solid #e2e8f0;text-align:center">
        <p style="font-size:12px;color:#718096;margin:0">
          מצפן כלכלי | יוסי כץ |
          <a href="https://matzpenkalkali.com" style="color:#2563eb;text-decoration:none">matzpenkalkali.com</a>
        </p>
        <p style="font-size:11px;color:#a0aec0;margin:4px 0 0 0">מייל זה נשלח כי ביקשת לקבל את תוצאות המחשבון</p>
      </td>
    </tr>

  </table>
</body>
</html>`;

  // ── Owner notification ─────────────────────────────────────────────────────
  const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const dataRows = Object.entries(resultsData || {})
    .map(([k, v]) =>
      `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;color:#4a5568">${k}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#1a1a2e;direction:ltr;text-align:left">${v}</td>
      </tr>`
    ).join('');

  const ownerHtml = `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;direction:rtl;padding:24px;background:#f8f9fa">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;padding:24px;border:1px solid #e2e8f0">
    <h2 style="color:#1e3a5f;margin:0 0 20px 0">📊 תוצאות נשלחו — ${calcName}</h2>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <tr style="background:#f8f9fa">
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#4a5568;font-weight:600">פרטי שליחה</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0"></td>
      </tr>
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;color:#4a5568">מייל המשתמש</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#1a1a2e">${userEmail}</td>
      </tr>
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;color:#4a5568">מחשבון</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#1a1a2e">${calcName}</td>
      </tr>
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;color:#4a5568">תאריך ושעה</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#1a1a2e">${now}</td>
      </tr>
      <tr style="background:#f8f9fa">
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#4a5568;font-weight:600" colspan="2">תוצאות עיקריות</td>
      </tr>
      ${dataRows}
    </table>
  </div>
</body>
</html>`;

  try {
    // Send to user
    await transporter.sendMail({
      from: `"יוסי כץ — מצפן כלכלי" <${process.env.GMAIL_USER}>`,
      to: userEmail,
      subject: `התוצאות שלך מ${calcName} | מצפן כלכלי`,
      html: userHtml
    });

    // Notify owner
    await transporter.sendMail({
      from: `"מצפן כלכלי" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      subject: `📊 ${calcName} נשלח | ${userEmail}`,
      html: ownerHtml
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('Email send error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
