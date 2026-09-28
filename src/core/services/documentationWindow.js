/**
 * 30-day documentation window reminders — reminders ONLY, never enforcement.
 *
 * The window starts the moment the enforced document set is on file (the
 * account goes live); the supplier then has 30 days to provide the remaining
 * documents from their dashboard. This daily sweep nudges them at T-7, T-3 and
 * on the final day. It never changes status, hides listings or blocks anything
 * — the deadline is a commitment, not a cudgel, and the countdown/overdue
 * banners in the dashboard are the only other face of it.
 *
 * Idempotent: a sent reminder is recorded as a VerificationEvent
 * (DOCUMENTATION_WINDOW_REMINDER_7 / _3 / _0) before it is counted, so the
 * at-least-once delivery of the daily BullMQ job can never double-notify a
 * supplier.
 */

const prisma = require('./prismaClient');
const { sendEmail, resolveEmailBrand } = require('./emailService');
const { enqueueNotification } = require('./queue');
const { requirementsFor } = require('./supplierVerificationRequirements');
const logger = require('./logger');

const ACTIVE_LIKE = ['ACTIVE', 'APPROVED'];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Reminder points measured against `documentationDeadline` (UTC calendar days). */
const REMINDER_LEVELS = [
  { daysLeft: 7, action: 'DOCUMENTATION_WINDOW_REMINDER_7' },
  { daysLeft: 3, action: 'DOCUMENTATION_WINDOW_REMINDER_3' },
  { daysLeft: 0, action: 'DOCUMENTATION_WINDOW_REMINDER_0' },
];

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Whole UTC calendar days from `now` to `date` (0 = the same day). */
function daysUntil(date, now) {
  return Math.round(
    (startOfUtcDay(date).getTime() - startOfUtcDay(now).getTime()) / MS_PER_DAY
  );
}

function reminderMessages(daysLeft, deadlineLabel) {
  if (daysLeft === 0) {
    return {
      title: 'Your documentation window closes today',
      message:
        'Today is the final day of your 30-day window to provide the remaining documents on your dashboard. Upload them now to stay fully verified.',
    };
  }
  return {
    title: `${daysLeft} days left to complete your documentation`,
    message: `You have ${daysLeft} days left (until ${deadlineLabel}) to provide the remaining documents on your dashboard. Upload them to stay fully verified.`,
  };
}

/**
 * How many required documents are still missing. Only suppliers with an
 * outstanding document are reminded — the window is a promise about the
 * *remaining* documents, and a supplier who has provided everything should
 * never be nudged.
 *
 * Covers the supplier-level "later" set plus per-vehicle / per-guide
 * documents, since both are part of what the 30-day window asks for.
 */
async function outstandingDocumentCount(profile) {
  const requirements = requirementsFor({
    supplierChoice: profile.businessInfo?.supplierChoice,
    supplierType: profile.supplierType,
    businessType: profile.businessInfo?.businessType,
    services: profile.operatingInfo?.services,
    country: profile.businessInfo?.country,
  });

  const approved = await prisma.supplierDocument.findMany({
    where: { supplierId: profile.id, status: 'APPROVED' },
    select: { ownerType: true, ownerId: true, type: true },
  });

  let outstanding = 0;

  // Supplier-level "later" documents (the enforced set is already on file —
  // that is what started the window).
  for (const doc of requirements.documents) {
    if (doc.timing === 'upfront') continue;
    const has = approved.some(
      (a) => a.ownerType === 'SUPPLIER' && a.type === doc.type
    );
    if (!has) outstanding += 1;
  }

  // Per-entity documents (vehicles / guides the operator already added).
  if (requirements.vehicles !== 'hidden' || requirements.guides !== 'hidden') {
    const [vehicles, guides] = await Promise.all([
      prisma.vehicle.findMany({ where: { supplierId: profile.id }, select: { id: true } }),
      prisma.guide.findMany({ where: { supplierId: profile.id }, select: { id: true } }),
    ]);

    if (requirements.vehicles !== 'hidden') {
      for (const vehicle of vehicles) {
        for (const vd of requirements.vehicleDocuments) {
          const has = approved.some(
            (a) => a.ownerType === 'VEHICLE' && a.ownerId === vehicle.id && a.type === vd.type
          );
          if (!has) outstanding += 1;
        }
      }
    }

    if (requirements.guides !== 'hidden') {
      for (const guide of guides) {
        for (const gd of requirements.guideDocuments) {
          const has = approved.some(
            (a) => a.ownerType === 'GUIDE' && a.ownerId === guide.id && a.type === gd.type
          );
          if (!has) outstanding += 1;
        }
      }
    }
  }

  return outstanding;
}

async function sendReminder({ user, profile, daysLeft, outstanding }) {
  const deadlineLabel = new Date(profile.documentationDeadline).toISOString().slice(0, 10);
  const { title, message } = reminderMessages(daysLeft, deadlineLabel);

  await sendEmail({
    to: user.email,
    subject: daysLeft === 0 ? 'Last day to complete your documents' : `Reminder: ${daysLeft} days left to complete your documents`,
    template: 'generic-notification',
    opts: { brandKey: resolveEmailBrand({ user }) },
    data: {
      header: title,
      message,
      userName: user.name,
      deadline: deadlineLabel,
    },
  }).catch((err) => logger.warn('[documentationWindow] reminder email failed:', err?.message));

  await enqueueNotification({
    userId: user.id,
    type: 'DOCUMENTATION_WINDOW_REMINDER',
    title,
    message,
    data: {
      supplierId: profile.id,
      daysLeft,
      documentationDeadline: profile.documentationDeadline,
      outstandingDocuments: outstanding,
    },
  }).catch(() => {});
}

/**
 * Daily sweep — the scheduled entry point (see SCHEDULES in queue.js).
 * Accepts `now` for deterministic testing; production callers omit it.
 */
async function planDocumentationWindowReminders(now = new Date()) {
  const suppliers = await prisma.supplierProfile.findMany({
    where: {
      documentationDeadline: { not: null },
      status: { in: ACTIVE_LIKE },
    },
    select: {
      id: true,
      userId: true,
      status: true,
      documentationDeadline: true,
      supplierType: true,
      businessInfo: true,
      operatingInfo: true,
    },
  });

  let remindersSent = 0;

  for (const profile of suppliers) {
    const daysLeft = daysUntil(new Date(profile.documentationDeadline), now);
    const level = REMINDER_LEVELS.find((l) => l.daysLeft === daysLeft);
    if (!level) continue;

    // Nothing outstanding → nothing to remind about.
    const outstanding = await outstandingDocumentCount(profile);
    if (outstanding === 0) continue;

    // Idempotency sentinel — one reminder per supplier per level, ever.
    const alreadySent = await prisma.verificationEvent.findFirst({
      where: { supplierId: profile.id, entityId: profile.id, action: level.action },
    });
    if (alreadySent) continue;

    const user = await prisma.user.findUnique({ where: { id: profile.userId } });
    if (!user) continue;

    await sendReminder({ user, profile, daysLeft, outstanding });

    await prisma.verificationEvent.create({
      data: {
        supplierId: profile.id,
        entityType: 'SUPPLIER',
        entityId: profile.id,
        action: level.action,
        actorId: 'SYSTEM',
        note: daysLeft === 0
          ? 'Reminder: final day of the 30-day documentation window'
          : `Reminder: ${daysLeft} days left in the 30-day documentation window`,
      },
    });
    remindersSent += 1;
  }

  return { remindersSent };
}

module.exports = {
  ACTIVE_LIKE,
  REMINDER_LEVELS,
  daysUntil,
  planDocumentationWindowReminders,
};