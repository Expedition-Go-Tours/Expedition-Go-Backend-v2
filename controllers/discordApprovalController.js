/**
 * Discord approval actions — secure bridge between the Discord bot and the
 * existing admin approval flows.
 *
 * Endpoint: POST /api/webhooks/discord/approvals
 * Auth:     Authorization: Bearer <DISCORD_APPROVAL_SECRET>
 *
 * The handlers REUSE the existing admin controllers (adminFinanceController)
 * via a minimal req/res harness, so the behavior is identical to the admin
 * dashboard (same emails, notifications, audit log and booking state changes).
 * Nothing here duplicates finance logic.
 */

const crypto = require('crypto');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { approvePayoutRequest, rejectPayoutRequest } = require('./adminFinanceController');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Invoke an existing controller with a synthetic req/res/next and resolve
 * when it either calls res.status().json() (success) or next(err) (failure).
 */
function runController(controller, req) {
  return new Promise((resolve, reject) => {
    let done = false;
    const res = {
      status(code) {
        this.code = code;
        return this;
      },
      json(body) {
        if (!done) {
          done = true;
          resolve({ code: this.code || 200, body });
        }
        return this;
      },
    };
    const next = (err) => {
      if (!done) {
        done = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    Promise.resolve(controller(req, res, next)).catch((err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

exports.handleApproval = catchAsync(async (req, res, next) => {
  const secret = process.env.DISCORD_APPROVAL_SECRET;
  if (!secret) return next(new AppError('Discord approvals are not enabled', 503));

  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!provided || !safeEqual(provided, secret)) {
    return next(new AppError('Unauthorized', 401));
  }

  const { type, action, id, reason } = req.body || {};
  if (!type || !action || !id) return next(new AppError('type, action and id are required', 400));

  const adminId = process.env.DISCORD_APPROVAL_ADMIN_ID;
  if (!adminId) return next(new AppError('Discord approval admin is not configured', 503));

  if (type === 'payout') {
    const synthReq = {
      params: { id },
      user: { id: adminId },
      body: {},
    };
    if (action === 'approve') {
      await runController(approvePayoutRequest, synthReq);
    } else if (action === 'reject') {
      if (!reason) return next(new AppError('A rejection reason is required', 400));
      synthReq.body = { reason };
      await runController(rejectPayoutRequest, synthReq);
    } else {
      return next(new AppError('Unknown action for payout', 400));
    }
    return res.status(200).json({ status: 'success', data: { type, action, id } });
  }

  return next(new AppError('Unsupported approval type', 400));
});
