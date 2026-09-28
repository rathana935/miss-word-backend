import pool from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const LEADERBOARD_LIMIT = 100;


/*
|--------------------------------------------------------------------------
| ROUTES
|--------------------------------------------------------------------------
*/

export function leaderboardRoutes(app) {

  /*
  |--------------------------------------------------------------------------
  | GLOBAL LEADERBOARD
  |--------------------------------------------------------------------------
  */

  app.get(
    "/api/leaderboard",
    requireAuth,
    async (req, res) => {
      try {
        const result = await pool.query(
          `
          SELECT
            id,
            username,
            first_name,
            coins,
            total_games
          FROM users
          ORDER BY
            coins DESC,
            total_games DESC,
            created_at ASC
          LIMIT $1
          `,
          [LEADERBOARD_LIMIT]
        );

        const leaderboard =
          result.rows.map(
            (user, index) => ({
              rank: index + 1,

              /*
               * Do not expose the UUID database ID
               * unnecessarily to the frontend.
               */

              username:
                user.username ||
                user.first_name ||
                "Player",

              coins:
                Number(user.coins || 0),

              totalGames:
                Number(
                  user.total_games || 0
                )
            })
          );

        return res.json({
          success: true,

          limit:
            LEADERBOARD_LIMIT,

          leaderboard
        });

      } catch (error) {
        console.error(
          "Leaderboard error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to load leaderboard"
        });
      }
    }
  );


  /*
  |--------------------------------------------------------------------------
  | MY LEADERBOARD POSITION
  |--------------------------------------------------------------------------
  |
  | Returns the authenticated user's current position.
  |
  */

  app.get(
    "/api/leaderboard/me",
    requireAuth,
    async (req, res) => {
      try {

        /*
         * Get the current user's score.
         */
        const userResult = await pool.query(
          `
          SELECT
            id,
            username,
            first_name,
            coins,
            total_games
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
         * Rank is determined by:
         *
         * 1. Coins DESC
         * 2. Total games DESC
         * 3. Created time ASC
         */
        const rankResult =
          await pool.query(
            `
            SELECT COUNT(*) + 1 AS rank
            FROM users
            WHERE
              coins > $1

              OR (
                coins = $1
                AND total_games > $2
              )

              OR (
                coins = $1
                AND total_games = $2
                AND created_at < $3
              )
            `,
            [
              user.coins,
              user.total_games,
              user.created_at
            ]
          );

        const rank =
          Number(
            rankResult.rows[0].rank
          );

        return res.json({
          success: true,

          player: {
            username:
              user.username ||
              user.first_name ||
              "Player",

            coins:
              Number(user.coins || 0),

            totalGames:
              Number(
                user.total_games || 0
              ),

            rank
          }
        });

      } catch (error) {
        console.error(
          "My leaderboard error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to load your ranking"
        });
      }
    }
  );
}
