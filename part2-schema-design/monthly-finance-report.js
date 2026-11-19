/**
 * PART 2.2: Monthly Finance Report Aggregation Pipeline
 * 
 * =========================================================================
 * 🇮🇳 [HINGLISH OVERVIEW FOR INTERVIEW]:
 * Finance team ko har mahine ek audit report chahiye:
 * "Kis user (aur user cohort) ne kitne points EARN kiye, kitne CONVERT kiye,
 * aur kitne EXPIRE hue, aur total kitna cash distribute hua?"
 * 
 * 40 Million documents par bina database choke kiye fast report banane ke 3 secret weapons:
 * 1. Zero-Join Architecture: User ka cohort (signup month) transaction doc mein hi denormalized hai (No $lookup on 40M users).
 * 2. Compound Index ({ cohort: 1, createdAt: 1, type: 1 }): $match stage poore collection scan (COLLSCAN) ko rokta hai.
 * 3. Single-Pass Grouping: $cond ke sath ek hi pass mein EARN, CONVERT, aur EXPIRE calculate hota hai.
 * =========================================================================
 */

function buildMonthlyFinanceReportPipeline(year, month, cohortFilter = null) {
  // [HINGLISH]:
  // Financial reporting mein date boundaries hamesha UTC mein strict banate hain.
  // E.g., Nov 2026 ke liye: 2026-11-01T00:00:00Z se 2026-12-01T00:00:00Z tak.
  // Isse time-zone drift ki wajah se koi transaction miss nahi hoti.
  const startOfMonth = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const endOfMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0)); // Agle mahine ki 1 tareekh

  const matchStage = {
    createdAt: {
      $gte: startOfMonth,
      $lt: endOfMonth
    }
  };

  // Agar finance team kisi specific cohort (e.g., '2026-09') ki report dekhna chahe
  if (cohortFilter) {
    matchStage.cohort = cohortFilter;
  }

  const pipeline = [
    // ---------------------------------------------------------------------
    // STAGE 1: $match (Index-Backed Date & Cohort Filter)
    // [HINGLISH]:
    // Pipeline ka sabse pehla stage hamesha $match hona chahiye!
    // Yeh stage humare compound index `{ cohort: 1, createdAt: 1, type: 1 }` ko use karta hai.
    // 40 Million documents ko scan karne ke bajaye, MongoDB index se sirf target month
    // ke matching documents ko memory mein lata hai (COLLSCAN completely avoided).
    // ---------------------------------------------------------------------
    {
      $match: matchStage
    },

    // ---------------------------------------------------------------------
    // STAGE 2: $group (User & Cohort Grouping with Conditional Sum)
    // [HINGLISH - SABSE POWERFUL STAGE]:
    // 1. Grouping Key: `_id: { userId: "$userId", cohort: "$cohort" }`.
    //    Kyunki cohort transaction mein pehle se maujood hai, humein Users table par
    //    $lookup (SQL JOIN) karne ki zaroorat nahi padti!
    // 2. Conditional $sum with $cond:
    //    Teen alag-alag queries chalane ke bajaye, ek hi scan mein:
    //    - Agar type === 'EARNED' hai, toh points add karo, warna 0.
    //    - Agar type === 'CONVERTED' hai, toh points add karo, warna 0.
    //    - Agar type === 'EXPIRED' hai, toh points add karo, warna 0.
    //    - cashDisbursedPaise: Total kitna wallet cash convert hua (audit verification ke liye).
    // ---------------------------------------------------------------------
    {
      $group: {
        _id: {
          userId: "$userId",
          cohort: "$cohort"
        },
        // Earned points ka sum
        pointsEarned: {
          $sum: {
            $cond: [{ $eq: ["$type", "EARNED"] }, "$points", 0]
          }
        },
        // Converted points ka sum
        pointsConverted: {
          $sum: {
            $cond: [{ $eq: ["$type", "CONVERTED"] }, "$points", 0]
          }
        },
        // Expired points ka sum
        pointsExpired: {
          $sum: {
            $cond: [{ $eq: ["$type", "EXPIRED"] }, "$points", 0]
          }
        },
        // Financial audit: Total kitna paisa wallets mein credit hua (paise mein)
        cashDisbursedPaise: {
          $sum: {
            $cond: [{ $eq: ["$type", "CONVERTED"] }, "$cashCreditedPaise", 0]
          }
        },
        transactionCount: { $sum: 1 }
      }
    },

    // ---------------------------------------------------------------------
    // STAGE 3: $project (Output Formatting & Net Change Calculation)
    // [HINGLISH]:
    // Finance team ko clean tabular data dene ke liye document ko flatten karte hain:
    // 1. `_id` ko todkar clean `userId` aur `cohort` banate hain.
    // 2. Net points change calculate karte hain:
    //    netPointsChange = pointsEarned - (pointsConverted + pointsExpired)
    // 3. Paise ko INR mein convert karte hain (/ 100) taaki finance human-readable dekh sake.
    // ---------------------------------------------------------------------
    {
      $project: {
        _id: 0,
        userId: "$_id.userId",
        cohort: "$_id.cohort",
        pointsEarned: 1,
        pointsConverted: 1,
        pointsExpired: 1,
        netPointsChange: {
          $subtract: [
            "$pointsEarned",
            { $add: ["$pointsConverted", "$pointsExpired"] }
          ]
        },
        cashDisbursedInInr: {
          $divide: ["$cashDisbursedPaise", 100] // Paise to INR conversion (e.g., 2000 paise = ₹20.00)
        },
        transactionCount: 1
      }
    },

    // ---------------------------------------------------------------------
    // STAGE 4: $sort (Deterministic Sorting)
    // [HINGLISH]:
    // Report ko pehle cohort ke hisaab se ascending arrange karte hain,
    // aur har cohort ke andar jinhone sabse zyada convert kiya unhe top par rakhte hain.
    // ---------------------------------------------------------------------
    {
      $sort: {
        cohort: 1,
        pointsConverted: -1
      }
    }
  ];

  return pipeline;
}

