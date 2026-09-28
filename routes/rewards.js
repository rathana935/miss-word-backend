import crypto from "crypto";
import pool from "../db/pool.js";

import { requireAuth } from "../middleware/auth.js";

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const DAILY_BONUS = 150;

const MAX_LIFE_ADS = 10;
const MAX_HINT_ADS = 10;

const MAX_LIVES = 5;

const SPIN_COOLDOWN_MS = 4 * 60 * 60 * 1000;

/*
 * Ads should never be allowed to specify their own reward.
 * The server decides the reward based on ad type.
 */
const AD_CONFIG = {
  life: {
    rewardType: "life",
    rewardAmount: 1,
    dailyLimit: MAX_LIFE_ADS
  },

  hint: {
    rewardType: "hint",
    rewardAmount: 1,
    dailyLimit: MAX_HINT_ADS
  },

  other: {
    rewardType: "none",
    rewardAmount: 0,
    dailyLimit: null
  }
};

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

/**
 * Get today's date in PostgreSQL instead of relying on the
 * server's JavaScript timezone.
 */
function isSameCalendarDay(value) {
  if (!value) return false;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const now = new Date();

  return (
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate()
  );
}

/**
 * Safe integer conversion.
 */
function toSafeNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return number;
}

/*
|--------------------------------------------------------------------------
| ROUTES
|--------------------------------------------------------------------------
*/

