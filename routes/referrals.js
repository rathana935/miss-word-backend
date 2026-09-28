import pool from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const REQUIRED_COINS = 1000;
const REFERRAL_REWARD = 1000;

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

/**
 * Build the Telegram Mini App referral URL.
 */
function buildReferralLink(referralCode) {
  const botUsername = String(
    process.env.BOT_USERNAME || ""
  )
    .trim()
    .replace(/^@/, "");

  if (!botUsername || !referralCode) {
    return "";
  }

  return `https://t.me/${botUsername}/app?startapp=ref_${encodeURIComponent(
    referralCode
  )}`;
}


/**
 * Update referral progress when an invited user
 * earns qualifying coins.
 *
 * IMPORTANT:
 * This function must be called INSIDE the same PostgreSQL
 * transaction that awards the qualifying coins.
 *
 * Example:
 *
 * await processReferralProgress(
 *   client,
 *   referredUserId,
 *   10
 * );
 *
 * This prevents referral progress from becoming different
 * from the user's actual coin transaction.
 */
export async function processReferralProgress(
  client,
  referredUserId,
  earnedCoins
) {
  const amount = Number(earnedCoins);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return {
      rewarded: false,
      progressCoins: 0
    };
  }

  /*
   * Lock the referral row.
   *
   * A user can only have one referral because the database
   * schema has a unique constraint on referred_user_id.
   */
  const referralResult = await client.query(
    `
    SELECT
      id,
      referrer_id,
      referred_user_id,
      qualifying_coins,
      required_coins,
      reward_coins,
      rewarded
    FROM referrals
    WHERE referred_user_id = $1
    FOR UPDATE
    `,
    [referredUserId]
  );

  if (!referralResult.rows.length) {
    return {
      rewarded: false,
      progressCoins: 0
    };
  }

  const referral =
    referralResult.rows[0];

  /*
   * Already rewarded.
   */
  if (referral.rewarded) {
    return {
      rewarded: false,
      alreadyRewarded: true,
      progressCoins: Number(
        referral.qualifying_coins || 0
      )
    };
  }

  const currentProgress = Number(
    referral.qualifying_coins || 0
  );

  const requiredCoins = Number(
    referral.required_coins ||
      REQUIRED_COINS
  );

  const rewardCoins = Number(
    referral.reward_coins ||
      REFERRAL_REWARD
  );

  /*
   * Never allow progress to exceed the requirement.
   */
  const newProgress = Math.min(
    requiredCoins,
    currentProgress + amount
  );

  /*
   * Update referral progress.
   */
  await client.query(
    `
    UPDATE referrals
    SET
      qualifying_coins = $2,
      rewarded =
        CASE
          WHEN $2 >= required_coins
          THEN TRUE
          ELSE rewarded
        END
    WHERE id = $1
    `,
    [
      referral.id,
      newProgress
    ]
  );

  /*
   * Not qualified yet.
   */
  if (newProgress < requiredCoins) {
    await client.query(
      `
      UPDATE users
      SET referral_progress_coins = $2
      WHERE id = $1
      `,
      [
        referredUserId,
        newProgress
      ]
    );

    return {
      rewarded: false,
      progressCoins: newProgress
    };
  }

  /*
   * Referral has qualified.
   *
   * The referrer receives the reward.
   */
  const referrerResult = await client.query(
    `
    UPDATE users
    SET
      coins = coins + $2,
      successful_referrals =
        successful_referrals + 1
    WHERE id = $1
    RETURNING
      id,
      coins,
      successful_referrals
    `,
    [
      referral.referrer_id,
      rewardCoins
    ]
  );

  if (!referrerResult.rows.length) {
    throw new Error(
      "Referral referrer user not found"
    );
  }

  const referrer =
    referrerResult.rows[0];

  /*
   * Record the referral coin reward.
   */
  await client.query(
    `
    INSERT INTO coin_transactions (
      user_id,
      amount,
      balance_after,
      type,
      reference_id,
      description
    )
    VALUES (
      $1,
      $2,
      $3,
      'referral_reward',
      $4,
      'Referral reward'
    )
    `,
    [
      referral.referrer_id,
      rewardCoins,
      referrer.coins,
      String(referral.id)
    ]
  );

  /*
   * Store final referral state.
   */
  await client.query(
    `
    UPDATE referrals
    SET
      qualifying_coins = $2,
      rewarded = TRUE
    WHERE id = $1
    `,
    [
      referral.id,
      requiredCoins
    ]
  );

  /*
   * The invited user's progress is also stored in users
   * so the frontend can display it quickly.
   */
  await client.query(
    `
    UPDATE users
    SET referral_progress_coins = $2
    WHERE id = $1
    `,
    [
      referredUserId,
      requiredCoins
    ]
  );

  return {
    rewarded: true,
    rewardCoins,
    progressCoins: requiredCoins,
    referrerId: referral.referrer_id
  };
}


