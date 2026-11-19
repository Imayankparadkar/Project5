/**
 * src/routes/reports.js
 * Monthly Finance & Cohort Points Audit Reporting Engine
 * 
 * Complies with Section 4.F of the Antigravity Technical Brief:
 * - Restricted to authorized roles ('admin', 'finance') — ordinary users receive 403 Forbidden.
 * - Enforces strict UTC calendar month boundaries: [startOfMonth, nextMonthStart).
 * - Aggregates only EARNED, CONVERTED, and EXPIRED types.
 * - Net points change formula: earned - converted - expired.
 * - Accurate terminology: reports 'walletCashCreditedINR' (never bank disbursed).
 * - Efficient cohort rollup and paginated user breakdown using index-covered aggregation.
 */

const express = require('express');
const router = express.Router();

const { getDb } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { validateReportParams } = require('../middleware/validate');

// ─── GET /api/reports/monthly-points ─────────────────────────────────────────
router.get(
  '/monthly-points',
  authenticate,
  requireRole('admin', 'finance'), // RBAC: Ordinary users receive 403 Forbidden
  validateReportParams,
  async (req, res) => {
    const { year, month, cohort, limit, page } = req.validatedReport;
    const db = getDb();

    // Strict UTC Month Boundaries: [startOfMonth, endOfMonth)
    const startOfMonth = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
    const endOfMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0));

    const matchStage = {
      createdAt: { $gte: startOfMonth, $lt: endOfMonth },
      type: { $in: ['EARNED', 'CONVERTED', 'EXPIRED'] }
    };

    if (cohort) {
      matchStage.cohort = cohort;
    }

    // 1. Cohort-Level Executive Rollup Pipeline (Efficient aggregation over matching range)
    const cohortPipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: '$cohort',
          totalPointsEarned: {
            $sum: { $cond: [{ $eq: ['$type', 'EARNED'] }, '$points', 0] }
          },
          totalPointsConverted: {
            $sum: { $cond: [{ $eq: ['$type', 'CONVERTED'] }, '$points', 0] }
          },
          totalPointsExpired: {
            $sum: { $cond: [{ $eq: ['$type', 'EXPIRED'] }, '$points', 0] }
          },
          totalWalletCashCreditedPaise: {
            $sum: { $cond: [{ $eq: ['$type', 'CONVERTED'] }, '$cashCreditedPaise', 0] }
          },
          uniqueUsersActive: { $addToSet: '$userId' }
        }
      },
      {
        $project: {
          _id: 0,
          cohort: '$_id',
          totalPointsEarned: 1,
          totalPointsConverted: 1,
          totalPointsExpired: 1,
          netPointsChange: {
            $subtract: [
              '$totalPointsEarned',
              { $add: ['$totalPointsConverted', '$totalPointsExpired'] }
            ]
          },
          walletCashCreditedINR: { $divide: ['$totalWalletCashCreditedPaise', 100] },
          activeUserCount: { $size: '$uniqueUsersActive' }
        }
      },
      { $sort: { cohort: 1 } }
    ];

    // 2. User-Level Breakdown with Pagination
    const skip = (page - 1) * limit;
    const userPipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: {
            userId: '$userId',
            cohort: '$cohort'
          },
          pointsEarned: {
            $sum: { $cond: [{ $eq: ['$type', 'EARNED'] }, '$points', 0] }
          },
          pointsConverted: {
            $sum: { $cond: [{ $eq: ['$type', 'CONVERTED'] }, '$points', 0] }
          },
          pointsExpired: {
            $sum: { $cond: [{ $eq: ['$type', 'EXPIRED'] }, '$points', 0] }
          },
          walletCashCreditedPaise: {
            $sum: { $cond: [{ $eq: ['$type', 'CONVERTED'] }, '$cashCreditedPaise', 0] }
          },
          transactionCount: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          userId: '$_id.userId',
          cohort: '$_id.cohort',
          pointsEarned: 1,
          pointsConverted: 1,
          pointsExpired: 1,
          netPointsChange: {
            $subtract: [
              '$pointsEarned',
              { $add: ['$pointsConverted', '$pointsExpired'] }
            ]
          },
          walletCashCreditedINR: { $divide: ['$walletCashCreditedPaise', 100] },
          transactionCount: 1
        }
      },
      { $sort: { cohort: 1, pointsConverted: -1 } },
      {
        $facet: {
          metadata: [{ $count: 'totalUsers' }],
          data: [{ $skip: skip }, { $limit: limit }]
        }
      }
    ];

    const [cohortSummary, userResults] = await Promise.all([
      db.collection('PointTransactions').aggregate(cohortPipeline).toArray(),
      db.collection('PointTransactions').aggregate(userPipeline).toArray()
    ]);

    const facetData = userResults[0] || { metadata: [], data: [] };
    const totalUsers = facetData.metadata[0] ? facetData.metadata[0].totalUsers : 0;
    const userBreakdown = facetData.data;

    return res.json({
      reportMonth: `${year}-${String(month).padStart(2, '0')}`,
      generatedAt: new Date(),
      pagination: {
        page,
        limit,
        totalUsers,
        totalPages: Math.ceil(totalUsers / limit) || 1
      },
      cohortSummary,
      userBreakdown
    });
  }
);

module.exports = router;
