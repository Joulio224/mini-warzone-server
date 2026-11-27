// ---------------------------------------------------------------------------
// Vérification des comptes par code envoyé par mail
// ---------------------------------------------------------------------------
// Chaque NOUVEAU compte doit saisir un code à 6 chiffres reçu par mail avant de pouvoir jouer.
//
// Fonctionnement
//   - POST /auth/send-code   : génère un code, n'en garde que l'empreinte (HMAC) dans
//                              emailVerifications/{uid} (Firestore, accessible au serveur seulement)
//                              et l'envoie à l'adresse DU COMPTE (lue dans le jeton Firebase, jamais
//                              fournie par le client).
//   - POST /auth/verify-code : compare le code ; si c'est bon, pose le claim Firebase
//                              emailCodeVerified = true sur le compte.
//   - GET  /auth/status      : { verified } — le client s'en sert pour afficher l'écran de saisie.
//   - Le socket de jeu refuse les comptes non vérifiés (voir io.use dans server.js).
//
// Anciens comptes : tous ceux créés AVANT EMAIL_CODE_REQUIRED_FROM sont considérés comme
// vérifiés (sinon on bloquerait tous les joueurs actuels). Mets dans cette variable la date/heure
// exacte du déploiement, ex. 2026-11-25T18:00:00Z.
//
// Variables d'environnement
//   SMTP_HOST, SMTP_PORT (587 par défaut), SMTP_SECURE (true pour le port 465), SMTP_USER, SMTP_PASS
//   MAIL_FROM            expéditeur, ex. "BulletGrounds <ne-pas-repondre@ton-domaine.fr>"
//   EMAIL_CODE_REQUIRED_FROM   voir ci-dessus (défaut : 2026-11-24T00:00:00Z)
//   EMAIL_CODE_SECRET    clé de l'empreinte des codes (défaut : dérivée du compte de service Firebase)
//   EMAIL_CODE_DEV_LOG=true    n'envoie rien : affiche le code dans la console (tests en local)
//   EMAIL_CODE_REQUIRED=false  coupe toute l'exigence (interrupteur de secours)
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const HOUR_MS = 60 * 60 * 1000;

