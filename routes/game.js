import crypto from "crypto";
import pool from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { getWordForLevel } from "../data/words.js";


/*
|--------------------------------------------------------------------------
| GAME CONFIG
|--------------------------------------------------------------------------
*/

const GAME_CONFIG = {
  easy: {
    gaps: 1,
    reward: 5
  },

  medium: {
    gaps: 2,
    reward: 6
  },

  hard: {
    gaps: 3,
    reward: 8
  },

  difficult: {
    gaps: 4,
    reward: 10
  }
};


const MAX_LEVEL = 100;

const MAX_LIVES = 5;

const LIFE_REGEN_MS =
  60 * 60 * 1000;

const GAME_TIMEOUT_MS =
  15 * 60 * 1000;


/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/


function createPuzzle(word, gaps) {
  const letters = word.split("");

  /*
   * Do not remove more positions than
   * the word actually contains.
   */
  const gapCount = Math.min(
    gaps,
    letters.length
  );

  /*
   * Prefer not to remove the first or last
   * character when the word is long enough.
   *
   * This makes the puzzle more playable.
   */
  let available = [];

  for (let i = 0; i < letters.length; i++) {
    if (
      letters.length > 2 &&
      i !== 0 &&
      i !== letters.length - 1
    ) {
      available.push(i);
    }
  }

  /*
   * Very short words may not have enough
   * middle characters.
   */
  if (available.length < gapCount) {
    available = [];

    for (let i = 0; i < letters.length; i++) {
      available.push(i);
    }
  }

  const selected = [];

  while (
    selected.length < gapCount &&
    available.length > 0
  ) {
    const randomIndex = Math.floor(
      Math.random() * available.length
    );

    selected.push(
      available.splice(randomIndex, 1)[0]
    );
  }

  selected.sort((a, b) => a - b);

  const display = letters.map(
    (letter, index) => {
      if (selected.includes(index)) {
        return "_";
      }

      return letter;
    }
  );

  return {
    display: display.join(" "),
    gaps: selected
  };
}


function createPuzzleHash(word, puzzle) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        word,
        gaps: puzzle.gaps
      })
    )
    .digest("hex");
}


/*
|--------------------------------------------------------------------------
| LIFE REGENERATION
|--------------------------------------------------------------------------
|
| IMPORTANT:
| This function expects the caller to already have
| a transaction and row lock.
|
*/

async function regenerateLives(client, user) {
  if (user.lives >= MAX_LIVES) {
    return user;
  }

  const lastLifeAt = new Date(
    user.last_life_at
  ).getTime();

  const now = Date.now();

  const recovered = Math.floor(
    (now - lastLifeAt) /
      LIFE_REGEN_MS
  );

  if (recovered <= 0) {
    return user;
  }

  const newLives = Math.min(
    MAX_LIVES,
    user.lives + recovered
  );

  /*
   * If the player reaches max lives,
   * restart the regeneration clock.
   *
   * Otherwise preserve the leftover
   * regeneration time.
   */
  const newLastLifeAt =
    newLives >= MAX_LIVES
      ? new Date()
      : new Date(
          lastLifeAt +
            recovered * LIFE_REGEN_MS
        );

  const result = await client.query(
    `
    UPDATE users
    SET
      lives = $2,
      last_life_at = $3
    WHERE id = $1
    RETURNING *
    `,
    [
      user.id,
      newLives,
      newLastLifeAt
    ]
  );

  return result.rows[0];
}


/*
|--------------------------------------------------------------------------
| GAME ROUTES
|--------------------------------------------------------------------------
*/

