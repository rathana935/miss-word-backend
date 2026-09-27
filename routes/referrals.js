import pool from "../db/pool.js";
import { requireAuth } from "../middleware/requireAuth.js";

const REQUIRED_COINS = 1000;
const REFERRAL_REWARD = 1000;

export function referralRoutes(app) {
  app.get(
    "/api/referrals",
    requireAuth,
    async (req, res) => {
      try {
        const result = await pool.query(
          `
          SELECT
            id,
            qualifying_coins,
            required_coins,
            reward_coins,
            rewarded,
            created_at
          FROM referrals
          WHERE referrer_id = $1
          ORDER BY created_at DESC
          `,
          [req.user.id]
        );

        const user = await pool.query(
          `
          SELECT
            referral_code,
            successful_referrals,
            referral_progress_coins
          FROM users
          WHERE id = $1
          `,
          [req.user.id]
        );

        const referralCode =
          user.rows[0]?.referral_code || "";

        const botUsername =
          process.env.BOT_USERNAME || "YourBot";

        const referralLink =
          `https://t.me/${botUsername}/app?startapp=ref_${referralCode}`;

        res.json({
          success: true,

          referralCode,
          referralLink,

          successfulReferrals:
            user.rows[0]?.successful_referrals || 0,

          progressCoins: Number(
            user.rows[0]?.referral_progress_coins || 0
          ),

          requiredCoins: REQUIRED_COINS,
          rewardCoins: REFERRAL_REWARD,

          referrals: result.rows
        });
      } catch (error) {
        console.error("Referrals:", error);

        res.status(500).json({
          success: false,
          message: "Unable to load referrals"
        });
      }
    }
  );
}
