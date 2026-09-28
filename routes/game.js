import crypto from "crypto";
import pool from "../db/pool.js";

import { requireAuth } from "../middleware/auth.js";
import { getWordForLevel } from "../data/words.js";
import { processReferralProgress } from "./referrals.js";


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
  60 * 60 * 1000; // 60 minutes

const GAME_TIMEOUT_MS =
  15 * 60 * 1000; // 15 minutes


/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/


/**
 * Create the missing-letter puzzle.
 *
 * The actual word and missing positions are generated
 * only on the server.
 */
function createPuzzle(word, gaps) {
  const letters = word.split("");

  const gapCount = Math.min(
    Number(gaps),
    letters.length
  );

  let available = [];

  /*
   * Prefer middle characters so that the first
   * and last characters remain visible when possible.
   */
  if (letters.length > 2) {
    for (let i = 1; i < letters.length - 1; i++) {
      available.push(i);
    }
  }

  /*
   * Short words may not have enough middle positions.
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
    const randomIndex = crypto.randomInt(
      0,
      available.length
    );

    selected.push(
      available.splice(randomIndex, 1)[0]
    );
  }

  selected.sort((a, b) => a - b);

  const selectedSet =
    new Set(selected);

  const display = letters.map(
    (letter, index) => {
      if (selectedSet.has(index)) {
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


/**
 * Hash the authoritative puzzle.
 */
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


/**
 * Regenerate lives.
 *
 * IMPORTANT:
 * The caller must already have a transaction
 * and a FOR UPDATE lock on the user row.
 */
async function regenerateLives(client, user) {
  const currentLives =
    Number(user.lives);

  if (currentLives >= MAX_LIVES) {
    return user;
  }

  const lastLifeTimestamp =
    new Date(user.last_life_at).getTime();

  const now =
    Date.now();

  /*
   * Safety fallback if last_life_at is invalid.
   */
  if (!Number.isFinite(lastLifeTimestamp)) {
    return user;
  }

  const recovered =
    Math.floor(
      (now - lastLifeTimestamp) /
        LIFE_REGEN_MS
    );

  if (recovered <= 0) {
    return user;
  }

  const newLives =
    Math.min(
      MAX_LIVES,
      currentLives + recovered
    );

  /*
   * Preserve leftover regeneration time
   * when the player has not reached max lives.
   *
   * If max lives are reached, restart the
   * timer from now.
   */
  const newLastLifeAt =
    newLives >= MAX_LIVES
      ? new Date(now)
      : new Date(
          lastLifeTimestamp +
            recovered * LIFE_REGEN_MS
        );

  const result =
    await client.query(
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

          maxLives:
            MAX_LIVES,

          lifeCooldownMinutes:
            60,

          gameTimeoutMinutes:
            15,

          levelsPerMode:
            MAX_LEVEL
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
         * Lock user while calculating
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
          await client.query(
            "ROLLBACK"
          );

          return res.status(404).json({
            success: false,
            message:
              "User not found"
          });
        }


        let user =
          userResult.rows[0];


        user =
          await regenerateLives(
            client,
            user
          );


        /*
         * Get progress for every mode.
         */
        const progressResult =
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
                ELSE 99
              END
            `,
            [req.userId]
          );


        await client.query(
          "COMMIT"
        );


        return res.json({
          success: true,

          user: {
            id:
              user.id,

            telegramId:
              user.telegram_id,

            username:
              user.username,

            firstName:
              user.first_name,

            coins:
              Number(user.coins),

            lives:
              Number(user.lives),

            hints:
              Number(user.hints),

            totalGames:
              Number(user.total_games),

            totalAds:
              Number(user.total_ads),

            lastLifeAt:
              user.last_life_at,

            referralCode:
              user.referral_code
          },

          progress:
            progressResult.rows.map(
              row => ({
                mode:
                  row.mode,

                currentLevel:
                  Number(
                    row.current_level
                  ),

                completedLevels:
                  Number(
                    row.completed_levels
                  )
              })
            )
        });

      } catch (error) {

        try {
          await client.query(
            "ROLLBACK"
          );
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

      const mode =
        String(
          req.body?.mode || ""
        )
          .trim()
          .toLowerCase();


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
        await client.query(
          "BEGIN"
        );


        /*
         * Lock user.
         *
         * This prevents two simultaneous
         * requests from spending the same life.
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
          await client.query(
            "ROLLBACK"
          );

          return res.status(404).json({
            success: false,
            message:
              "User not found"
          });
        }


        let user =
          userResult.rows[0];


        /*
         * Regenerate lives before
         * checking the available balance.
         */
        user =
          await regenerateLives(
            client,
            user
          );


        /*
         * Expire old sessions.
         */
        await client.query(
          `
          UPDATE game_sessions
          SET
            status = 'expired'
          WHERE user_id = $1
            AND status = 'started'
            AND expires_at <= NOW()
          `,
          [user.id]
        );


        /*
         * Check whether the player
         * already has an active game.
         */
        const activeResult =
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


        if (activeResult.rows.length) {
          await client.query(
            "ROLLBACK"
          );

          return res.status(409).json({
            success: false,

            message:
              "You already have an active game",

            sessionId:
              activeResult.rows[0].id
          });
        }


        /*
         * Check lives.
         */
        if (
          Number(user.lives) <= 0
        ) {

          const nextLifeAt =
            new Date(
              new Date(
                user.last_life_at
              ).getTime() +
                LIFE_REGEN_MS
            );

          await client.query(
            "ROLLBACK"
          );

          return res.status(400).json({
            success: false,

            message:
              "No lives available",

            lives: 0,

            nextLifeAt
          });
        }


        /*
         * Get current level.
         */
        const progressResult =
          await client.query(
            `
            SELECT
              current_level,
              completed_levels
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


        if (progressResult.rows.length) {

          level =
            Number(
              progressResult.rows[0]
                .current_level
            );

        } else {

          /*
           * Auth normally creates all
           * progress rows, but this makes
           * the route resilient.
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
            ON CONFLICT (
              user_id,
              mode
            )
            DO NOTHING
            `,
            [
              user.id,
              mode
            ]
          );

          level = 1;
        }


        /*
         * Never allow a level outside
         * the configured range.
         */
        if (
          level < 1 ||
          level > MAX_LEVEL
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res.status(400).json({
            success: false,
            message:
              "All levels completed"
          });
        }


        /*
         * Server chooses the word.
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


        const normalizedWord =
          word
            .trim()
            .toUpperCase();


        /*
         * Create authoritative puzzle.
         */
        const puzzle =
          createPuzzle(
            normalizedWord,
            GAME_CONFIG[mode].gaps
          );


        const puzzleHash =
          createPuzzleHash(
            normalizedWord,
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
         * Create game session.
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

            normalizedWord,

            JSON.stringify(puzzle),

            puzzleHash,

            GAME_CONFIG[mode].reward,

            expiresAt
          ]
        );


        /*
         * Consume one life.
         *
         * If the user had 5 lives before
         * consuming this life, start the
         * next regeneration timer now.
         */
        const updatedUserResult =
          await client.query(
            `
            UPDATE users
            SET
              lives = lives - 1,

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


        if (!updatedUserResult.rows.length) {
          throw new Error(
            "Unable to consume life"
          );
        }


        await client.query(
          "COMMIT"
        );


        const finalUser =
          updatedUserResult.rows[0];


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
              GAME_CONFIG[mode].reward,

            expiresAt
          },

          user: {
            coins:
              Number(
                finalUser.coins
              ),

            lives:
              Number(
                finalUser.lives
              ),

            hints:
              Number(
                finalUser.hints
              )
          }
        });

      } catch (error) {

        try {
          await client.query(
            "ROLLBACK"
          );
        } catch {}


        /*
         * PostgreSQL partial unique index:
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


      if (
        !sessionId ||
        !answer
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Session ID and answer are required"
        });
      }


      /*
       * Prevent excessively large
       * request values.
       */
      if (
        sessionId.length > 100 ||
        answer.length > 100
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid game submission"
        });
      }


      const client =
        await pool.connect();


      try {
        await client.query(
          "BEGIN"
        );


        /*
         * Lock the session.
         *
         * This guarantees that two simultaneous
         * submit requests cannot both receive
         * the reward.
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
          await client.query(
            "ROLLBACK"
          );

          return res.status(404).json({
            success: false,
            message:
              "Game session not found"
          });
        }


        const session =
          sessionResult.rows[0];


        /*
         * The session must still be active.
         */
        if (
          session.status !== "started"
        ) {
          await client.query(
            "ROLLBACK"
          );

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
            SET
              status = 'expired'
            WHERE id = $1
            `,
            [session.id]
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
         * The correct answer comes only
         * from the server database.
         */
        const correctAnswer =
          String(
            session.word
          )
            .trim()
            .toUpperCase();


        const correct =
          answer === correctAnswer;


        /*
         * Wrong answer:
         *
         * No coins.
         * No level progress.
         * Game remains active.
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
         * SERVER-CALCULATED REWARD.
         *
         * Never accept reward amount
         * from the frontend.
         */
        const reward =
          Number(
            session.reward_coins
          );


        if (
          !Number.isSafeInteger(
            reward
          ) ||
          reward <= 0
        ) {
          throw new Error(
            "Invalid stored game reward"
          );
        }


        /*
         * Reward the user.
         */
        const userResult =
          await client.query(
            `
            UPDATE users
            SET
              coins =
                coins + $2,

              total_games =
                total_games + 1

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
         * Record coin transaction.
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
         * IMPORTANT:
         *
         * Add this game's reward toward
         * the referred user's 1,000-coin
         * qualification requirement.
         *
         * This runs INSIDE the same transaction.
         */
        await processReferralProgress(
          client,
          user.id,
          reward
        );


        /*
         * Mark session completed.
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
         * Advance mode level.
         *
         * Level 100 remains the maximum.
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

          ON CONFLICT (
            user_id,
            mode
          )

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

            Number(
              session.level
            ),

            MAX_LEVEL
          ]
        );


        /*
         * Everything succeeded.
         */
        await client.query(
          "COMMIT"
        );


        return res.json({
          success: true,

          correct: true,

          reward,

          user: {
            coins:
              Number(
                user.coins
              ),

            lives:
              Number(
                user.lives
              ),

            hints:
              Number(
                user.hints
              ),

            totalGames:
              Number(
                user.total_games
              )
          },

          game: {
            mode:
              session.mode,

            level:
              Number(
                session.level
              ),

            completed:
              true,

            nextLevel:
              Math.min(
                MAX_LEVEL,

                Number(
                  session.level
                ) + 1
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