export function gameRoutes(app) {


  /*
  |--------------------------------------------------------------------------
  | GAME CONFIG
  |--------------------------------------------------------------------------
  */

  app.get(
    "/api/game/config",
    requireAuth,
    async (req, res) => {
      return res.json({
        success: true,

        config: {
          easy: GAME_CONFIG.easy,
          medium: GAME_CONFIG.medium,
          hard: GAME_CONFIG.hard,
          difficult: GAME_CONFIG.difficult,

          maxLives: MAX_LIVES,

          lifeCooldownMinutes: 60,

          gameTimeoutMinutes: 15,

          levelsPerMode: MAX_LEVEL
        }
      });
    }
  );


  /*
  |--------------------------------------------------------------------------
  | PLAYER STATE
  |--------------------------------------------------------------------------
  */

  app.get(
    "/api/game/state",
    requireAuth,
    async (req, res) => {
      const client =
        await pool.connect();

      try {
        await client.query("BEGIN");

        /*
         * Lock the user while calculating
         * regenerated lives.
         */
        const userResult =
          await client.query(
            `
            SELECT *
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

        let user =
          userResult.rows[0];

        user =
          await regenerateLives(
            client,
            user
          );


        const progress =
          await client.query(
            `
            SELECT
              mode,
              current_level,
              completed_levels
            FROM user_game_progress
            WHERE user_id = $1
            ORDER BY
              CASE mode
                WHEN 'easy' THEN 1
                WHEN 'medium' THEN 2
                WHEN 'hard' THEN 3
                WHEN 'difficult' THEN 4
              END
            `,
            [req.userId]
          );


        await client.query("COMMIT");


        return res.json({
          success: true,

          user: {
            id: user.id,

            telegramId:
              user.telegram_id,

            username:
              user.username,

            firstName:
              user.first_name,

            coins:
              Number(user.coins),

            lives:
              user.lives,

            hints:
              user.hints,

            totalGames:
              user.total_games,

            totalAds:
              user.total_ads,

            lastLifeAt:
              user.last_life_at,

            referralCode:
              user.referral_code
          },

          progress:
            progress.rows
        });

      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {}

        console.error(
          "GET /api/game/state:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to load game state"
        });

      } finally {
        client.release();
      }
    }
  );


  /*
  |--------------------------------------------------------------------------
  | START GAME
  |--------------------------------------------------------------------------
  */

  app.post(
    "/api/game/start",
    requireAuth,
    async (req, res) => {

      const mode = String(
        req.body?.mode || ""
      ).toLowerCase();


      if (!GAME_CONFIG[mode]) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid game mode"
        });
      }


      const client =
        await pool.connect();


      try {
        await client.query("BEGIN");


        /*
         * Lock the user row.
         *
         * This prevents two simultaneous
         * start requests from both consuming
         * the same life.
         */
        const userResult =
          await client.query(
            `
            SELECT *
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
            message:
              "User not found"
          });
        }


        let user =
          userResult.rows[0];


        /*
         * Regenerate lives first.
         */
        user =
          await regenerateLives(
            client,
            user
          );


        /*
         * Expire old games.
         */
        await client.query(
          `
          UPDATE game_sessions
          SET status = 'expired'
          WHERE user_id = $1
            AND status = 'started'
            AND expires_at <= NOW()
          `,
          [user.id]
        );


        /*
         * Check for another active game.
         */
        const active =
          await client.query(
            `
            SELECT id
            FROM game_sessions
            WHERE user_id = $1
              AND status = 'started'
              AND expires_at > NOW()
            LIMIT 1
            `,
            [user.id]
          );


        if (active.rows.length) {
          await client.query("ROLLBACK");

          return res.status(409).json({
            success: false,
            message:
              "You already have an active game",

            sessionId:
              active.rows[0].id
          });
        }


        /*
         * Check lives.
         */
        if (user.lives <= 0) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            success: false,
            message:
              "No lives available",

            lives: 0,

            nextLifeAt:
              new Date(
                new Date(
                  user.last_life_at
                ).getTime() +
                  LIFE_REGEN_MS
              )
          });
        }


        /*
         * Get player's current level.
         */
        const progressResult =
          await client.query(
            `
            SELECT *
            FROM user_game_progress
            WHERE user_id = $1
              AND mode = $2
            FOR UPDATE
            `,
            [
              user.id,
              mode
            ]
          );


        let level = 1;


        if (
          progressResult.rows.length
        ) {
          level =
            progressResult.rows[0]
              .current_level;
        } else {

          /*
           * Normally auth creates this,
           * but create it safely if missing.
           */
          await client.query(
            `
            INSERT INTO user_game_progress (
              user_id,
              mode,
              current_level,
              completed_levels
            )
            VALUES (
              $1,
              $2,
              1,
              0
            )
            ON CONFLICT (user_id, mode)
            DO NOTHING
            `,
            [
              user.id,
              mode
            ]
          );

          level = 1;
        }


        if (level > MAX_LEVEL) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            success: false,
            message:
              "All levels completed"
          });
        }


        /*
         * Get the server-side word.
         */
        const word =
          getWordForLevel(
            mode,
            level
          );


        if (
          typeof word !== "string" ||
          !word.trim()
        ) {
          throw new Error(
            `No word configured for ${mode} level ${level}`
          );
        }


        const puzzle =
          createPuzzle(
            word,
            GAME_CONFIG[mode].gaps
          );


        const hash =
          createPuzzleHash(
            word,
            puzzle
          );


        const sessionId =
          crypto.randomUUID();


        const expiresAt =
          new Date(
            Date.now() +
              GAME_TIMEOUT_MS
          );


        /*
         * Store the authoritative puzzle.
         */
        await client.query(
          `
          INSERT INTO game_sessions (
            id,
            user_id,
            mode,
            level,
            word,
            puzzle,
            puzzle_hash,
            reward_coins,
            expires_at,
            status
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            'started'
          )
          `,
          [
            sessionId,
            user.id,
            mode,
            level,
            word,
            JSON.stringify(puzzle),
            hash,
            GAME_CONFIG[mode].reward,
            expiresAt
          ]
        );


        /*
         * Consume one life.
         */
        const updatedUser =
          await client.query(
            `
            UPDATE users
            SET
              lives = lives - 1,

              /*
               * When dropping below max,
               * NOW() becomes the start of the
               * next regeneration cycle.
               */
              last_life_at =
                CASE
                  WHEN lives = $2
                  THEN NOW()
                  ELSE last_life_at
                END

            WHERE id = $1

            RETURNING *
            `,
            [
              user.id,
              MAX_LIVES
            ]
          );


        await client.query("COMMIT");


        const finalUser =
          updatedUser.rows[0];


        return res.json({
          success: true,

          game: {
            sessionId,

            mode,

            level,

            puzzle: {
              display:
                puzzle.display,

              gaps:
                puzzle.gaps.length
            },

            reward:
              GAME_CONFIG[mode]
                .reward,

            expiresAt
          },

          user: {
            coins:
              Number(
                finalUser.coins
              ),

            lives:
              finalUser.lives,

            hints:
              finalUser.hints
          }
        });

      } catch (error) {

        try {
          await client.query(
            "ROLLBACK"
          );
        } catch {}

        /*
         * PostgreSQL unique-index race:
         * one_active_game_per_user
         */
        if (
          error.code === "23505" &&
          error.constraint ===
            "one_active_game_per_user"
        ) {
          return res.status(409).json({
            success: false,
            message:
              "You already have an active game"
          });
        }


        console.error(
          "POST /api/game/start:",
          error
        );


        return res.status(500).json({
          success: false,
          message:
            "Unable to start game"
        });

      } finally {
        client.release();
      }
    }
  );


  /*
  |--------------------------------------------------------------------------
  | SUBMIT GAME
  |--------------------------------------------------------------------------
  */

  app.post(
    "/api/game/submit",
    requireAuth,
    async (req, res) => {

      const sessionId =
        String(
          req.body?.sessionId || ""
        ).trim();


      const answer =
        String(
          req.body?.answer || ""
        )
          .trim()
          .toUpperCase();


      if (!sessionId || !answer) {
        return res.status(400).json({
          success: false,
          message:
            "Session ID and answer are required"
        });
      }


      const client =
        await pool.connect();


      try {
        await client.query("BEGIN");


        /*
         * Lock the game session.
         */
        const sessionResult =
          await client.query(
            `
            SELECT *
            FROM game_sessions
            WHERE id = $1
              AND user_id = $2
            FOR UPDATE
            `,
            [
              sessionId,
              req.userId
            ]
          );


        if (!sessionResult.rows.length) {
          await client.query("ROLLBACK");

          return res.status(404).json({
            success: false,
            message:
              "Game session not found"
          });
        }


        const session =
          sessionResult.rows[0];


        /*
         * Already completed/expired.
         */
        if (
          session.status !== "started"
        ) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            success: false,
            message:
              "This game is no longer active"
          });
        }


        /*
         * Check expiration.
         */
        if (
          new Date(
            session.expires_at
          ).getTime() <= Date.now()
        ) {

          await client.query(
            `
            UPDATE game_sessions
            SET status = 'expired'
            WHERE id = $1
            `,
            [sessionId]
          );


          await client.query(
            "COMMIT"
          );


          return res.status(400).json({
            success: false,
            message:
              "Game expired"
          });
        }


        /*
         * Normalize the server answer.
         */
        const correctAnswer =
          String(session.word)
            .trim()
            .toUpperCase();


        const correct =
          answer === correctAnswer;


        /*
         * Wrong answer does NOT award coins.
         *
         * The game remains active so the player
         * can try again.
         */
        if (!correct) {

          await client.query(
            "ROLLBACK"
          );

          return res.json({
            success: true,

            correct: false,

            reward: 0,

            message:
              "Wrong answer"
          });
        }


        /*
         * SERVER-CALCULATED REWARD
         */
        const reward =
          Number(
            session.reward_coins
          );


        /*
         * Update coins and total games.
         */
        const userResult =
          await client.query(
            `
            UPDATE users
            SET
              coins = coins + $2,
              total_games = total_games + 1
            WHERE id = $1
            RETURNING *
            `,
            [
              req.userId,
              reward
            ]
          );


        if (!userResult.rows.length) {
          throw new Error(
            "User disappeared during game completion"
          );
        }


        const user =
          userResult.rows[0];


        /*
         * Record the coin transaction.
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
            $4,
            $5,
            $6
          )
          `,
          [
            user.id,

            reward,

            user.coins,

            "game_reward",

            session.id,

            `${session.mode} level ${session.level}`
          ]
        );


        /*
         * Mark the game completed.
         */
        await client.query(
          `
          UPDATE game_sessions
          SET
            status = 'completed',
            completed_at = NOW(),
            completion_token = $2
          WHERE id = $1
          `,
          [
            session.id,

            crypto
              .randomBytes(24)
              .toString("hex")
          ]
        );


        /*
         * Advance the player's level.
         */
        await client.query(
          `
          INSERT INTO user_game_progress (
            user_id,
            mode,
            current_level,
            completed_levels
          )
          VALUES (
            $1,
            $2,
            CASE
              WHEN $3 >= $4
              THEN $4
              ELSE $3 + 1
            END,
            1
          )

          ON CONFLICT (user_id, mode)

          DO UPDATE SET

            completed_levels =
              LEAST(
                $4,
                user_game_progress.completed_levels + 1
              ),

            current_level =
              CASE
                WHEN user_game_progress.current_level >= $4
                THEN $4
                ELSE user_game_progress.current_level + 1
              END
          `,
          [
            user.id,
            session.mode,
            session.level,
            MAX_LEVEL
          ]
        );


        await client.query(
          "COMMIT"
        );


        return res.json({
          success: true,

          correct: true,

          reward,

          user: {
            coins:
              Number(user.coins),

            lives:
              user.lives,

            hints:
              user.hints,

            totalGames:
              user.total_games
          },

          game: {
            mode:
              session.mode,

            level:
              session.level,

            completed: true,

            nextLevel:
              Math.min(
                MAX_LEVEL,
                Number(session.level) + 1
              )
          }
        });

      } catch (error) {

        try {
          await client.query(
            "ROLLBACK"
          );
        } catch {}


        console.error(
          "POST /api/game/submit:",
          error
        );


        return res.status(500).json({
          success: false,
          message:
            "Unable to submit game"
        });

      } finally {
        client.release();
      }
    }
  );
}
