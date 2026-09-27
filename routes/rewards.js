import crypto from "crypto";
import pool from "../db/pool.js";
import { requireAuth } from "../middleware/requireAuth.js";

const DAILY_BONUS = 150;
const MAX_LIFE_ADS = 10;
const MAX_HINT_ADS = 10;
const MAX_LIVES = 5;

export function rewardRoutes(app) {
  /*
   * DAILY BONUS
   */
  app.post(
    "/api/rewards/daily",
    requireAuth,
    async (req, res) => {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const userResult = await client.query(
          `
          SELECT *
          FROM users
          WHERE id = $1
          FOR UPDATE
          `,
          [req.user.id]
        );

        const user = userResult.rows[0];

        const reward = await client.query(
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
          RETURNING *
          `,
          [user.id, DAILY_BONUS]
        );

        if (!reward.rows.length) {
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
          RETURNING *
          `,
          [user.id, DAILY_BONUS]
        );

        const updatedUser = updated.rows[0];

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
            String(reward.rows[0].id)
          ]
        );

        await client.query("COMMIT");

        res.json({
          success: true,
          reward: DAILY_BONUS,
          coins: Number(updatedUser.coins)
        });
      } catch (error) {
        await client.query("ROLLBACK");

        console.error("Daily reward:", error);

        res.status(500).json({
          success: false,
          message: "Unable to claim daily bonus"
        });
      } finally {
        client.release();
      }
    }
  );

  /*
   * AD REWARD
   *
   * providerEventId should be a unique ID from the
   * advertising provider when available.
   */
  app.post(
    "/api/rewards/ad",
    requireAuth,
    async (req, res) => {
      const adType = String(
        req.body?.adType || "other"
      );

      const providerEventId =
        String(
          req.body?.providerEventId ||
          crypto.randomUUID()
        );

      if (!["life", "hint", "other"].includes(adType)) {
        return res.status(400).json({
          success: false,
          message: "Invalid ad type"
        });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

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

          return res.status(400).json({
            success: false,
            message: "Ad reward already processed"
          });
        }

        const userResult = await client.query(
          `
          SELECT *
          FROM users
          WHERE id = $1
          FOR UPDATE
          `,
          [req.user.id]
        );

        const user = userResult.rows[0];

        if (!user) {
          await client.query("ROLLBACK");

          return res.status(404).json({
            success: false,
            message: "User not found"
          });
        }

        let rewardAmount = 1;

        if (adType === "life") {
          let used = user.life_ads_used;

          const today = new Date()
            .toISOString()
            .slice(0, 10);

          const adDay = new Date(user.life_ads_day)
            .toISOString()
            .slice(0, 10);

          if (today !== adDay) {
            used = 0;
          }

          if (used >= MAX_LIFE_ADS) {
            await client.query("ROLLBACK");

            return res.status(400).json({
              success: false,
              message: "Daily life ad limit reached"
            });
          }

          if (user.lives >= MAX_LIVES) {
            await client.query("ROLLBACK");

            return res.status(400).json({
              success: false,
              message: "Lives are already full"
            });
          }

          await client.query(
            `
            UPDATE users
            SET
              lives = LEAST($2, lives + 1),
              life_ads_used = $3,
              life_ads_day = CURRENT_DATE,
              total_ads = total_ads + 1
            WHERE id = $1
            `,
            [
              user.id,
              MAX_LIVES,
              used + 1
            ]
          );
        } else if (adType === "hint") {
          let used = user.hint_ads_used;

          const today = new Date()
            .toISOString()
            .slice(0, 10);

          const adDay = new Date(user.hint_ads_day)
            .toISOString()
            .slice(0, 10);

          if (today !== adDay) {
            used = 0;
          }

          if (used >= MAX_HINT_ADS) {
            await client.query("ROLLBACK");

            return res.status(400).json({
              success: false,
              message: "Daily hint ad limit reached"
            });
          }

          await client.query(
            `
            UPDATE users
            SET
              hints = hints + 1,
              hint_ads_used = $2,
              hint_ads_day = CURRENT_DATE,
              total_ads = total_ads + 1
            WHERE id = $1
            `,
            [user.id, used + 1]
          );
        } else {
          await client.query(
            `
            UPDATE users
            SET total_ads = total_ads + 1
            WHERE id = $1
            `,
            [user.id]
          );
        }

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
            rewardAmount
          ]
        );

        const finalUser = await client.query(
          `
          SELECT
            coins,
            lives,
            hints,
            total_ads
          FROM users
          WHERE id = $1
          `,
          [user.id]
        );

        await client.query("COMMIT");

        res.json({
          success: true,
          adType,

          user: {
            coins: Number(finalUser.rows[0].coins),
            lives: finalUser.rows[0].lives,
            hints: finalUser.rows[0].hints,
            totalAds: finalUser.rows[0].total_ads
          }
        });
      } catch (error) {
        await client.query("ROLLBACK");

        console.error("Ad reward:", error);

        res.status(500).json({
          success: false,
          message: "Unable to process ad reward"
        });
      } finally {
        client.release();
      }
    }
  );

  /*
   * LUCKY SPIN
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
          SELECT *
          FROM users
          WHERE id = $1
          FOR UPDATE
          `,
          [req.user.id]
        );

        const user = userResult.rows[0];

        if (
          user.spin_claimed_at &&
          Date.now() -
            new Date(user.spin_claimed_at).getTime() <
            4 * 60 * 60 * 1000
        ) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            success: false,
            message: "Lucky spin is not ready yet"
          });
        }

        const rewards = [
          { type: "life", amount: 1 },
          { type: "life", amount: 2 },
          { type: "coins", amount: 25 },
          { type: "coins", amount: 50 },
          { type: "coins", amount: 10 }
        ];

        const reward =
          rewards[
            Math.floor(
              Math.random() * rewards.length
            )
          ];

        let updatedUser;

        if (reward.type === "coins") {
          const result = await client.query(
            `
            UPDATE users
            SET
              coins = coins + $2,
              spin_claimed_at = NOW()
            WHERE id = $1
            RETURNING *
            `,
            [user.id, reward.amount]
          );

          updatedUser = result.rows[0];

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
          const result = await client.query(
            `
            UPDATE users
            SET
              lives = LEAST($2, lives + $3),
              spin_claimed_at = NOW()
            WHERE id = $1
            RETURNING *
            `,
            [
              user.id,
              MAX_LIVES,
              reward.amount
            ]
          );

          updatedUser = result.rows[0];
        }

        await client.query(
          `
          INSERT INTO lucky_spins (
            user_id,
            reward_type,
            reward_amount
          )
          VALUES ($1, $2, $3)
          `,
          [
            user.id,
            reward.type,
            reward.amount
          ]
        );

        await client.query("COMMIT");

        res.json({
          success: true,

          reward,

          user: {
            coins: Number(updatedUser.coins),
            lives: updatedUser.lives
          }
        });
      } catch (error) {
        await client.query("ROLLBACK");

        console.error("Lucky spin:", error);

        res.status(500).json({
          success: false,
          message: "Unable to spin"
        });
      } finally {
        client.release();
      }
    }
  );
}