export function createEmailVerification({ firebaseAuth, firebaseDb, fallbackSecret }) {
  const enabled = process.env.EMAIL_CODE_REQUIRED !== 'false';
  const requiredFromMs = Date.parse(process.env.EMAIL_CODE_REQUIRED_FROM || '2026-11-24T00:00:00Z');
  if (!Number.isFinite(requiredFromMs)) {
    throw new Error('EMAIL_CODE_REQUIRED_FROM doit être une date ISO valide (ex. 2026-11-25T18:00:00Z).');
  }
  const secret = process.env.EMAIL_CODE_SECRET || fallbackSecret || 'bulletgrounds-email-code';
  const devLog = process.env.EMAIL_CODE_DEV_LOG === 'true';

  let transporter = null;
  function getTransporter() {
    if (transporter) return transporter;
    const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 587,
      secure: SMTP_SECURE === 'true',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    return transporter;
  }

  if (enabled && !devLog && !getTransporter()) {
    console.warn('[VERIF] SMTP non configuré (SMTP_HOST / SMTP_USER / SMTP_PASS) : les nouveaux comptes ne pourront pas recevoir leur code.');
  }

  const codesRef = (uid) => firebaseDb.collection('emailVerifications').doc(uid);
  const hashCode = (uid, code) => crypto.createHmac('sha256', secret).update(`${uid}:${code}`).digest('hex');

  // Vérifié = a saisi son code, OU compte créé avant la mise en place du système (ou exigence coupée).
  // Dans ces deux derniers cas on pose aussi le claim, pour que les règles Firestore (qui exigent
  // emailCodeVerified) laissent passer les anciens comptes sans script de migration : c'est fait
  // tout seul à leur prochaine connexion.
  async function isVerified(uid) {
    const record = await firebaseAuth.getUser(uid);
    if (record.customClaims?.emailCodeVerified === true) return true;
    const createdMs = Date.parse(record.metadata?.creationTime || '');
    const legacy = Number.isFinite(createdMs) && createdMs < requiredFromMs;
    if (!enabled || legacy) {
      try {
        await firebaseAuth.setCustomUserClaims(uid, { ...(record.customClaims || {}), emailCodeVerified: true });
      } catch (error) {
        console.error('[VERIF] Claim impossible à poser pour un ancien compte :', error.message);
      }
      return true;
    }
    return false;
  }

  async function sendCode(uid, email) {
    if (!email) throw new HttpError(400, 'Ce compte n’a pas d’adresse e-mail.');
    if (await isVerified(uid)) throw new HttpError(400, 'Ce compte est déjà vérifié.');
    if (!devLog && !getTransporter()) {
      throw new HttpError(503, 'L’envoi d’e-mails n’est pas configuré sur le serveur. Préviens le responsable du jeu.');
    }

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const now = Date.now();

    // Limites d'envoi : 1 par minute, 5 par heure (transaction : pas de contournement en parallèle)
    await firebaseDb.runTransaction(async (tx) => {
      const snap = await tx.get(codesRef(uid));
      const data = snap.exists ? snap.data() : {};
      if (data.lastSentAt && now - data.lastSentAt < RESEND_COOLDOWN_MS) {
        const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - data.lastSentAt)) / 1000);
        throw new HttpError(429, `Patiente ${wait} s avant de redemander un code.`);
      }
      const inWindow = data.windowStart && now - data.windowStart < HOUR_MS;
      const sends = inWindow ? data.sendsInWindow || 0 : 0;
      if (sends >= MAX_SENDS_PER_HOUR) {
        throw new HttpError(429, 'Trop de codes demandés. Réessaie dans une heure.');
      }
      tx.set(codesRef(uid), {
        codeHash: hashCode(uid, code),
        email,
        expiresAt: now + CODE_TTL_MS,
        attempts: 0,
        lastSentAt: now,
        windowStart: inWindow ? data.windowStart : now,
        sendsInWindow: sends + 1,
      });
    });

    if (devLog) {
      console.info(`[VERIF] (mode test) code pour ${email} : ${code}`);
      return;
    }
    try {
      await getTransporter().sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: email,
        subject: `${code} — ton code BulletGrounds`,
        text: `Ton code de vérification BulletGrounds : ${code}\n\nIl est valable 10 minutes. Si ce n’est pas toi qui as créé ce compte, ignore ce message.`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:16px;color:#222">
          <p>Ton code de vérification <strong>BulletGrounds</strong> :</p>
          <p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:12px 0">${code}</p>
          <p>Il est valable 10 minutes.<br>Si ce n’est pas toi qui as créé ce compte, ignore ce message.</p></div>`,
      });
    } catch (error) {
      console.error('[VERIF] Envoi du mail impossible :', error.message);
      // Ce n'est pas la faute du joueur : on libère le délai d'attente pour qu'il puisse réessayer
      await codesRef(uid).update({ lastSentAt: 0 }).catch(() => {});
      throw new HttpError(502, 'Le mail n’a pas pu être envoyé. Réessaie dans un moment.');
    }
  }

  async function verifyCode(uid, rawCode) {
    const code = String(rawCode || '').trim();
    if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Le code contient 6 chiffres.');

    const outcome = await firebaseDb.runTransaction(async (tx) => {
      const snap = await tx.get(codesRef(uid));
      if (!snap.exists) return { error: new HttpError(400, 'Aucun code en attente. Demande-en un nouveau.') };
      const data = snap.data();
      if (Date.now() > data.expiresAt) {
        tx.delete(codesRef(uid));
        return { error: new HttpError(400, 'Ce code a expiré. Demande-en un nouveau.') };
      }
      if ((data.attempts || 0) >= MAX_ATTEMPTS) {
        return { error: new HttpError(429, 'Trop d’essais. Demande un nouveau code.') };
      }
      const expected = Buffer.from(data.codeHash, 'hex');
      const given = Buffer.from(hashCode(uid, code), 'hex');
      const ok = expected.length === given.length && crypto.timingSafeEqual(expected, given);
      if (!ok) {
        const attempts = (data.attempts || 0) + 1;
        tx.update(codesRef(uid), { attempts });
        const left = MAX_ATTEMPTS - attempts;
        return {
          error: new HttpError(
            400,
            left > 0 ? `Code incorrect (${left} essai${left > 1 ? 's' : ''} restant${left > 1 ? 's' : ''}).` : 'Code incorrect. Demande un nouveau code.'
          ),
        };
      }
      tx.delete(codesRef(uid));
      return { ok: true };
    });
    if (outcome.error) throw outcome.error;

    const record = await firebaseAuth.getUser(uid);
    await firebaseAuth.setCustomUserClaims(uid, { ...(record.customClaims || {}), emailCodeVerified: true });
  }

  return { isVerified, sendCode, verifyCode, enabled };
}
