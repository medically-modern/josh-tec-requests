'use strict';

// Pluggable outbound email.
// Priority: RESEND_API_KEY (Resend HTTP API) -> SMTP_HOST (nodemailer) -> 'manual'
// In manual mode nothing is sent automatically; the admin dashboard gets a
// prefilled mailto: link instead, so notifications still go out with one click.

const EMAIL_FROM = process.env.EMAIL_FROM || 'Medically Modern Service Desk <onboarding@resend.dev>';

function emailMode() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST) return 'smtp';
  return 'manual';
}

async function sendViaResend({ to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function sendViaSmtp({ to, subject, text, html }) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  await transporter.sendMail({ from: EMAIL_FROM, to, subject, text, html });
}

function mailtoLink({ to, subject, text }) {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

// Attempts delivery. Never throws; returns a result object describing what happened.
async function sendEmail(message) {
  const mode = emailMode();
  const mailto = mailtoLink(message);
  if (mode === 'manual') {
    return { mode, sent: false, mailto };
  }
  try {
    if (mode === 'resend') await sendViaResend(message);
    else await sendViaSmtp(message);
    return { mode, sent: true, mailto };
  } catch (err) {
    console.error(`Email send failed (${mode}):`, err.message);
    return { mode, sent: false, error: err.message, mailto };
  }
}

const SEVERITY_LABELS = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const TYPE_LABELS = { issue: 'Issue report', change_request: 'Change request' };

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

function trackUrl(ticket) {
  const base = baseUrl();
  return base ? `${base}/status.html?ticket=${encodeURIComponent(ticket)}` : '';
}

function wrapHtml(inner) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;">
    <div style="background:#0f766e;color:#ffffff;padding:18px 24px;font-size:16px;font-weight:600;">Medically Modern &middot; Service Desk</div>
    <div style="padding:24px;font-size:14px;line-height:1.6;">${inner}</div>
    <div style="padding:14px 24px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;">This is an automated message from the Medically Modern Service Desk.</div>
  </div></body></html>`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function receiptEmail(req) {
  const track = trackUrl(req.ticket);
  const subject = `[${req.ticket}] We received your ${req.type === 'issue' ? 'issue report' : 'change request'}: ${req.title}`;
  const text = [
    `Hi ${req.submitter_name},`,
    '',
    `Thanks — your ${TYPE_LABELS[req.type].toLowerCase()} has been received and logged as ticket ${req.ticket}.`,
    '',
    `Service:  ${req.service_name}`,
    `Type:     ${TYPE_LABELS[req.type]}`,
    `Severity: ${SEVERITY_LABELS[req.severity]}`,
    `Title:    ${req.title}`,
    '',
    track ? `Track its status any time: ${track}` : '',
    '',
    'You will get another email when it has been completed.',
    '',
    '— Medically Modern Service Desk',
  ].filter((l) => l !== null).join('\n');
  const html = wrapHtml(`
    <p>Hi ${esc(req.submitter_name)},</p>
    <p>Thanks — your ${esc(TYPE_LABELS[req.type].toLowerCase())} has been received and logged as ticket <strong>${esc(req.ticket)}</strong>.</p>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:4px 16px 4px 0;color:#64748b;">Service</td><td>${esc(req.service_name)}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#64748b;">Type</td><td>${esc(TYPE_LABELS[req.type])}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#64748b;">Severity</td><td>${esc(SEVERITY_LABELS[req.severity])}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#64748b;">Title</td><td>${esc(req.title)}</td></tr>
    </table>
    ${track ? `<p><a href="${esc(track)}" style="color:#0f766e;">Track this ticket &rarr;</a></p>` : ''}
    <p>You will get another email when it has been completed.</p>`);
  return { to: req.submitter_email, subject, text, html };
}

function completionEmail(req) {
  const track = trackUrl(req.ticket);
  const subject = `[${req.ticket}] Completed: ${req.title}`;
  const text = [
    `Hi ${req.submitter_name},`,
    '',
    `Good news — your ${TYPE_LABELS[req.type].toLowerCase()} for ${req.service_name} has been completed.`,
    '',
    `Ticket:  ${req.ticket}`,
    `Title:   ${req.title}`,
    req.resolution_note ? `\nResolution notes:\n${req.resolution_note}` : '',
    '',
    'If the problem persists or this does not look right, just submit a new request and reference this ticket number.',
    '',
    '— Medically Modern Service Desk',
  ].join('\n');
  const html = wrapHtml(`
    <p>Hi ${esc(req.submitter_name)},</p>
    <p>Good news — your ${esc(TYPE_LABELS[req.type].toLowerCase())} for <strong>${esc(req.service_name)}</strong> has been marked <strong style="color:#15803d;">completed</strong>.</p>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:4px 16px 4px 0;color:#64748b;">Ticket</td><td>${esc(req.ticket)}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#64748b;">Title</td><td>${esc(req.title)}</td></tr>
    </table>
    ${req.resolution_note ? `<p style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;"><strong>Resolution notes:</strong><br>${esc(req.resolution_note).replace(/\n/g, '<br>')}</p>` : ''}
    ${track ? `<p><a href="${esc(track)}" style="color:#0f766e;">View this ticket &rarr;</a></p>` : ''}
    <p>If the problem persists or this does not look right, just submit a new request and reference this ticket number.</p>`);
  return { to: req.submitter_email, subject, text, html };
}

const SEV_ICON = { critical: '\u{1F534}', high: '\u{1F7E0}', medium: '\u{1F7E1}', low: '⚪' };

// At-a-glance alert to the admin for every new submission.
// Subject: 🔴 Critical Issue · Patient Portal — “Calendar won't load” · Sarah (MM-1042)
function adminNewRequestEmail(req, adminEmail) {
  const base = baseUrl();
  const icon = SEV_ICON[req.severity] || '';
  const typeWord = req.type === 'issue' ? 'Issue' : 'Change';
  const subject = `${icon} ${SEVERITY_LABELS[req.severity]} ${typeWord} · ${req.service_name} — “${req.title}” · ${req.submitter_name} (${req.ticket})`;
  const adminLink = base ? `${base}/admin.html?req=${encodeURIComponent(req.id)}` : '';
  const shots = (req.screenshots || []).length;
  const links = (req.video_links || []).length;
  const text = [
    `New ${TYPE_LABELS[req.type].toLowerCase()} — ${req.ticket}`,
    '',
    `Service:     ${req.service_name}`,
    `Severity:    ${SEVERITY_LABELS[req.severity]}`,
    `From:        ${req.submitter_name} <${req.submitter_email}>`,
    `Attachments: ${shots} screenshot(s), ${links} video link(s)`,
    '',
    'Description:',
    req.description,
    req.steps ? `\nSteps to reproduce:\n${req.steps}` : '',
    (req.video_links || []).length ? `\nVideo links:\n${req.video_links.join('\n')}` : '',
    adminLink ? `\nOpen in dashboard: ${adminLink}` : '',
  ].join('\n');
  const html = wrapHtml(`
    <p style="margin-top:0"><strong>${esc(icon)} New ${esc(TYPE_LABELS[req.type].toLowerCase())}</strong> &middot; <span style="font-family:monospace">${esc(req.ticket)}</span></p>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:4px 16px 4px 0;color:#64748b;">Service</td><td>${esc(req.service_name)}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#64748b;">Severity</td><td>${esc(SEVERITY_LABELS[req.severity])}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#64748b;">Title</td><td><strong>${esc(req.title)}</strong></td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#64748b;">From</td><td>${esc(req.submitter_name)} &lt;${esc(req.submitter_email)}&gt;</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#64748b;">Attachments</td><td>${shots} screenshot(s), ${links} video link(s)</td></tr>
    </table>
    <p style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;white-space:pre-wrap;">${esc(req.description)}</p>
    ${req.steps ? `<p style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;white-space:pre-wrap;"><strong>Steps:</strong>\n${esc(req.steps)}</p>` : ''}
    ${(req.video_links || []).map((l) => `<div><a href="${esc(l)}">${esc(l)}</a></div>`).join('')}
    ${adminLink ? `<p><a href="${esc(adminLink)}" style="color:#0f766e;font-weight:600;">Open in dashboard &rarr;</a></p>` : ''}`);
  return { to: adminEmail, subject, text, html };
}

module.exports = { emailMode, sendEmail, receiptEmail, completionEmail, adminNewRequestEmail };
