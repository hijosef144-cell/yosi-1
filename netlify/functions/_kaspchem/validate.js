'use strict';

function normalizePhone(input) {
  let d = String(input || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+972')) d = '0' + d.slice(4);
  else if (d.startsWith('972')) d = '0' + d.slice(3);
  d = d.replace(/\D/g, '');
  // Israeli numbers: 0 + area/mobile prefix + 7 digits (landline 9 digits, mobile 10)
  return /^0[2-9]\d{7,8}$/.test(d) ? d : null;
}

function cleanText(s, min, max) {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length >= min && t.length <= max ? t : null;
}

function cleanEmail(s) {
  if (s == null || String(s).trim() === '') return '';
  const t = String(s).trim().toLowerCase();
  return t.length <= 120 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(t) ? t : null;
}

module.exports = { normalizePhone, cleanText, cleanEmail };
