import crypto from "crypto";
import pool from "../db/pool.js";
import { requireAuth } from "../middleware/requireAuth.js";

const MIN_WITHDRAWAL = 5000;
const COINS_PER_USD = 10000;

const ALLOWED_METHODS = [
  "faucetpay",
  "aba_bank",
  "mlbb"
];

export function withdrawalRoutes(app) {
  /*
   * GET WITHDRAWAL HISTORY
   */
  app.get(
    "/api/withdrawals",
    requireAuth,
    async (req, res) => {
      try {
        const result = await pool.query(
          `
          SELECT
            id,
            method,
            amount_coins,
            amount_usd,
            destination,
            status,
            admin_note,
            created_at,
            processed_at
          FROM withdrawals
          WHERE user_id = $1
          ORDER BY created_at DESC
          `,
          [req.user.id]
        );

        res.json({
          success: true,

          withdrawals: result.rows.map(row => ({
            id: row.id,
            method: row.method,
            amountCoins: Number(row.amount_coins),
            amountUsd: Number(row.amount_usd || 0),
            destination: row.destination,
            status: row.status,
            adminNote: row.admin_note,
            createdAt: row.created_at,
            processedAt: row.processed_at
          }))
        });
      } catch (error) {
        console.error("Withdrawal history:", error);

        res.status(500).json({
          success: false,
          message: "Unable to load withdrawals"
        });
      }
    }
  );

  /*
   * CREATE WITHDRAWAL
   */
  app.post(
    "/api/withdrawals",
    requireAuth,
    async (req, res) => {
      const method = String(
        req.body?.method || ""
      ).toLowerCase();

      const amountCoins = Number(
        req.body?.amountCoins
      );

      const destination = String(
        req.body?.destination || ""
      ).trim();

      if (!ALLOWED_METHODS.includes(method)) {
        return res.status(400).json({
          success: false,
          message: "Invalid withdrawal method"
        });
      }

      if (
        !Number.isSafeInteger(amountCoins) ||
        amountCoins < MIN_WITHDRAWAL
      ) {
        return res.status(400).json({
          success: false,
          message:
            `Minimum withdrawal is ${MIN_WITHDRAWAL} coins`
        });
      }

      if (!destination) {
        return res.status(400).json({
          success: false,
          message: "Destination is required"
        });
      }

      const amountUsd =
        amountCoins / COINS_PER_USD;

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

        if (!user) {
          await client.query("ROLLBACK");

          return res.status(404).json({
            success: false,
            message: "User not found"
          });
        }

        if (Number(user.coins) < amountCoins) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            success: false,
            message: "Insufficient coins"
          });
        }

        /*
         * Deduct coins immediately.
         */
        const updated = await client.query(
          `
          UPDATE users
          SET coins = coins - $2
          WHERE id = $1
          RETURNING *
          `,
          [user.id, amountCoins]
        );

        const updatedUser = updated.rows[0];

        const withdrawalId =
          crypto.randomUUID();

        await client.query(
          `
          INSERT INTO withdrawals (
            id,
            user_id,
            method,
            amount_coins,
            amount_usd,
            destination,
            status
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            'pending'
          )
          `,
          [
            withdrawalId,
            user.id,
            method,
            amountCoins,
            amountUsd,
            destination
          ]
        );

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
            'withdrawal',
            $4,
            $5
          )
          `,
          [
            user.id,
            -amountCoins,
            updatedUser.coins,
            withdrawalId,
            `Withdrawal via ${method}`
          ]
        );

        await client.query("COMMIT");

        res.json({
          success: true,

          withdrawal: {
            id: withdrawalId,
            method,
            amountCoins,
            amountUsd,
            destination,
            status: "pending"
          },

          user: {
            coins: Number(updatedUser.coins)
          }
        });
      } catch (error) {
        await client.query("ROLLBACK");

        console.error("Create withdrawal:", error);

        res.status(500).json({
          success: false,
          message: "Unable to create withdrawal"
        });
      } finally {
        client.release();
      }
    }
  );
}
