// Vérifie que l'envoi d'e-mails est bien configuré, SANS lancer le jeu :
//   node test-mail.mjs ton.adresse@exemple.fr
// (les variables SMTP_* et MAIL_FROM doivent être définies comme sur le serveur)
import nodemailer from 'nodemailer';

const to = process.argv[2];
const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
if (!to) {
  console.error('Usage : node test-mail.mjs ton.adresse@exemple.fr');
  process.exit(1);
}
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
  console.error('Il manque SMTP_HOST, SMTP_USER ou SMTP_PASS dans les variables d’environnement.');
  process.exit(1);
}
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT) || 587,
  secure: SMTP_SECURE === 'true',
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});
try {
  await transporter.verify();
  await transporter.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to,
    subject: 'Test BulletGrounds',
    text: 'Si tu lis ceci, l’envoi des codes de vérification fonctionne.',
  });
  console.log(`OK : mail de test envoyé à ${to}.`);
} catch (error) {
  console.error('ÉCHEC :', error.message);
  process.exit(1);
}
