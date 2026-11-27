// ---------------------------------------------------------------------------
// Création de compte avec code de vérification envoyé par mail
// ---------------------------------------------------------------------------
// Le compte n'existe PAS tant que l'adresse n'est pas prouvée :
//   1. POST /auth/signup/request-code { email }
//        -> un code aléatoire à 6 chiffres est envoyé à cette adresse (rien n'est écrit dans
//           Firebase : le code n'existe qu'en mémoire du serveur, 10 minutes).
//   2. POST /auth/signup/confirm { email, password, pseudo, code }
//        -> si le code est bon (usage unique), le serveur crée le compte Firebase Auth ET le
//           profil Firestore users/{uid}. Si le code est faux, rien n'est créé nulle part.
// Pas d'inscription = pas de code envoyé. Les comptes existants ne sont pas concernés.
//
// Pourquoi la création passe par le serveur : sinon un client modifié pourrait créer un compte
// sans jamais saisir de code. Les règles Firestore interdisent aussi au client de créer
// lui-même un profil users/{uid} (firestore.rules), et le jeu refuse tout compte sans profil.
//
// Variables d'environnement
//   SMTP_HOST, SMTP_PORT (587 par défaut), SMTP_SECURE (true pour le port 465), SMTP_USER, SMTP_PASS
//   MAIL_FROM            expéditeur, ex. "BulletGrounds <hello.bulletgrounds@gmail.com>"
//   EMAIL_CODE_SECRET    clé de l'empreinte des codes (défaut : dérivée du compte de service Firebase)
//   EMAIL_CODE_DEV_LOG=true    n'envoie rien : affiche le code dans la console (tests en local)
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
const MAX_SENDS_PER_EMAIL_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const HOUR_MS = 60 * 60 * 1000;
// Anti-abus : la demande de code est ouverte à tout le monde (le compte n'existe pas encore),
// il faut donc empêcher d'utiliser le jeu pour inonder des boîtes mail.
const MAX_REQUESTS_PER_IP_PER_HOUR = 10;
const MAX_CONFIRMS_PER_IP_PER_HOUR = 30;
const MAX_MAILS_PER_HOUR_GLOBAL = 300;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function createSignupVerification({ firebaseAuth, firebaseDb, FieldValue, fallbackSecret }) {
  const secret = process.env.EMAIL_CODE_SECRET || fallbackSecret || 'bulletgrounds-signup-code';
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
  if (!devLog && !getTransporter()) {
    console.warn('[INSCRIPTION] SMTP non configuré (SMTP_HOST / SMTP_USER / SMTP_PASS) : personne ne pourra créer de compte.');
  }

  // Codes en attente : en mémoire seulement (jamais dans la base). email -> { codeHash, expiresAt,
  // attempts, lastSentAt, windowStart, sendsInWindow }
  const pending = new Map();
  const ipRequests = new Map(); // ip -> { windowStart, count }
  const ipConfirms = new Map();
  let globalWindow = { windowStart: Date.now(), count: 0 };

  const cleanup = setInterval(() => {
    const now = Date.now();
    pending.forEach((entry, email) => {
      if (now > entry.expiresAt && now - entry.windowStart > HOUR_MS) pending.delete(email);
    });
    [ipRequests, ipConfirms].forEach((map) => map.forEach((v, ip) => { if (now - v.windowStart > HOUR_MS) map.delete(ip); }));
  }, 5 * 60 * 1000);
  cleanup.unref?.();

  function hitLimit(map, key, limit, message) {
    const now = Date.now();
    const entry = map.get(key);
    if (!entry || now - entry.windowStart > HOUR_MS) {
      map.set(key, { windowStart: now, count: 1 });
      return;
    }
    if (entry.count >= limit) throw new HttpError(429, message);
    entry.count += 1;
  }

  const hashCode = (email, code) => crypto.createHmac('sha256', secret).update(`${email}:${code}`).digest('hex');

  function normalizeEmail(raw) {
    const email = String(raw || '').trim().toLowerCase();
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
    return email;
  }

  async function requestCode(rawEmail, ip) {
    const email = normalizeEmail(rawEmail);
    if (!devLog && !getTransporter()) {
      throw new HttpError(503, 'L’envoi d’e-mails n’est pas configuré sur le serveur. Préviens le responsable du jeu.');
    }
    hitLimit(ipRequests, ip, MAX_REQUESTS_PER_IP_PER_HOUR, 'Trop de demandes depuis cette connexion. Réessaie dans une heure.');

    // Adresse déjà utilisée : inutile d'envoyer un code
    try {
      await firebaseAuth.getUserByEmail(email);
      throw new HttpError(409, 'Un compte existe déjà avec cette adresse e-mail. Connecte-toi plutôt.');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error.code !== 'auth/user-not-found') throw error;
    }

    const now = Date.now();
    const previous = pending.get(email);
    if (previous && now - previous.lastSentAt < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - previous.lastSentAt)) / 1000);
      throw new HttpError(429, `Patiente ${wait} s avant de redemander un code.`);
    }
    const inWindow = previous && now - previous.windowStart < HOUR_MS;
    const sends = inWindow ? previous.sendsInWindow : 0;
    if (sends >= MAX_SENDS_PER_EMAIL_PER_HOUR) throw new HttpError(429, 'Trop de codes demandés pour cette adresse. Réessaie dans une heure.');
    if (now - globalWindow.windowStart > HOUR_MS) globalWindow = { windowStart: now, count: 0 };
    if (globalWindow.count >= MAX_MAILS_PER_HOUR_GLOBAL) throw new HttpError(429, 'Beaucoup d’inscriptions en ce moment. Réessaie dans un moment.');

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const entry = {
      codeHash: hashCode(email, code),
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      lastSentAt: now,
      windowStart: inWindow ? previous.windowStart : now,
      sendsInWindow: sends + 1,
    };
    pending.set(email, entry);
    globalWindow.count += 1;

    if (devLog) {
      console.info(`[INSCRIPTION] (mode test) code pour ${email} : ${code}`);
      return;
    }
    try {
      await getTransporter().sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: email,
        subject: `${code} — ton code BulletGrounds`,
        text: `Ton code pour créer ton compte BulletGrounds : ${code}\n\nIl est valable 10 minutes et ne sert qu'une fois. Si tu n'as rien demandé, ignore ce message : aucun compte n'a été créé.`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:16px;color:#222">
          <p>Ton code pour créer ton compte <strong>BulletGrounds</strong> :</p>
          <p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:12px 0">${code}</p>
          <p>Il est valable 10 minutes et ne sert qu'une fois.<br>Si tu n'as rien demandé, ignore ce message : aucun compte n'a été créé.</p></div>`,
      });
    } catch (error) {
      console.error('[INSCRIPTION] Envoi du mail impossible :', error.message);
      pending.delete(email); // le joueur n'y est pour rien : il peut redemander tout de suite
      throw new HttpError(502, 'Le mail n’a pas pu être envoyé. Réessaie dans un moment.');
    }
  }

  async function confirmAndCreate({ email: rawEmail, password, pseudo: rawPseudo, code: rawCode }, ip) {
    const email = normalizeEmail(rawEmail);
    const code = String(rawCode || '').trim();
    const pseudo = String(rawPseudo || '').trim();
    if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Le code contient 6 chiffres.');
    if (pseudo.length < 3) throw new HttpError(400, 'Le pseudo doit faire au moins 3 caractères.');
    if (pseudo.length > 20) throw new HttpError(400, 'Le pseudo doit faire moins de 20 caractères.');
    if (typeof password !== 'string' || password.length < 6) throw new HttpError(400, 'Mot de passe trop court (6 caractères minimum).');
    if (password.length > 128) throw new HttpError(400, 'Mot de passe trop long.');
    hitLimit(ipConfirms, ip, MAX_CONFIRMS_PER_IP_PER_HOUR, 'Trop de tentatives depuis cette connexion. Réessaie dans une heure.');

    const entry = pending.get(email);
    if (!entry) throw new HttpError(400, 'Aucun code en attente pour cette adresse. Demande-en un nouveau.');
    if (Date.now() > entry.expiresAt) {
      pending.delete(email);
      throw new HttpError(400, 'Ce code a expiré. Demande-en un nouveau.');
    }
    if (entry.attempts >= MAX_ATTEMPTS) {
      pending.delete(email);
      throw new HttpError(429, 'Trop d’essais. Demande un nouveau code.');
    }
    const expected = Buffer.from(entry.codeHash, 'hex');
    const given = Buffer.from(hashCode(email, code), 'hex');
    if (!(expected.length === given.length && crypto.timingSafeEqual(expected, given))) {
      entry.attempts += 1;
      const left = MAX_ATTEMPTS - entry.attempts;
      if (left <= 0) pending.delete(email);
      throw new HttpError(400, left > 0 ? `Code incorrect (${left} essai${left > 1 ? 's' : ''} restant${left > 1 ? 's' : ''}).` : 'Code incorrect. Demande un nouveau code.');
    }

    // Code bon : il est consommé tout de suite (usage unique, même si deux requêtes arrivent ensemble)
    pending.delete(email);

    let user;
    try {
      user = await firebaseAuth.createUser({ email, password, displayName: pseudo, emailVerified: true });
    } catch (error) {
      if (error.code === 'auth/email-already-exists') throw new HttpError(409, 'Un compte existe déjà avec cette adresse e-mail. Connecte-toi plutôt.');
      if (error.code === 'auth/invalid-password') throw new HttpError(400, 'Mot de passe trop court (6 caractères minimum).');
      if (error.code === 'auth/invalid-email') throw new HttpError(400, 'Adresse e-mail invalide.');
      pending.set(email, entry); // erreur imprévue : on rend le code pour qu'il puisse réessayer
      throw error;
    }

    try {
      await firebaseDb.collection('users').doc(user.uid).set({
        pseudo,
        pseudoLower: pseudo.toLowerCase(),
        createdAt: FieldValue.serverTimestamp(),
        lastSeenAt: FieldValue.serverTimestamp(),
      });
    } catch (error) {
      await firebaseAuth.deleteUser(user.uid).catch(() => {}); // pas de compte à moitié créé
      throw error;
    }
    return { uid: user.uid };
  }

  return { requestCode, confirmAndCreate };
}
