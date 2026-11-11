// ============================================================
// ENVOI D'E-MAILS À L'ÉQUIPE (suggestions de lieux, signalements)
// Gmail (GMAIL_APP_PASSWORD = mot de passe d'application de spotprayer@gmail.com),
// sinon Resend (RESEND_API_KEY) si configuré. Facultatif : GMAIL_USER, SUGGESTIONS_TO
// ============================================================
const GMAIL_USER = () => process.env.GMAIL_USER || 'spotprayer@gmail.com';
const TO = () => process.env.SUGGESTIONS_TO || GMAIL_USER();
const FROM_RESEND = () => process.env.SUGGESTIONS_FROM || 'Prayer Spot <onboarding@resend.dev>';

let gmailTransport = null, gmailPass = null;
function getGmail() {
  const pass = String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, '');
  if (!gmailTransport || gmailPass !== pass) {
    const nodemailer = require('nodemailer');
    gmailTransport = nodemailer.createTransport({
      service: 'gmail', auth: { user: GMAIL_USER(), pass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
    });
    gmailPass = pass;
  }
  return gmailTransport;
}
function mailProvider() {
  if (process.env.GMAIL_APP_PASSWORD) return 'gmail';
  if (process.env.RESEND_API_KEY) return 'resend';
  return null;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (v, max) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || 'inconnu';
}
// Anti-spam : N envois par heure depuis une même connexion, M par jour au total
function makeLimiter(perHour, perDay) {
  const HOUR = 3600 * 1000, DAY = 24 * HOUR, perIp = new Map();
  let dayCount = 0, dayStart = Date.now();
  setInterval(() => { const now = Date.now(); for (const [k, v] of perIp) if (!v.some(t => now - t < HOUR)) perIp.delete(k); }, 15 * 60 * 1000).unref();
  return ip => {
    const now = Date.now();
    if (now - dayStart > DAY) { dayStart = now; dayCount = 0; }
    if (dayCount >= perDay) return false;
    const list = (perIp.get(ip) || []).filter(t => now - t < HOUR);
    if (list.length >= perHour) { perIp.set(ip, list); return false; }
    list.push(now); perIp.set(ip, list); dayCount++;
    return true;
  };
}
// Envoie un e-mail à l'équipe. Renvoie true si parti, false sinon (erreur déjà journalisée).
async function sendTeamMail({ subject, html, text, replyTo, label }) {
  const provider = mailProvider();
  if (!provider) return false;
  if (provider === 'gmail') {
    try {
      await getGmail().sendMail({ from: `"Prayer Spot" <${GMAIL_USER()}>`, to: TO(), subject, html, text, ...(replyTo ? { replyTo } : {}) });
      return true;
    } catch (e) {
      console.error(`${label} : Gmail a refusé l'envoi —`, e.code || '', (e.message || '').slice(0, 200));
      return false;
    }
  }
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_RESEND(), to: [TO()], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) })
    });
    clearTimeout(t);
    if (!r.ok) { console.error(`${label} : Resend a refusé l'envoi —`, r.status, (await r.text().catch(() => '')).slice(0, 200)); return false; }
    return true;
  } catch (e) { console.error(`${label} : Resend injoignable —`, e.message); return false; }
}
module.exports = { sendTeamMail, mailProvider, makeLimiter, clientIp, esc, clean, EMAIL_RE };
