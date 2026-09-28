import crypto from "crypto";
import pool from "../db/pool.js";

import { requireAuth } from "../middleware/auth.js";

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const MIN_WITHDRAWAL = 5000;
const COINS_PER_USD = 10000;

/*
 * Maximum number of pending withdrawals allowed
 * for one user at the same time.
 */
const MAX_PENDING_WITHDRAWALS = 3;

const ALLOWED_METHODS = [
  "faucetpay",
  "aba_bank",
  "mlbb"
];

/*
 * Basic destination length protection.
 *
 * Actual destination validation can be made more specific
 * when we implement the individual payout providers.
 */
const MAX_DESTINATION_LENGTH = 255;


/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function normalizeMethod(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeDestination(value) {
  return String(value || "")
    .trim();
}

function calculateUsd(coins) {
  return coins / COINS_PER_USD;
}


/*
|--------------------------------------------------------------------------
| ROUTES
|--------------------------------------------------------------------------
*/

export function withdrawalRoutes(app) {

  /*
  |--------------------------------------------------------------------------
  | GET WITHDRAWAL HISTORY
  |--------------------------------------------------------------------------
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
          LIMIT 100
          `,
          [req.userId]
        );

        return res.json({
          success: true,

          withdrawals:
            result.rows.map(
              (row) => ({
                id: row.id,

                method:
                  row.method,

                amountCoins:
                  Number(
                    row.amount_coins
                  ),

                amountUsd:
                  Number(
                    row.amount_usd || 0
                  ),

                destination:
                  row.destination,

                status:
                  row.status,

                adminNote:
                  row.admin_note,

                createdAt:
                  row.created_at,

                processedAt:
                  row.processed_at
              })
            )
        });

      } catch (error) {

        console.error(
          "Withdrawal history error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to load withdrawals"
        });
      }
    }
  );


  /*
  |--------------------------------------------------------------------------
  | GET WITHDRAWAL SUMMARY
  |--------------------------------------------------------------------------
  */

  app.get(
    "/api/withdrawals/summary",
    requireAuth,
    async (req, res) => {
      try {

        const result = await pool.query(
          `
          SELECT
            coins
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

        const coins =
          Number(
            result.rows[0].coins || 0
          );

        return res.json({
          success: true,

          balance: {
            coins,

            estimatedUsd:
              calculateUsd(coins)
          },

          withdrawal: {
            minimumCoins:
              MIN_WITHDRAWAL,

            coinsPerUsd:
              COINS_PER_USD,

            minimumUsd:
              calculateUsd(
                MIN_WITHDRAWAL
              ),

            methods:
              ALLOWED_METHODS
          }
        });

      } catch (error) {

        console.error(
          "Withdrawal summary error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to load withdrawal information"
        });
      }
    }
  );


  /*
  |--------------------------------------------------------------------------
  | CREATE WITHDRAWAL
  |--------------------------------------------------------------------------
  */

  app.post(
    "/api/withdrawals",
    requireAuth,
    async (req, res) => {

      const method =
        normalizeMethod(
          req.body?.method
        );

      const amountCoins =
        Number(
          req.body?.amountCoins
        );

      const destination =
        normalizeDestination(
          req.body?.destination
        );


      /*
       * Validate withdrawal method.
       */
      if (
        !ALLOWED_METHODS.includes(
          method
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid withdrawal method"
        });
      }


      /*
       * Only whole coins are accepted.
       */
      if (
        !Number.isSafeInteger(
          amountCoins
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Withdrawal amount must be a whole number"
        });
      }


      /*
       * Minimum withdrawal.
       */
      if (
        amountCoins <
        MIN_WITHDRAWAL
      ) {
        return res.status(400).json({
          success: false,
          message:
            `Minimum withdrawal is ${MIN_WITHDRAWAL} coins`
        });
      }


      /*
       * Protect against absurdly large
       * request bodies.
       */
      if (
        amountCoins >
        Number.MAX_SAFE_INTEGER
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid withdrawal amount"
        });
      }


      /*
       * Destination validation.
       */
      if (!destination) {
        return res.status(400).json({
          success: false,
          message:
            "Destination is required"
        });
      }

      if (
        destination.length >
        MAX_DESTINATION_LENGTH
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Destination is too long"
        });
      }


      /*
       * Calculate USD on the server.
       */
      const amountUsd =
        calculateUsd(
          amountCoins
        );


      const client =
        await pool.connect();

      try {

        await client.query(
          "BEGIN"
        );


        /*
         * Lock the user row.
         *
         * This prevents two simultaneous withdrawal
         * requests from spending the same coins.
         */
        const userResult =
          await client.query(
            `
            SELECT
              id,
              coins
            FROM users
            WHERE id = $1
            FOR UPDATE
            `,
            [req.userId]
          );


        if (!userResult.rows.length) {

          await client.query(
            "ROLLBACK"
          );

          return res.status(404).json({
            success: false,
            message:
              "User not found"
          });
        }


        const user =
          userResult.rows[0];


        /*
         * Check existing pending withdrawals
         * while the user row is locked.
         */
        const pendingResult =
          await client.query(
            `
            SELECT COUNT(*)::int AS count
            FROM withdrawals
            WHERE
              user_id = $1
              AND status = 'pending'
            `,
            [req.userId]
          );


        const pendingCount =
          Number(
            pendingResult.rows[0].count
          );


        if (
          pendingCount >=
          MAX_PENDING_WITHDRAWALS
        ) {

          await client.query(
            "ROLLBACK"
          );

          return res.status(400).json({
            success: false,
            message:
              "You already have too many pending withdrawals"
          });
        }


        /*
         * Check balance.
         */
        const currentCoins =
          Number(user.coins || 0);


        if (
          currentCoins <
          amountCoins
        ) {

          await client.query(
            "ROLLBACK"
          );

          return res.status(400).json({
            success: false,
            message:
              "Insufficient coins"
          });
        }


        /*
         * Generate withdrawal ID.
         */
        const withdrawalId =
          crypto.randomUUID();


        /*
         * Deduct coins atomically.
         */
        const updated =
          await client.query(
            `
            UPDATE users
            SET
              coins =
                coins - $2
            WHERE id = $1
            RETURNING
              coins
            `,
            [
              req.userId,
              amountCoins
            ]
          );


        if (!updated.rows.length) {

          throw new Error(
            "Failed to update user balance"
          );
        }


        const newBalance =
          updated.rows[0].coins;


        /*
         * Create withdrawal record.
         */
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
            req.userId,
            method,
            amountCoins,
            amountUsd,
            destination
          ]
        );


        /*
         * Record the balance movement.
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
            'withdrawal',
            $4,
            $5
          )
          `,
          [
            req.userId,

            -amountCoins,

            newBalance,

            withdrawalId,

            `Withdrawal via ${method}`
          ]
        );


        await client.query(
          "COMMIT"
        );


        return res.json({
          success: true,

          withdrawal: {
            id:
              withdrawalId,

            method,

            amountCoins,

            amountUsd,

            destination,

            status:
              "pending"
          },

          user: {
            coins:
              Number(
                newBalance
              )
          }
        });

      } catch (error) {

        await client.query(
          "ROLLBACK"
        );

        console.error(
          "Create withdrawal error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to create withdrawal"
        });

      } finally {

        client.release();
      }
    }
  );
}