/*
|--------------------------------------------------------------------------
| ROUTES
|--------------------------------------------------------------------------
*/

export function referralRoutes(app) {

  /*
  |--------------------------------------------------------------------------
  | GET REFERRAL INFORMATION
  |--------------------------------------------------------------------------
  */

  app.get(
    "/api/referrals",
    requireAuth,
    async (req, res) => {
      try {
        /*
         * Get current user's referral information.
         */
        const userResult = await pool.query(
          `
          SELECT
            referral_code,
            successful_referrals,
            referral_progress_coins
          FROM users
          WHERE id = $1
          LIMIT 1
          `,
          [req.userId]
        );

        if (!userResult.rows.length) {
          return res.status(404).json({
            success: false,
            message: "User not found"
          });
        }

        const user =
          userResult.rows[0];

        /*
         * Get invited users/referrals.
         */
        const referralResult =
          await pool.query(
            `
            SELECT
              r.id,

              r.qualifying_coins,
              r.required_coins,
              r.reward_coins,

              r.rewarded,
              r.created_at,

              u.username,
              u.first_name,
              u.last_name
            FROM referrals r

            LEFT JOIN users u
              ON u.id = r.referred_user_id

            WHERE r.referrer_id = $1

            ORDER BY r.created_at DESC
            `,
            [req.userId]
          );

        const referralCode =
          user.referral_code || "";

        const referralLink =
          buildReferralLink(
            referralCode
          );

        return res.json({
          success: true,

          referralCode,

          referralLink,

          successfulReferrals:
            Number(
              user.successful_referrals || 0
            ),

          progressCoins:
            Number(
              user.referral_progress_coins ||
                0
            ),

          requiredCoins:
            REQUIRED_COINS,

          rewardCoins:
            REFERRAL_REWARD,

          referrals:
            referralResult.rows.map(
              (referral) => ({
                id: referral.id,

                qualifyingCoins:
                  Number(
                    referral.qualifying_coins ||
                      0
                  ),

                requiredCoins:
                  Number(
                    referral.required_coins ||
                      REQUIRED_COINS
                  ),

                rewardCoins:
                  Number(
                    referral.reward_coins ||
                      REFERRAL_REWARD
                  ),

                rewarded:
                  Boolean(
                    referral.rewarded
                  ),

                createdAt:
                  referral.created_at,

                user: {
                  username:
                    referral.username ||
                    null,

                  firstName:
                    referral.first_name ||
                    null,

                  lastName:
                    referral.last_name ||
                    null
                }
              })
            )
        });

      } catch (error) {
        console.error(
          "Referral load error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to load referrals"
        });
      }
    }
  );


  /*
  |--------------------------------------------------------------------------
  | GET REFERRAL SUMMARY
  |--------------------------------------------------------------------------
  |
  | A smaller endpoint useful for the dashboard.
  |
  */

  app.get(
    "/api/referrals/summary",
    requireAuth,
    async (req, res) => {
      try {
        const result = await pool.query(
          `
          SELECT
            referral_code,
            successful_referrals,
            referral_progress_coins
          FROM users
          WHERE id = $1
          LIMIT 1
          `,
          [req.userId]
        );

        if (!result.rows.length) {
          return res.status(404).json({
            success: false,
            message: "User not found"
          });
        }

        const user =
          result.rows[0];

        return res.json({
          success: true,

          referralCode:
            user.referral_code || "",

          referralLink:
            buildReferralLink(
              user.referral_code
            ),

          successfulReferrals:
            Number(
              user.successful_referrals || 0
            ),

          progressCoins:
            Number(
              user.referral_progress_coins ||
                0
            ),

          requiredCoins:
            REQUIRED_COINS,

          rewardCoins:
            REFERRAL_REWARD
        });

      } catch (error) {
        console.error(
          "Referral summary error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to load referral summary"
        });
      }
    }
  );
}
