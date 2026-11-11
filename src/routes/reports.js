// ============================================================
// SIGNALEMENTS — POST /api/reports : « Signaler un problème avec ce lieu »
// Rien n'est enregistré : le signalement est envoyé par e-mail à l'équipe.
// ============================================================
const express = require('express');
const router = express.Router();
const { sendTeamMail, mailProvider, makeLimiter, clientIp, esc, clean, EMAIL_RE } = require('../mailer');
const KINDS = { ferme: 'Lieu fermé ou n\'existe plus', adresse: 'Adresse ou position fausse', infos: 'Informations fausses (ablutions, accès, horaires…)', photo: 'Photo qui ne correspond pas', autre: 'Autre' };
const allowed = makeLimiter(5, 120);

router.post('/', async (req, res) => {
  const b = req.body || {};
  if (clean(b.website, 200)) return res.json({ ok: true }); // champ piège : robot
  const r = {
    placeId: clean(b.place_id, 60), placeName: clean(b.place_name, 140), kind: clean(b.kind, 20),
    message: clean(b.message, 1000), contactEmail: clean(b.contact_email, 120)
  };
  if (!r.placeName || !KINDS[r.kind]) return res.status(400).json({ error: 'Choisis le type de problème' });
  if (r.kind === 'autre' && r.message.length < 5) return res.status(400).json({ error: 'Décris le problème en quelques mots' });
  if (r.contactEmail && !EMAIL_RE.test(r.contactEmail)) return res.status(400).json({ error: 'Adresse e-mail invalide' });
  if (!mailProvider()) return res.status(503).json({ error: 'Envoi momentanément indisponible', fallback: 'mail' });
  if (!allowed(clientIp(req))) return res.status(429).json({ error: 'Trop de signalements envoyés. Réessaie dans une heure.' });

  const rows = [['Lieu', r.placeName], ['Problème', KINDS[r.kind]], ['Détails', r.message || '—'],
    ['Signalé par', r.contactEmail || 'Anonyme'], ['Identifiant du lieu', r.placeId || '—']];
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0d1f18">
    <h2 style="color:#b54708;margin:0 0 12px">⚠️ Signalement sur un lieu</h2>
    <table style="border-collapse:collapse">${rows.map(([k, v]) =>
      `<tr><td style="padding:6px 14px 6px 0;color:#7a8f86;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;white-space:pre-wrap">${esc(v)}</td></tr>`).join('')}</table>
    <p style="margin:18px 0 0;color:#7a8f86;font-size:12px">Envoyé depuis le bouton « Signaler un problème » de Prayer Spot.${r.contactEmail ? ' Réponds directement à ce message pour écrire à la personne.' : ''}</p></div>`;
  const text = rows.map(([k, v]) => `${k} : ${v}`).join('\n');
  const ok = await sendTeamMail({ subject: `⚠️ Signalement : ${r.placeName} — ${KINDS[r.kind]}`, html, text, replyTo: r.contactEmail || null, label: 'Signalement' });
  if (!ok) return res.status(502).json({ error: 'Envoi impossible pour le moment', fallback: 'mail' });
  console.log(`Signalement envoyé : ${r.placeName} (${r.kind})`);
  res.json({ ok: true });
});
module.exports = router;