export function rewardRoutes(app) {

  /*
  |--------------------------------------------------------------------------
  | GET REWARD STATE
  |--------------------------------------------------------------------------
  |
  | Frontend can call this to refresh daily bonus, spin and ad limits.
  |
  */

  app.get(
    "/api/rewards/state",
    requireAuth,
    async (req, res) => {
      try {
        const result = await pool.query(
          `
          SELECT
            coins,
            lives,
            hints,

            daily_bonus_claimed_at,
            spin_claimed_at,

            life_ads_used,
            life_ads_day,

            hint_ads_used,
            hint_ads_day,

            total_ads
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

        const user = result.rows[0];

        const lifeAdsUsed = isSameCalendarDay(
          user.life_ads_day
        )
          ? Number(user.life_ads_used || 0)
          : 0;

        const hintAdsUsed = isSameCalendarDay(
          user.hint_ads_day
        )
          ? Number(user.hint_ads_used || 0)
          : 0;

        const spinReady =
          !user.spin_claimed_at ||
          Date.now() -
            new Date(user.spin_claimed_at).getTime() >=
            SPIN_COOLDOWN_MS;

        res.json({
          success: true,

          user: {
            coins: toSafeNumber(user.coins),
            lives: Number(user.lives),
            hints: Number(user.hints),
            totalAds: Number(user.total_ads)
          },

          dailyBonus: {
            claimed:
              isSameCalendarDay(
                user.daily_bonus_claimed_at
              )
          },

          ads: {
            life: {
              used: lifeAdsUsed,
              limit: MAX_LIFE_ADS,
              remaining: Math.max(
                0,
                MAX_LIFE_ADS - lifeAdsUsed
              )
            },

            hint: {
              used: hintAdsUsed,
              limit: MAX_HINT_ADS,
              remaining: Math.max(
                0,
                MAX_HINT_ADS - hintAdsUsed
              )
            }
          },

          spin: {
            ready: spinReady,
            cooldownMs: SPIN_COOLDOWN_MS
          }
        });
      } catch (error) {
        console.error(
          "Reward state error:",
          error
        );

        return res.status(500).json({
          success: false,
          message: "Unable to load reward state"
        });
      }
    }
  );


  /*
  |--------------------------------------------------------------------------
  | DAILY BONUS
  |--------------------------------------------------------------------------
  */

  app.post(
    "/api/rewards/daily",
    requireAuth,
    async (req, res) => {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        /*
         * Lock the user first.
         */
        const userResult = await client.query(
          `
          SELECT
            id,
            coins,
            daily_bonus_claimed_at
          FROM users
          WHERE id = $1
          FOR UPDATE
          `,
          [req.userId]
        );

        if (!userResult.rows.length) {
          await client.query("ROLLBACK");

          return res.status(404).json({
            success: false,
            message: "User not found"
          });
        }

        const user = userResult.rows[0];

        /*
         * The database unique constraint on
         * (user_id, reward_date) is the final protection
         * against duplicate claims.
         */
        const rewardResult = await client.query(
          `
          INSERT INTO daily_rewards (
            user_id,
            reward_date,
            reward_coins
          )
          VALUES (
            $1,
            CURRENT_DATE,
            $2
          )
          ON CONFLICT (user_id, reward_date)
          DO NOTHING
          RETURNING id, reward_coins
          `,
          [
            user.id,
            DAILY_BONUS
          ]
        );

        if (!rewardResult.rows.length) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            success: false,
            message: "Daily bonus already claimed"
          });
        }

        const updated = await client.query(
          `
          UPDATE users
          SET
            coins = coins + $2,
            daily_bonus_claimed_at = NOW()
          WHERE id = $1
          RETURNING
            coins,
            lives,
            hints
          `,
          [
            user.id,
            DAILY_BONUS
          ]
        );

        const updatedUser = updated.rows[0];

        /*
         * Every coin movement gets a transaction record.
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
            'daily_bonus',
            $4,
            'Daily bonus'
          )
          `,
          [
            user.id,
            DAILY_BONUS,
            updatedUser.coins,
            String(rewardResult.rows[0].id)
          ]
        );

        await client.query("COMMIT");

        return res.json({
          success: true,

          reward: DAILY_BONUS,

          user: {
            coins: toSafeNumber(
              updatedUser.coins
            ),
            lives: Number(updatedUser.lives),
            hints: Number(updatedUser.hints)
          }
        });

      } catch (error) {
        await client.query("ROLLBACK");

        console.error(
          "Daily reward error:",
          error
        );

        return res.status(500).json({
          success: false,
          message: "Unable to claim daily bonus"
        });

      } finally {
        client.release();
      }
    }
  );


  /*
  |--------------------------------------------------------------------------
  | AD REWARD
  |--------------------------------------------------------------------------
  |
  | IMPORTANT:
  |
  | The client must NOT send:
  |   rewardAmount
  |   coins
  |   lives
  |   hints
  |
  | The backend determines the reward.
  |
  | providerEventId should come from the ad provider whenever
  | the provider supplies one.
  |
  */

  app.post(
    "/api/rewards/ad",
    requireAuth,
    async (req, res) => {

      const adType = String(
        req.body?.adType || ""
      )
        .trim()
        .toLowerCase();

      const providerEventId =
        String(
          req.body?.providerEventId || ""
        ).trim();

      /*
       * Do not accept arbitrary ad types.
       */
      if (!Object.prototype.hasOwnProperty.call(
        AD_CONFIG,
        adType
      )) {
        return res.status(400).json({
          success: false,
          message: "Invalid ad type"
        });
      }

      /*
       * A production ad reward should have an
       * idempotency/event ID.
       *
       * Do NOT generate a random ID here because that
       * would allow the same client to submit the same
       * fake ad repeatedly with a new UUID.
       */
      if (!providerEventId) {
        return res.status(400).json({
          success: false,
          message: "providerEventId is required"
        });
      }

      if (providerEventId.length > 255) {
        return res.status(400).json({
          success: false,
          message: "Invalid provider event ID"
        });
      }

      const config = AD_CONFIG[adType];

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        /*
         * Lock the user first.
         */
        const userResult = await client.query(
          `
          SELECT
            id,
            coins,
            lives,
            hints,

            life_ads_used,
            life_ads_day,

            hint_ads_used,
            hint_ads_day,

            total_ads
          FROM users
          WHERE id = $1
          FOR UPDATE
          `,
          [req.userId]
        );

        if (!userResult.rows.length) {
          await client.query("ROLLBACK");

          return res.status(404).json({
            success: false,
            message: "User not found"
          });
        }

        const user = userResult.rows[0];

        /*
         * Check duplicate provider event.
         *
         * The UNIQUE constraint in PostgreSQL remains
         * the final protection against races.
         */
        const duplicate = await client.query(
          `
          SELECT id
          FROM ad_rewards
          WHERE provider = 'adsgram'
            AND provider_event_id = $1
          LIMIT 1
          `,
          [providerEventId]
        );

        if (duplicate.rows.length) {
          await client.query("ROLLBACK");

          return res.status(409).json({
            success: false,
            message: "Ad reward already processed"
          });
        }

        let lifeAdsUsed = Number(
          user.life_ads_used || 0
        );

        let hintAdsUsed = Number(
          user.hint_ads_used || 0
        );

        /*
         * Reset daily counters logically when the day changes.
         */
        if (
          !isSameCalendarDay(
            user.life_ads_day
          )
        ) {
          lifeAdsUsed = 0;
        }

        if (
          !isSameCalendarDay(
            user.hint_ads_day
          )
        ) {
          hintAdsUsed = 0;
        }

        /*
         * LIFE AD
         */
        if (adType === "life") {

          if (lifeAdsUsed >= MAX_LIFE_ADS) {
            await client.query("ROLLBACK");

            return res.status(400).json({
              success: false,
              message:
                "Daily life ad limit reached"
            });
          }

          if (
            Number(user.lives) >=
            MAX_LIVES
          ) {
            await client.query("ROLLBACK");

            return res.status(400).json({
              success: false,
              message:
                "Lives are already full"
            });
          }

          const updated = await client.query(
            `
            UPDATE users
            SET
              lives = LEAST(
                $2,
                lives + 1
              ),

              life_ads_used = $3,

              life_ads_day = CURRENT_DATE,

              total_ads = total_ads + 1

            WHERE id = $1

            RETURNING
              coins,
              lives,
              hints,
              total_ads
            `,
            [
              user.id,
              MAX_LIVES,
              lifeAdsUsed + 1
            ]
          );

          /*
           * No coin transaction because this reward
           * grants a life rather than coins.
           */
          const updatedUser =
            updated.rows[0];

          /*
           * Store the completed ad event.
           */
          await client.query(
            `
            INSERT INTO ad_rewards (
              user_id,
              ad_type,
              provider,
              provider_event_id,
              reward_amount,
              status
            )
            VALUES (
              $1,
              $2,
              'adsgram',
              $3,
              $4,
              'completed'
            )
            `,
            [
              user.id,
              adType,
              providerEventId,
              config.rewardAmount
            ]
          );

          await client.query("COMMIT");

          return res.json({
            success: true,

            adType,

            reward: {
              type: "life",
              amount: 1
            },

            user: {
              coins: toSafeNumber(
                updatedUser.coins
              ),
              lives: Number(
                updatedUser.lives
              ),
              hints: Number(
                updatedUser.hints
              ),
              totalAds: Number(
                updatedUser.total_ads
              )
            }
          });
        }


        /*
         * HINT AD
         */
        if (adType === "hint") {

          if (hintAdsUsed >= MAX_HINT_ADS) {
            await client.query("ROLLBACK");

            return res.status(400).json({
              success: false,
              message:
                "Daily hint ad limit reached"
            });
          }

          const updated = await client.query(
            `
            UPDATE users
            SET
              hints = hints + 1,

              hint_ads_used = $2,

              hint_ads_day = CURRENT_DATE,

              total_ads = total_ads + 1

            WHERE id = $1

            RETURNING
              coins,
              lives,
              hints,
              total_ads
            `,
            [
              user.id,
              hintAdsUsed + 1
            ]
          );

          const updatedUser =
            updated.rows[0];

          await client.query(
            `
            INSERT INTO ad_rewards (
              user_id,
              ad_type,
              provider,
              provider_event_id,
              reward_amount,
              status
            )
            VALUES (
              $1,
              $2,
              'adsgram',
              $3,
              $4,
              'completed'
            )
            `,
            [
              user.id,
              adType,
              providerEventId,
              config.rewardAmount
            ]
          );

          await client.query("COMMIT");

          return res.json({
            success: true,

            adType,

            reward: {
              type: "hint",
              amount: 1
            },

            user: {
              coins: toSafeNumber(
                updatedUser.coins
              ),
              lives: Number(
                updatedUser.lives
              ),
              hints: Number(
                updatedUser.hints
              ),
              totalAds: Number(
                updatedUser.total_ads
              )
            }
          });
        }


        /*
         * OTHER AD
         *
         * This does not award coins, lives or hints.
         * It only records the completed ad.
         */
        const updated = await client.query(
          `
          UPDATE users
          SET total_ads = total_ads + 1
          WHERE id = $1
          RETURNING
            coins,
            lives,
            hints,
            total_ads
          `,
          [user.id]
        );

        const updatedUser =
          updated.rows[0];

        await client.query(
          `
          INSERT INTO ad_rewards (
            user_id,
            ad_type,
            provider,
            provider_event_id,
            reward_amount,
            status
          )
          VALUES (
            $1,
            $2,
            'adsgram',
            $3,
            0,
            'completed'
          )
          `,
          [
            user.id,
            adType,
            providerEventId
          ]
        );

        await client.query("COMMIT");

        return res.json({
          success: true,

          adType,

          reward: {
            type: "none",
            amount: 0
          },

          user: {
            coins: toSafeNumber(
              updatedUser.coins
            ),
            lives: Number(
              updatedUser.lives
            ),
            hints: Number(
              updatedUser.hints
            ),
            totalAds: Number(
              updatedUser.total_ads
            )
          }
        });

      } catch (error) {

        await client.query("ROLLBACK");

        /*
         * PostgreSQL unique violation.
         *
         * This can happen if two requests for the same
         * provider event arrive at almost exactly the
         * same time.
         */
        if (error.code === "23505") {
          return res.status(409).json({
            success: false,
            message:
              "Ad reward already processed"
          });
        }

        console.error(
          "Ad reward error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to process ad reward"
        });

      } finally {
        client.release();
      }
    }
  );


  /*
  |--------------------------------------------------------------------------
  | EXCHANGE COINS FOR HINT
  |--------------------------------------------------------------------------
  |
  | 1 hint = 5 coins
  |
  */

  app.post(
    "/api/rewards/exchange-hint",
    requireAuth,
    async (req, res) => {

      const HINT_COST = 5;

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const result = await client.query(
          `
          SELECT
            coins,
            lives,
            hints
          FROM users
          WHERE id = $1
          FOR UPDATE
          `,
          [req.userId]
        );

        if (!result.rows.length) {
          await client.query("ROLLBACK");

          return res.status(404).json({
            success: false,
            message: "User not found"
          });
        }

        const user = result.rows[0];

        if (
          Number(user.coins) <
          HINT_COST
        ) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            success: false,
            message: "Not enough coins"
          });
        }

        const updated = await client.query(
          `
          UPDATE users
          SET
            coins = coins - $2,
            hints = hints + 1
          WHERE id = $1
          RETURNING
            coins,
            lives,
            hints
          `,
          [
            req.userId,
            HINT_COST
          ]
        );

        const updatedUser =
          updated.rows[0];

        await client.query(
          `
          INSERT INTO coin_transactions (
            user_id,
            amount,
            balance_after,
            type,
            description
          )
          VALUES (
            $1,
            $2,
            $3,
            'hint_exchange',
            'Exchanged 5 coins for 1 hint'
          )
          `,
          [
            req.userId,
            -HINT_COST,
            updatedUser.coins
          ]
        );

        await client.query("COMMIT");

        return res.json({
          success: true,

          cost: HINT_COST,

          reward: {
            type: "hint",
            amount: 1
          },

          user: {
            coins: toSafeNumber(
              updatedUser.coins
            ),
            lives: Number(
              updatedUser.lives
            ),
            hints: Number(
              updatedUser.hints
            )
          }
        });

      } catch (error) {

        await client.query("ROLLBACK");

        console.error(
          "Hint exchange error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to exchange coins"
        });

      } finally {
        client.release();
      }
    }
  );


  /*
  |--------------------------------------------------------------------------
  | LUCKY SPIN
  |--------------------------------------------------------------------------
  |
  | One spin every 4 hours.
  |
  */

  app.post(
    "/api/rewards/spin",
    requireAuth,
    async (req, res) => {

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const userResult = await client.query(
          `
          SELECT
            id,
            coins,
            lives,
            hints,
            spin_claimed_at
          FROM users
          WHERE id = $1
          FOR UPDATE
          `,
          [req.userId]
        );

        if (!userResult.rows.length) {
          await client.query("ROLLBACK");

          return res.status(404).json({
            success: false,
            message: "User not found"
          });
        }

        const user =
          userResult.rows[0];

        if (user.spin_claimed_at) {

          const elapsed =
            Date.now() -
            new Date(
              user.spin_claimed_at
            ).getTime();

          if (
            elapsed <
            SPIN_COOLDOWN_MS
          ) {
            await client.query("ROLLBACK");

            const remainingMs =
              SPIN_COOLDOWN_MS -
              Math.max(0, elapsed);

            return res.status(400).json({
              success: false,
              message:
                "Lucky spin is not ready yet",
              remainingMs
            });
          }
        }

        /*
         * Server chooses the reward.
         *
         * Client cannot choose a reward.
         */
        const rewards = [
          {
            type: "life",
            amount: 1
          },
          {
            type: "life",
            amount: 2
          },
          {
            type: "coins",
            amount: 10
          },
          {
            type: "coins",
            amount: 25
          },
          {
            type: "coins",
            amount: 50
          }
        ];

        const reward =
          rewards[
            crypto.randomInt(
              0,
              rewards.length
            )
          ];

        let updatedUser;

        /*
         * COIN REWARD
         */
        if (
          reward.type === "coins"
        ) {

          const updated =
            await client.query(
              `
              UPDATE users
              SET
                coins =
                  coins + $2,
                spin_claimed_at =
                  NOW()
              WHERE id = $1
              RETURNING
                coins,
                lives,
                hints
              `,
              [
                user.id,
                reward.amount
              ]
            );

          updatedUser =
            updated.rows[0];

          await client.query(
            `
            INSERT INTO coin_transactions (
              user_id,
              amount,
              balance_after,
              type,
              description
            )
            VALUES (
              $1,
              $2,
              $3,
              'lucky_spin',
              'Lucky spin reward'
            )
            `,
            [
              user.id,
              reward.amount,
              updatedUser.coins
            ]
          );

        } else {

          /*
           * LIFE REWARD
           *
           * Never allow lives above MAX_LIVES.
           */
          const updated =
            await client.query(
              `
              UPDATE users
              SET
                lives = LEAST(
                  $2,
                  lives + $3
                ),

                spin_claimed_at =
                  NOW()

              WHERE id = $1

              RETURNING
                coins,
                lives,
                hints
              `,
              [
                user.id,
                MAX_LIVES,
                reward.amount
              ]
            );

          updatedUser =
            updated.rows[0];
        }

        /*
         * Record spin history.
         */
        await client.query(
          `
          INSERT INTO lucky_spins (
            user_id,
            reward_type,
            reward_amount
          )
          VALUES (
            $1,
            $2,
            $3
          )
          `,
          [
            user.id,
            reward.type,
            reward.amount
          ]
        );

        await client.query("COMMIT");

        return res.json({
          success: true,

          reward,

          cooldownMs:
            SPIN_COOLDOWN_MS,

          user: {
            coins: toSafeNumber(
              updatedUser.coins
            ),
            lives: Number(
              updatedUser.lives
            ),
            hints: Number(
              updatedUser.hints
            )
          }
        });

      } catch (error) {

        await client.query("ROLLBACK");

        console.error(
          "Lucky spin error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to spin"
        });

      } finally {
        client.release();
      }
    }
  );
}
