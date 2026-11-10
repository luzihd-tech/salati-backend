// ============================================================
// SUGGESTIONS DE LIEUX → e-mail
// POST /api/suggestions : le formulaire « Suggérer un lieu » de l'app.
// Rien n'est enregistré : la suggestion est envoyée par e-mail à l'équipe.
// Envoi par Gmail (variable Render GMAIL_APP_PASSWORD = mot de passe d'application
// du compte spotprayer@gmail.com), sinon par Resend (RESEND_API_KEY) si configuré.
// Facultatif : GMAIL_USER, SUGGESTIONS_TO
// ============================================================
const express = require('express');
const router = express.Router();

const GMAIL_USER = process.env.GMAIL_USER || 'spotprayer@gmail.com';
const TO = process.env.SUGGESTIONS_TO || GMAIL_USER;
const FROM = process.env.SUGGESTIONS_FROM || 'Prayer Spot <onboarding@resend.dev>';

let gmailTransport = null;
function getGmail() {
  if (!gmailTransport) {
    const nodemailer = require('nodemailer');
    gmailTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, '') },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
    });
  }
  return gmailTransport;
}
function mailProvider() {
  if (process.env.GMAIL_APP_PASSWORD) return 'gmail';
  if (process.env.RESEND_API_KEY) return 'resend';
  return null;
}
const TYPES = { mosque: 'Mosquée', other: 'Salle de prière', shop: 'Commerce', restaurant: 'Restaurant' };
const YESNO = { oui: 'Oui', non: 'Non', '?': 'Je ne sais pas' };
const GENRES = { mixte: 'Hommes et femmes', hommes: 'Hommes', femmes: 'Femmes', '?': 'Je ne sais pas' };
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

// ── Anti-spam : 5 suggestions par heure depuis une même connexion, 90 par jour au total ──
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const perIp = new Map();
let dayCount = 0, dayStart = Date.now();
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || 'inconnu';
}
function allowed(ip) {
  const now = Date.now();
  if (now - dayStart > DAY) { dayStart = now; dayCount = 0; }
  if (dayCount >= 90) return false;
  const list = (perIp.get(ip) || []).filter(t => now - t < HOUR);
  if (list.length >= 5) { perIp.set(ip, list); return false; }
  list.push(now); perIp.set(ip, list); dayCount++;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of perIp) if (!v.some(t => now - t < HOUR)) perIp.delete(k); }, 15 * 60 * 1000).unref();

const clean = (v, max) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

router.post('/', async (req, res) => {
  const b = req.body || {};
  // Champ piège invisible : rempli = robot → on fait comme si tout allait bien, sans rien envoyer
  if (clean(b.website, 200)) return res.json({ ok: true });

  const s = {
    name: clean(b.name, 120), type: clean(b.type, 20), address: clean(b.address, 200), city: clean(b.city, 80),
    ablution: clean(b.ablution, 3), wc: clean(b.wc, 3), genre: clean(b.genre, 10),
    info: clean(b.info, 800), mawaqit: clean(b.mawaqit, 300),
    contactName: clean(b.contact_name, 60), contactEmail: clean(b.contact_email, 120)
  };
  if (s.name.length < 2 || !TYPES[s.type] || s.address.length < 3 || !s.city) {
    return res.status(400).json({ error: 'Nom, type, adresse et ville sont obligatoires' });
  }
  if (s.contactEmail && !EMAIL_RE.test(s.contactEmail)) return res.status(400).json({ error: 'Adresse e-mail invalide' });
  if (s.mawaqit && !/^https?:\/\/(www\.)?mawaqit\.net\//i.test(s.mawaqit)) s.mawaqit = '';

  const provider = mailProvider();
  if (!provider) return res.status(503).json({ error: 'Envoi momentanément indisponible', fallback: 'mail' });
  if (!allowed(clientIp(req))) return res.status(429).json({ error: 'Trop de suggestions envoyées. Réessaie dans une heure.' });

  const full = `${s.address}, ${s.city}`;
  const maps = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(`${s.name}, ${full}`);
  const rows = [
    ['Nom du lieu', s.name], ['Type', TYPES[s.type]], ['Adresse', full],
    ['Ablutions', YESNO[s.ablution] || 'Non précisé'], ['Toilettes', YESNO[s.wc] || 'Non précisé'],
    ['Accès', GENRES[s.genre] || 'Non précisé'], ['Infos utiles', s.info || '—'],
    ['Lien Mawaqit', s.mawaqit || '—'],
    ['Suggéré par', [s.contactName, s.contactEmail].filter(Boolean).join(' — ') || 'Anonyme']
  ];
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0d1f18">
    <h2 style="color:#0d6e47;margin:0 0 12px">📍 Nouvelle suggestion de lieu</h2>
    <table style="border-collapse:collapse">${rows.map(([k, v]) =>
      `<tr><td style="padding:6px 14px 6px 0;color:#7a8f86;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;white-space:pre-wrap">${esc(v)}</td></tr>`).join('')}</table>
    <p style="margin:16px 0 0"><a href="${esc(maps)}" style="color:#0d6e47;font-weight:bold">Voir l'adresse sur Google Maps →</a></p>
    <p style="margin:18px 0 0;color:#7a8f86;font-size:12px">Envoyé depuis le formulaire « Suggérer un lieu » de Prayer Spot.${s.contactEmail ? ' Réponds directement à ce message pour écrire à la personne.' : ''}</p></div>`;
  const text = rows.map(([k, v]) => `${k} : ${v}`).join('\n') + `\n\nGoogle Maps : ${maps}`;

  const subject = `📍 Nouvelle suggestion : ${s.name} (${s.city})`;

  if (provider === 'gmail') {
    try {
      await getGmail().sendMail({ from: `"Prayer Spot" <${GMAIL_USER}>`, to: TO, subject, html, text, ...(s.contactEmail ? { replyTo: s.contactEmail } : {}) });
      console.log(`Suggestion envoyée : ${s.name} (${s.city})`);
      return res.json({ ok: true });
    } catch (e) {
      console.error('Suggestion : Gmail a refusé l\'envoi —', e.code || '', (e.message || '').slice(0, 200));
      return res.status(502).json({ error: 'Envoi impossible pour le moment', fallback: 'mail' });
    }
  }

  const payload = { from: FROM, to: [TO], subject, html, text };
  if (s.contactEmail) payload.reply_to = s.contactEmail;

  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    clearTimeout(t);
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('Suggestion : Resend a refusé l\'envoi —', r.status, detail.slice(0, 200));
      return res.status(502).json({ error: 'Envoi impossible pour le moment', fallback: 'mail' });
    }
    console.log(`Suggestion envoyée : ${s.name} (${s.city})`);
    res.json({ ok: true });
  } catch (e) {
    console.error('Suggestion : Resend injoignable —', e.message);
    res.status(502).json({ error: 'Envoi impossible pour le moment', fallback: 'mail' });
  }
});

module.exports = router;
