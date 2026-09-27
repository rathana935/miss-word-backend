import crypto from "crypto";
import pool from "../db/pool.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { getWordForLevel } from "../data/words.js";

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

const MAX_LIVES = 5;
const LIFE_MS = 60 * 60 * 1000;
const GAME_TIMEOUT_MS = 15 * 60 * 1000;

function createPuzzle(word, gaps) {
  const letters = word.split("");

  const available = [];

  for (let i = 0; i < letters.length; i++) {
    available.push(i);
  }

  const selected = [];

  while (
    selected.length < Math.min(gaps, letters.length)
  ) {
    const random =
      Math.floor(Math.random() * available.length);

    selected.push(
      available.splice(random, 1)[0]
    );
  }

  selected.sort((a, b) => a - b);

  const display = letters.map((letter, index) => {
    if (selected.includes(index)) {
      return "_";
    }

    return letter;
  });

  return {
    display: display.join(" "),
    letters,
    gaps: selected
  };
}

function puzzleHash(word, puzzle) {
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

async function refillLives(userId) {
  const result = await pool.query(
    `
    SELECT
      id,
      lives,
      last_life_at
    FROM users
    WHERE id = $1
    FOR UPDATE
    `,
    [userId]
  );

  if (!result.rows.length) {
    throw new Error("User not found");
  }

  const user = result.rows[0];

  if (user.lives >= MAX_LIVES) {
    return user;
  }

  const last = new Date(user.last_life_at).getTime();
  const now = Date.now();

  const recovered = Math.floor(
    (now - last) / LIFE_MS
  );

  if (recovered <= 0) {
    return user;
  }

  const newLives = Math.min(
    MAX_LIVES,
    user.lives + recovered
  );

  const newLastLife =
    newLives >= MAX_LIVES
      ? new Date()
      : new Date(last + recovered * LIFE_MS);

  const updated = await pool.query(
    `
    UPDATE users
    SET
      lives = $2,
      last_life_at = $3
    WHERE id = $1
    RETURNING *
    `,
    [userId, newLives, newLastLife]
  );

  return updated.rows[0];
}

export function gameRoutes(app) {
  /*
   * GAME CONFIG
   */
  app.get("/api/game/config", requireAuth, async (req, res) => {
    res.json({
      success: true,

      config: {
        easy: GAME_CONFIG.easy,
        medium: GAME_CONFIG.medium,
        hard: GAME_CONFIG.hard,
        difficult: GAME_CONFIG.difficult,

        maxLives: MAX_LIVES,
        lifeCooldownMinutes: 60,
        gameTimeoutMinutes: 15,

        levelsPerMode: 100
      }
    });
  });

  /*
   * PLAYER STATE
   */
  app.get("/api/game/state", requireAuth, async (req, res) => {
    try {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const user = await refillLives(req.user.id);

        const progress = await client.query(
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
          [req.user.id]
        );

        await client.query("COMMIT");

        res.json({
          success: true,

          user: {
            coins: Number(user.coins),
            lives: user.lives,
            hints: user.hints,
            totalGames: user.total_games,
            totalAds: user.total_ads,
            lastLifeAt: user.last_life_at
          },

          progress: progress.rows
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Game state:", error);

      res.status(500).json({
        success: false,
        message: "Unable to load game state"
      });
    }
  });

  /*
   * START GAME
   */
  app.post("/api/game/start", requireAuth, async (req, res) => {
    const mode = String(req.body?.mode || "").toLowerCase();

    if (!GAME_CONFIG[mode]) {
      return res.status(400).json({
        success: false,
        message: "Invalid game mode"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const lifeResult = await client.query(
        `
        SELECT *
        FROM users
        WHERE id = $1
        FOR UPDATE
        `,
        [req.user.id]
      );

      if (!lifeResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "User not found"
        });
      }

      let user = lifeResult.rows[0];

      /*
       * Refill lives.
       */
      if (user.lives < MAX_LIVES) {
        const last = new Date(user.last_life_at).getTime();
        const recovered = Math.floor(
          (Date.now() - last) / LIFE_MS
        );

        if (recovered > 0) {
          const newLives = Math.min(
            MAX_LIVES,
            user.lives + recovered
          );

          const newLast =
            newLives >= MAX_LIVES
              ? new Date()
              : new Date(last + recovered * LIFE_MS);

          const updated = await client.query(
            `
            UPDATE users
            SET
              lives = $2,
              last_life_at = $3
            WHERE id = $1
            RETURNING *
            `,
            [user.id, newLives, newLast]
          );

          user = updated.rows[0];
        }
      }

      /*
       * Prevent multiple active games.
       *
       * If an old game exists but has expired,
       * mark it expired first.
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

      const active = await client.query(
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
          message: "You already have an active game",
          sessionId: active.rows[0].id
        });
      }

      if (user.lives <= 0) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "No lives available",
          lives: 0
        });
      }

      const progress = await client.query(
        `
        SELECT *
        FROM user_game_progress
        WHERE user_id = $1
          AND mode = $2
        FOR UPDATE
        `,
        [user.id, mode]
      );

      let level = 1;

      if (progress.rows.length) {
        level = progress.rows[0].current_level;
      }

      if (level > 100) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "All levels completed"
        });
      }

      const word = getWordForLevel(mode, level);

      const puzzle = createPuzzle(
        word,
        GAME_CONFIG[mode].gaps
      );

      const hash = puzzleHash(word, puzzle);

      const sessionId = crypto.randomUUID();

      const expiresAt = new Date(
        Date.now() + GAME_TIMEOUT_MS
      );

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
      const updatedUser = await client.query(
        `
        UPDATE users
        SET
          lives = lives - 1,
          last_life_at =
            CASE
              WHEN lives - 1 < $2
              THEN NOW()
              ELSE last_life_at
            END
        WHERE id = $1
        RETURNING *
        `,
        [user.id, MAX_LIVES]
      );

      await client.query("COMMIT");

      res.json({
        success: true,

        game: {
          sessionId,
          mode,
          level,

          puzzle: {
            display: puzzle.display,
            gaps: puzzle.gaps.length
          },

          reward: GAME_CONFIG[mode].reward,

          expiresAt
        },

        user: {
          coins: Number(updatedUser.rows[0].coins),
          lives: updatedUser.rows[0].lives
        }
      });
    } catch (error) {
      await client.query("ROLLBACK");

      console.error("Start game:", error);

      res.status(500).json({
        success: false,
        message: "Unable to start game"
      });
    } finally {
      client.release();
    }
  });

  /*
   * SUBMIT GAME
   */
  app.post("/api/game/submit", requireAuth, async (req, res) => {
    const sessionId = req.body?.sessionId;
    const answer = String(req.body?.answer || "")
      .trim()
      .toUpperCase();

    if (!sessionId || !answer) {
      return res.status(400).json({
        success: false,
        message: "Session ID and answer are required"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const sessionResult = await client.query(
        `
        SELECT *
        FROM game_sessions
        WHERE id = $1
          AND user_id = $2
        FOR UPDATE
        `,
        [sessionId, req.user.id]
      );

      if (!sessionResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Game session not found"
        });
      }

      const session = sessionResult.rows[0];

      if (session.status !== "started") {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "This game is no longer active"
        });
      }

      if (new Date(session.expires_at).getTime() < Date.now()) {
        await client.query(
          `
          UPDATE game_sessions
          SET status = 'expired'
          WHERE id = $1
          `,
          [sessionId]
        );

        await client.query("COMMIT");

        return res.status(400).json({
          success: false,
          message: "Game expired"
        });
      }

      const correct = answer === session.word;

      if (!correct) {
        await client.query("ROLLBACK");

        return res.json({
          success: true,
          correct: false,
          message: "Wrong answer"
        });
      }

      const reward = Number(session.reward_coins);

      const updated = await client.query(
        `
        UPDATE users
        SET
          coins = coins + $2,
          total_games = total_games + 1
        WHERE id = $1
        RETURNING *
        `,
        [req.user.id, reward]
      );

      const user = updated.rows[0];

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
          'game_reward',
          $4,
          $5
        )
        `,
        [
          user.id,
          reward,
          user.coins,
          session.id,
          `${session.mode} level ${session.level}`
        ]
      );

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
          sessionId,
          crypto.randomBytes(24).toString("hex")
        ]
      );

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
          2,
          1
        )
        ON CONFLICT (user_id, mode)
        DO UPDATE SET
          completed_levels =
            LEAST(100, user_game_progress.completed_levels + 1),

          current_level =
            LEAST(100,
              CASE
                WHEN user_game_progress.current_level >= 100
                THEN 100
                ELSE user_game_progress.current_level + 1
              END
            )
        `,
        [user.id, session.mode]
      );

      await client.query("COMMIT");

      res.json({
        success: true,

        correct: true,

        reward,

        user: {
          coins: Number(user.coins),
          lives: user.lives,
          totalGames: user.total_games
        },

        game: {
          mode: session.mode,
          level: session.level,
          completed: true
        }
      });
    } catch (error) {
      await client.query("ROLLBACK");

      console.error("Submit game:", error);

      res.status(500).json({
        success: false,
        message: "Unable to submit game"
      });
    } finally {
      client.release();
    }
  });
}
