import nodemailer from 'nodemailer';
import { Resend } from 'resend';

import { env } from './env.js';

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

let transporter: nodemailer.Transporter | null = null;
let resend: Resend | null = null;

function devTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.EMAIL_DEV_SMTP_HOST,
      port: env.EMAIL_DEV_SMTP_PORT,
      secure: false,
      ignoreTLS: true,
    });
  }
  return transporter;
}

export async function sendEmail({ to, subject, html, text }: SendArgs): Promise<void> {
  if (env.RESEND_API_KEY) {
    resend ??= new Resend(env.RESEND_API_KEY);
    await resend.emails.send({ from: env.EMAIL_FROM, to, subject, html, text });
    return;
  }
  // Dev: send to Mailhog or local SMTP.
  await devTransporter().sendMail({ from: env.EMAIL_FROM, to, subject, html, text });
}

// ---------- templates ------------------------------------------------------
// Minimal, brand-consistent HTML. Phase 1 keeps templates inline for speed;
// later we can move to React Email if we want richer composition.

const baseStyles = `
  <style>
    body { margin: 0; padding: 0; background: #f5f7fa; font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; }
    .wrap { max-width: 560px; margin: 32px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(15,23,42,.08); }
    .header { background: #1B4F72; padding: 24px 32px; }
    .brand { color: #ffffff; font-size: 18px; font-weight: 600; letter-spacing: .02em; }
    .body { padding: 32px; line-height: 1.55; font-size: 15px; }
    .btn { display: inline-block; background: #1B4F72; color: #ffffff !important; text-decoration: none; padding: 12px 20px; border-radius: 8px; font-weight: 500; margin: 16px 0; }
    .footer { padding: 16px 32px 24px; color: #64748b; font-size: 12px; }
    .url { word-break: break-all; color: #475569; font-size: 12px; }
  </style>
`;

const wrap = (innerHtml: string) => `
  <!doctype html>
  <html><head><meta charset="utf-8" />${baseStyles}</head>
  <body>
    <div class="wrap">
      <div class="header"><div class="brand">ALIGNED</div></div>
      <div class="body">${innerHtml}</div>
      <div class="footer">ALIGNED Business Platform · Aligning Technology with Your Business</div>
    </div>
  </body></html>
`;

export function emailVerifyTemplate(args: { firstName: string | null; url: string }) {
  const greeting = args.firstName ? `Hi ${args.firstName},` : 'Welcome,';
  const html = wrap(`
    <p>${greeting}</p>
    <p>Confirm your email address to finish setting up your ALIGNED account.</p>
    <p><a class="btn" href="${args.url}">Verify email</a></p>
    <p class="url">Or copy and paste this URL: ${args.url}</p>
    <p>This link expires in 24 hours.</p>
  `);
  const text = `${greeting}\n\nConfirm your email address: ${args.url}\n\nThis link expires in 24 hours.`;
  return { subject: 'Verify your ALIGNED email', html, text };
}

export function passwordResetTemplate(args: { firstName: string | null; url: string }) {
  const greeting = args.firstName ? `Hi ${args.firstName},` : 'Hello,';
  const html = wrap(`
    <p>${greeting}</p>
    <p>We received a request to reset your ALIGNED password. Click below to choose a new one.</p>
    <p><a class="btn" href="${args.url}">Reset password</a></p>
    <p class="url">Or copy and paste: ${args.url}</p>
    <p>If you didn't request this, you can ignore this email — your password won't change.</p>
    <p>This link expires in 1 hour.</p>
  `);
  const text = `${greeting}\n\nReset your password: ${args.url}\n\nIf you didn't request this, ignore this email.`;
  return { subject: 'Reset your ALIGNED password', html, text };
}

export function invitationTemplate(args: { orgName: string; inviterName: string; url: string }) {
  const html = wrap(`
    <p><strong>${args.inviterName}</strong> has invited you to join <strong>${args.orgName}</strong> on ALIGNED.</p>
    <p><a class="btn" href="${args.url}">Accept invitation</a></p>
    <p class="url">Or copy and paste: ${args.url}</p>
    <p>This invitation expires in 7 days.</p>
  `);
  const text = `${args.inviterName} invited you to join ${args.orgName} on ALIGNED.\n\nAccept: ${args.url}\n\nExpires in 7 days.`;
  return { subject: `Join ${args.orgName} on ALIGNED`, html, text };
}
