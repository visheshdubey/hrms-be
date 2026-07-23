import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const FROM_EMAIL = process.env.FROM_EMAIL || process.env.SMTP_USER || 'noreply@hrms.com';

export function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function deliverRawEmail(input: {
  to: string;
  subject: string;
  html: string;
  label?: string;
}): Promise<boolean> {
  const label = input.label ?? 'Email';

  // E2E / local automation only — set SKIP_OUTBOUND_EMAIL=1 so tests can invite
  // without hitting a real mailbox. Product invite/reset flows stay unchanged.
  if (process.env.SKIP_OUTBOUND_EMAIL === '1' || process.env.SKIP_OUTBOUND_EMAIL === 'true') {
    console.log(`[EMAIL SKIP] ${label} — SKIP_OUTBOUND_EMAIL is set`);
    console.log(`  To: ${input.to}`);
    console.log(`  Subject: ${input.subject}`);
    return true;
  }

  if (!isSmtpConfigured()) {
    console.log(`[EMAIL MOCK] ${label} — SMTP not configured`);
    console.log(`  To: ${input.to}`);
    console.log(`  Subject: ${input.subject}`);
    const linkMatch = input.html.match(/href="([^"]+)"/);
    if (linkMatch) console.log(`  Link: ${linkMatch[1]}`);
    return true;
  }

  try {
    const info = await transporter.sendMail({
      from: `"HRMS Team" <${FROM_EMAIL}>`,
      to: input.to,
      subject: input.subject,
      html: input.html,
    });
    console.log(`${label} sent: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error(`Error sending ${label.toLowerCase()}:`, error);
    return false;
  }
}

export function buildVerificationEmailHtml(verifyToken: string) {
  const verifyLink = `${FRONTEND_URL}/accept-invite?token=${verifyToken}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
      <h2 style="color: #333;">Welcome to HRMS!</h2>
      <p style="color: #555; line-height: 1.5;">
        Thank you for registering. To complete your account setup, please verify your email address by clicking the button below.
      </p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${verifyLink}" style="background-color: #000; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; display: inline-block;">
          Verify Email & Set Password
        </a>
      </div>
      <p style="color: #555; font-size: 14px;">
        Or copy and paste this link into your browser:<br>
        <a href="${verifyLink}" style="color: #0066cc;">${verifyLink}</a>
      </p>
      <hr style="border: none; border-top: 1px solid #eaeaea; margin: 30px 0;">
      <p style="color: #888; font-size: 12px; text-align: center;">
        If you did not request this email, you can safely ignore it.
      </p>
    </div>
  `;
  return { subject: 'Verify your HRMS account', html };
}

export function buildPasswordResetEmailHtml(resetToken: string) {
  const resetLink = `${FRONTEND_URL}/create-password?token=${resetToken}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
      <h2 style="color: #333;">Reset your password</h2>
      <p style="color: #555; line-height: 1.5;">
        We received a request to reset your HRMS account password. Click the button below to choose a new password.
      </p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${resetLink}" style="background-color: #000; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; display: inline-block;">
          Reset Password
        </a>
      </div>
      <p style="color: #555; font-size: 14px;">
        Or copy and paste this link into your browser:<br>
        <a href="${resetLink}" style="color: #0066cc;">${resetLink}</a>
      </p>
      <hr style="border: none; border-top: 1px solid #eaeaea; margin: 30px 0;">
      <p style="color: #888; font-size: 12px; text-align: center;">
        If you did not request a password reset, you can safely ignore this email.
      </p>
    </div>
  `;
  return { subject: 'Reset your HRMS password', html };
}

export function buildInviteEmailHtml(inviterName: string, verifyToken: string) {
  const verifyLink = `${FRONTEND_URL}/accept-invite?token=${verifyToken}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
      <h2 style="color: #333;">You've been invited!</h2>
      <p style="color: #555; line-height: 1.5;">
        <strong>${inviterName}</strong> has invited you to the HRMS client portal so you can post jobs and track hiring.
      </p>
      <p style="color: #555; line-height: 1.5;">
        Click the button below to verify your email and set your login password.
      </p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${verifyLink}" style="background-color: #000; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; display: inline-block;">
          Set password &amp; sign in
        </a>
      </div>
      <p style="color: #555; font-size: 14px;">
        Or copy and paste this link into your browser:<br>
        <a href="${verifyLink}" style="color: #0066cc;">${verifyLink}</a>
      </p>
    </div>
  `;
  return { subject: `Set up your HRMS client login (invite from ${inviterName})`, html };
}

export function buildPasswordOtpEmailHtml(otp: string) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
      <h2 style="color: #333;">Password change verification</h2>
      <p style="color: #555; line-height: 1.5;">
        Use this one-time code to confirm your password change. It expires in 10 minutes.
      </p>
      <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px; text-align: center; color: #111;">
        ${otp}
      </p>
      <p style="color: #888; font-size: 12px; text-align: center;">
        If you did not request this, ignore this email.
      </p>
    </div>
  `;
  return { subject: 'Your HRMS password change code', html };
}

export function buildCampaignEmailHtml(bodyHtml: string) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; border: 1px solid #eaeaea; border-radius: 8px;">
      <div style="color: #333; line-height: 1.6;">${bodyHtml}</div>
      <hr style="border: none; border-top: 1px solid #eaeaea; margin: 24px 0;">
      <p style="color: #888; font-size: 12px; text-align: center;">Sent via HRMS</p>
    </div>
  `;
}

/** @deprecated Use queue helpers in queue/email-service.ts */
export const sendVerificationEmail = async (toEmail: string, verifyToken: string) => {
  const { subject, html } = buildVerificationEmailHtml(verifyToken);
  return deliverRawEmail({ to: toEmail, subject, html, label: 'Verification email' });
};

/** @deprecated Use queue helpers in queue/email-service.ts */
export const sendPasswordResetEmail = async (toEmail: string, resetToken: string) => {
  const { subject, html } = buildPasswordResetEmailHtml(resetToken);
  return deliverRawEmail({ to: toEmail, subject, html, label: 'Password reset email' });
};

/** @deprecated Use queue helpers in queue/email-service.ts */
export const sendInviteEmail = async (toEmail: string, inviterName: string, verifyToken: string) => {
  const { subject, html } = buildInviteEmailHtml(inviterName, verifyToken);
  return deliverRawEmail({ to: toEmail, subject, html, label: 'Invite email' });
};

/** @deprecated Use queue helpers in queue/email-service.ts */
export const sendPasswordOtpEmail = async (toEmail: string, otp: string) => {
  const { subject, html } = buildPasswordOtpEmailHtml(otp);
  return deliverRawEmail({ to: toEmail, subject, html, label: 'Password change OTP' });
};
