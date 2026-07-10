import {
  buildCampaignEmailHtml,
  buildInviteEmailHtml,
  buildPasswordOtpEmailHtml,
  buildPasswordResetEmailHtml,
  buildVerificationEmailHtml,
} from '../utils/email.js';
import { enqueueEmailTask } from './email-queue.js';
import type { EnqueueResult } from './types.js';

export async function queueVerificationEmail(toEmail: string, verifyToken: string): Promise<EnqueueResult> {
  const { subject, html } = buildVerificationEmailHtml(verifyToken);
  return enqueueEmailTask({
    type: 'verification',
    to: toEmail,
    subject,
    html,
    metadata: { verifyToken },
  });
}

export async function queuePasswordResetEmail(toEmail: string, resetToken: string): Promise<EnqueueResult> {
  const { subject, html } = buildPasswordResetEmailHtml(resetToken);
  return enqueueEmailTask({
    type: 'password_reset',
    to: toEmail,
    subject,
    html,
    metadata: { resetToken },
  });
}

export async function queueInviteEmail(
  toEmail: string,
  inviterName: string,
  verifyToken: string,
): Promise<EnqueueResult> {
  const { subject, html } = buildInviteEmailHtml(inviterName, verifyToken);
  return enqueueEmailTask({
    type: 'invite',
    to: toEmail,
    subject,
    html,
    metadata: { inviterName, verifyToken },
  });
}

export async function queuePasswordOtpEmail(toEmail: string, otp: string): Promise<EnqueueResult> {
  const { subject, html } = buildPasswordOtpEmailHtml(otp);
  return enqueueEmailTask({
    type: 'password_otp',
    to: toEmail,
    subject,
    html,
    metadata: { otp },
  });
}

export async function queueCampaignEmail(input: {
  to: string;
  subject: string;
  html: string;
  batchId: string;
  campaignId: number;
  recipientName?: string;
}): Promise<EnqueueResult> {
  return enqueueEmailTask({
    type: 'campaign',
    to: input.to,
    subject: input.subject,
    html: input.html,
    batchId: input.batchId,
    metadata: {
      campaignId: input.campaignId,
      recipientName: input.recipientName,
    },
  });
}

export function personalizeCampaignBody(template: string, recipientName?: string): string {
  const greeting = recipientName?.trim() ? `Hi ${recipientName.trim()},` : 'Hello,';
  if (template.includes('{{greeting}}')) {
    return template.replaceAll('{{greeting}}', greeting);
  }
  return `${greeting}<br/><br/>${template}`;
}

export function wrapCampaignHtml(bodyHtml: string): string {
  return buildCampaignEmailHtml(bodyHtml);
}
