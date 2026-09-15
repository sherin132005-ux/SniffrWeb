import express from 'express';
import { authenticateAccess } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import config from '../config.js';
import db from '../db/connection.js';
import { approveManualPayment, rejectManualPayment } from '../services/subscriptionService.js';
import { sendServerError } from '../utils/errors.js';

const router = express.Router();
router.use(rateLimiter(config.RATE_LIMIT.POST));

router.get(
  '/payments/pending',
  authenticateAccess,
  requireAdmin,
  async (req, res) => {
    try {
      const payments = await db.all(`
        SELECT
          ps.id,
          ps.user_id,
          ps.plan,
          ps.amount,
          ps.payment_method,
          ps.upi_transaction_id,
          ps.proof_url,
          ps.submitted_at,
          u.email,
          u.username,
          u.full_name
        FROM payment_sessions ps
        JOIN users u ON u.id = ps.user_id
        WHERE ps.status = 'pending_review'
          AND ps.provider = 'upi_manual'
        ORDER BY ps.submitted_at ASC
      `);

      res.json({ payments });
    } catch (err) {
      sendServerError(res, err);
    }
  }
);

// POST /api/admin/payments/:sessionId/approve — approves a pending-review
// manual UPI payment and activates the session's stored plan for its
// stored user. Reads sessionId from the URL only; everything else (plan,
// amount, user, reviewer) comes from the payment_sessions row itself or
// from req.user.id (the authenticated admin) -- nothing here is trusted
// from the request body.
router.post(
  '/payments/:sessionId/approve',
  authenticateAccess,
  requireAdmin,
  async (req, res) => {
    try {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (isNaN(sessionId)) return res.status(400).json({ error: 'INVALID_SESSION_ID' });

      const io = req.app.get('io');
      const result = await approveManualPayment(sessionId, req.user.id, io);

      if (!result.success) {
        if (result.reason === 'SESSION_NOT_FOUND') {
          return res.status(404).json({ error: result.reason });
        }
        return res.status(409).json({ error: result.reason });
      }

      res.json({ success: true, sessionId, userId: result.user.id, plan: result.user.current_plan });
    } catch (err) {
      sendServerError(res, err);
    }
  }
);

// POST /api/admin/payments/:sessionId/reject — rejects a pending-review
// manual UPI payment. Reads sessionId from the URL and rejectionReason
// from the body -- the only field this route reads from req.body.
// reviewed_by comes only from req.user.id (the authenticated admin).
router.post(
  '/payments/:sessionId/reject',
  authenticateAccess,
  requireAdmin,
  async (req, res) => {
    try {
      const sessionId = parseInt(req.params.sessionId, 10);
      if (isNaN(sessionId)) return res.status(400).json({ error: 'INVALID_SESSION_ID' });

      const { rejectionReason } = req.body;
      const io = req.app.get('io');
      const result = await rejectManualPayment(sessionId, req.user.id, rejectionReason, io);

      if (!result.success) {
        if (result.reason === 'SESSION_NOT_FOUND') {
          return res.status(404).json({ error: result.reason });
        }
        if (result.reason === 'REJECTION_REASON_REQUIRED' || result.reason === 'REJECTION_REASON_TOO_LONG') {
          return res.status(400).json({ error: result.reason });
        }
        return res.status(409).json({ error: result.reason });
      }

      res.json({ success: true, sessionId: result.sessionId, rejection_reason: result.rejection_reason });
    } catch (err) {
      sendServerError(res, err);
    }
  }
);

export default router;