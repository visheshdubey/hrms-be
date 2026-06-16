import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import path from 'path';
// Load environment variables
dotenv.config();
// Create reusable transporter object using the default SMTP transport
export const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const FROM_EMAIL = process.env.FROM_EMAIL || process.env.SMTP_USER || 'noreply@hrms.com';
/**
 * Sends a verification email to a newly registered user
 */
export const sendVerificationEmail = async (toEmail, verifyToken) => {
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
    try {
        const info = await transporter.sendMail({
            from: `"HRMS Team" <${FROM_EMAIL}>`,
            to: toEmail,
            subject: "Verify your HRMS account",
            html: html,
        });
        console.log(`Email sent: ${info.messageId}`);
        return true;
    }
    catch (error) {
        console.error("Error sending verification email:", error);
        return false;
    }
};
/**
 * Sends an invite email to a team member
 */
export const sendInviteEmail = async (toEmail, inviterName, verifyToken) => {
    const verifyLink = `${FRONTEND_URL}/accept-invite?token=${verifyToken}`;
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
      <h2 style="color: #333;">You've been invited!</h2>
      <p style="color: #555; line-height: 1.5;">
        <strong>${inviterName}</strong> has invited you to join their team on the HRMS platform.
      </p>
      <p style="color: #555; line-height: 1.5;">
        Click the button below to accept the invitation and set up your account.
      </p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${verifyLink}" style="background-color: #000; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; display: inline-block;">
          Accept Invitation
        </a>
      </div>
      <p style="color: #555; font-size: 14px;">
        Or copy and paste this link into your browser:<br>
        <a href="${verifyLink}" style="color: #0066cc;">${verifyLink}</a>
      </p>
    </div>
  `;
    try {
        const info = await transporter.sendMail({
            from: `"HRMS Team" <${FROM_EMAIL}>`,
            to: toEmail,
            subject: `Invitation from ${inviterName} to join HRMS`,
            html: html,
        });
        console.log(`Invite email sent: ${info.messageId}`);
        return true;
    }
    catch (error) {
        console.error("Error sending invite email:", error);
        return false;
    }
};
