import pool from "../db/pool.js";
import { requireAuth } from "../middleware/requireAuth.js";

export function leaderboardRoutes(app) {
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
          ORDER BY coins DESC
          LIMIT 100
          `
        );

        const leaderboard =
          result.rows.map((user, index) => ({
            rank: index + 1,

            id: user.id,

            username:
              user.username ||
              user.first_name ||
              "Player",

            coins: Number(user.coins),

            totalGames: user.total_games
          }));

        res.json({
          success: true,
          leaderboard
        });
      } catch (error) {
        console.error("Leaderboard:", error);

        res.status(500).json({
          success: false,
          message: "Unable to load leaderboard"
        });
      }
    }
  );
}