/**
 * =========================================================================
 * 📈 COMPLEMENTARY PIPELINE: COHORT-LEVEL EXECUTIVE ROLLUP
 * =========================================================================
 * [HINGLISH]:
 * Finance CFO ya Leadership ko agar individual user ke bajaye
 * pure cohort ka high-level summary chahiye (e.g. "Sept 2026 cohort ne total kitne points burn kiye?"),
 * toh yeh rollup pipeline kaam aati hai.
 */
function buildCohortSummaryPipeline(year, month) {
  const startOfMonth = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const endOfMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0));

  return [
    // 1. Month filter (Index backed)
    {
      $match: {
        createdAt: { $gte: startOfMonth, $lt: endOfMonth }
      }
    },
    // 2. Group by Cohort directly
    {
      $group: {
        _id: "$cohort",
        totalPointsEarned: {
          $sum: { $cond: [{ $eq: ["$type", "EARNED"] }, "$points", 0] }
        },
        totalPointsConverted: {
          $sum: { $cond: [{ $eq: ["$type", "CONVERTED"] }, "$points", 0] }
        },
        totalPointsExpired: {
          $sum: { $cond: [{ $eq: ["$type", "EXPIRED"] }, "$points", 0] }
        },
        totalCashDisbursedPaise: {
          $sum: { $cond: [{ $eq: ["$type", "CONVERTED"] }, "$cashCreditedPaise", 0] }
        },
        // Count unique active users in this cohort during the month
        uniqueUsersActive: { $addToSet: "$userId" }
      }
    },
    // 3. Project executive summary
    {
      $project: {
        _id: 0,
        cohort: "$_id",
        totalPointsEarned: 1,
        totalPointsConverted: 1,
        totalPointsExpired: 1,
        totalCashDisbursedINR: { $divide: ["$totalCashDisbursedPaise", 100] },
        activeUserCount: { $size: "$uniqueUsersActive" }
      }
    },
    { $sort: { cohort: 1 } }
  ];
}

module.exports = {
  buildMonthlyFinanceReportPipeline,
  buildCohortSummaryPipeline
};
