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
 * Build Telegram Mini App referral URL.
 *
 * Expected:
 * BOT_USERNAME=my_bot
 *
 * Result:
 * https://t.me/my_bot/app?startapp=ref_XXXX
 */
function buildReferralLink(referralCode) {
  const botUsername =
    String(
      process.env.BOT_USERNAME || ""
    )
      .trim()
      .replace(/^@/, "");

  if (
    !botUsername ||
    !referralCode
  ) {
    return "";
  }

  return (
    `https://t.me/${botUsername}/app?startapp=ref_` +
    encodeURIComponent(
      referralCode
    )
  );
}


/*
|--------------------------------------------------------------------------
| PROCESS REFERRAL PROGRESS
|--------------------------------------------------------------------------
|
| IMPORTANT:
|
| This function MUST be called inside the same PostgreSQL
| transaction that awards the qualifying coins.
|
| Example:
|
| await processReferralProgress(
|   client,
|   user.id,
|   reward
| );
|
| If the transaction rolls back, both the game reward
| and referral progress/reward roll back together.
|
|--------------------------------------------------------------------------
*/

export async function processReferralProgress(
  client,
  referredUserId,
  earnedCoins
) {

  /*
   * Only positive integer coin rewards qualify.
   */
  const amount =
    Number(earnedCoins);

  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0
  ) {
    return {
      rewarded: false,
      progressCoins: 0
    };
  }


  /*
   * Find and lock the referral record.
   *
   * referred_user_id is unique in the database,
   * so one user can only have one referrer.
   */
  const referralResult =
    await client.query(
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


  /*
   * This user was not referred.
   */
  if (
    !referralResult.rows.length
  ) {
    return {
      rewarded: false,
      progressCoins: 0
    };
  }


  const referral =
    referralResult.rows[0];


  /*
   * Already completed.
   */
  if (
    referral.rewarded === true
  ) {
    return {
      rewarded: false,

      alreadyRewarded: true,

      progressCoins:
        Number(
          referral.qualifying_coins || 0
        )
    };
  }


  /*
   * Read configuration from the referral row.
   *
   * Database values take priority because they
   * represent the referral agreement created
   * when the user joined.
   */
  const requiredCoins =
    Number(
      referral.required_coins
    );

  const rewardCoins =
    Number(
      referral.reward_coins
    );


  /*
   * Validate stored referral configuration.
   */
  if (
    !Number.isSafeInteger(
      requiredCoins
    ) ||
    requiredCoins <= 0
  ) {
    throw new Error(
      "Invalid referral required_coins configuration"
    );
  }


  if (
    !Number.isSafeInteger(
      rewardCoins
    ) ||
    rewardCoins <= 0
  ) {
    throw new Error(
      "Invalid referral reward_coins configuration"
    );
  }


  /*
   * Current progress.
   */
  const currentProgress =
    Math.max(
      0,
      Number(
        referral.qualifying_coins || 0
      )
    );


  /*
   * Add the newly earned qualifying coins.
   *
   * Never allow progress to exceed the
   * required amount.
   */
  const newProgress =
    Math.min(
      requiredCoins,
      currentProgress + amount
    );


  /*
   * Not qualified yet.
   */
  if (
    newProgress < requiredCoins
  ) {

    await client.query(
      `
      UPDATE referrals
      SET
        qualifying_coins = $2
      WHERE id = $1
      `,
      [
        referral.id,
        newProgress
      ]
    );


    /*
     * Keep users.referral_progress_coins
     * synchronized for fast frontend access.
     */
    await client.query(
      `
      UPDATE users
      SET
        referral_progress_coins = $2
      WHERE id = $1
      `,
      [
        referredUserId,
        newProgress
      ]
    );


    return {
      rewarded: false,

      progressCoins:
        newProgress
    };
  }


  /*
   * =========================================================
   * REFERRAL QUALIFIED
   * =========================================================
   *
   * The referred user has now reached
   * the required qualifying coin amount.
   */


  /*
   * Reward the referrer.
   *
   * PostgreSQL automatically locks this user's row
   * while performing the UPDATE.
   */
  const referrerResult =
    await client.query(
      `
      UPDATE users
      SET
        coins =
          coins + $2,

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


  if (
    !referrerResult.rows.length
  ) {
    throw new Error(
      "Referral referrer user not found"
    );
  }


  const referrer =
    referrerResult.rows[0];


  /*
   * Record the referral reward.
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
      $5
    )
    `,
    [
      referral.referrer_id,

      rewardCoins,

      referrer.coins,

      String(
        referral.id
      ),

      `Referral reward for user ${referredUserId}`
    ]
  );


  /*
   * Mark referral as completed.
   *
   * This happens in the same transaction as
   * the referrer coin reward.
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
   * Store the final progress on the referred user.
   */
  await client.query(
    `
    UPDATE users
    SET
      referral_progress_coins = $2
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

    progressCoins:
      requiredCoins,

    referrerId:
      referral.referrer_id
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
        const userResult =
          await pool.query(
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


        if (
          !userResult.rows.length
        ) {
          return res.status(404).json({
            success: false,
            message:
              "User not found"
          });
        }


        const user =
          userResult.rows[0];


        /*
         * Get users invited by this user.
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
              ON u.id =
                 r.referred_user_id

            WHERE r.referrer_id = $1

            ORDER BY
              r.created_at DESC
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
              user.referral_progress_coins || 0
            ),

          requiredCoins:
            REQUIRED_COINS,

          rewardCoins:
            REFERRAL_REWARD,

          referrals:
            referralResult.rows.map(
              referral => ({

                id:
                  referral.id,

                qualifyingCoins:
                  Number(
                    referral.qualifying_coins || 0
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
          "GET /api/referrals:",
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
  | Lightweight endpoint for dashboard widgets.
  |
  */

  app.get(
    "/api/referrals/summary",
    requireAuth,
    async (req, res) => {

      try {

        const result =
          await pool.query(
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


        if (
          !result.rows.length
        ) {
          return res.status(404).json({
            success: false,
            message:
              "User not found"
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
              user.referral_progress_coins || 0
            ),

          requiredCoins:
            REQUIRED_COINS,

          rewardCoins:
            REFERRAL_REWARD
        });

      } catch (error) {

        console.error(
          "GET /api/referrals/summary:",
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
