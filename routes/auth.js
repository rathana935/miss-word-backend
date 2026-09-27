import crypto from "crypto";
import pool from "../db/pool.js";

function validateTelegramInitData(initData) {
  if (!initData) {
    return null;
  }

  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    console.error("BOT_TOKEN is missing");
    return null;
  }

  const params = new URLSearchParams(initData);

  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date") || 0);

  if (!receivedHash || !authDate) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  if (now - authDate > 86400) {
    return null;
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculatedHash.length !== receivedHash.length) {
    return null;
  }

  const valid = crypto.timingSafeEqual(
    Buffer.from(calculatedHash),
    Buffer.from(receivedHash)
  );

  if (!valid) {
    return null;
  }

  const telegramUser = params.get("user");

  if (!telegramUser) {
    return null;
  }

  try {
    return {
      user: JSON.parse(telegramUser),
      startParam: params.get("start_param") || ""
    };
  } catch {
    return null;
  }
}

function makeReferralCode(telegramId) {
  return `MW${String(telegramId).slice(-10)}`;
}

async function createDefaultProgress(client, userId) {
  for (const mode of ["easy", "medium", "hard", "difficult"]) {
    await client.query(
      `
      INSERT INTO user_game_progress
        (user_id, mode, current_level, completed_levels)
      VALUES
        ($1, $2, 1, 0)
      ON CONFLICT (user_id, mode)
      DO NOTHING
      `,
      [userId, mode]
    );
  }
}

export function authRoutes(app) {
  app.post("/api/auth/telegram", async (req, res) => {
    try {
      const initData = req.body?.initData;

      const validated = validateTelegramInitData(initData);

      if (!validated) {
        return res.status(401).json({
          success: false,
          message: "Telegram user information is missing or invalid"
        });
      }

      const telegramUser = validated.user;

      const telegramId = Number(telegramUser.id);

      if (!Number.isSafeInteger(telegramId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid Telegram user ID"
        });
      }

      const client = await pool.connect();

      let user;

      try {
        await client.query("BEGIN");

        const existing = await client.query(
          `
          SELECT *
          FROM users
          WHERE telegram_id = $1
          LIMIT 1
          `,
          [telegramId]
        );

        if (existing.rows.length) {
          const updated = await client.query(
            `
            UPDATE users
            SET
              username = $2,
              first_name = $3,
              last_name = $4,
              language_code = $5
            WHERE telegram_id = $1
            RETURNING *
            `,
            [
              telegramId,
              telegramUser.username || null,
              telegramUser.first_name || null,
              telegramUser.last_name || null,
              telegramUser.language_code || null
            ]
          );

          user = updated.rows[0];

          await createDefaultProgress(client, user.id);
        } else {
          let referrerId = null;

          const startParam = validated.startParam || "";

          let referralCode = null;

          if (startParam.startsWith("ref_")) {
            referralCode = startParam.substring(4);
          } else if (startParam.startsWith("REF-")) {
            referralCode = startParam.substring(4);
          }

          if (referralCode) {
            const referrer = await client.query(
              `
              SELECT id
              FROM users
              WHERE referral_code = $1
              LIMIT 1
              `,
              [referralCode]
            );

            if (referrer.rows.length) {
              referrerId = referrer.rows[0].id;
            }
          }

          const inserted = await client.query(
            `
            INSERT INTO users (
              telegram_id,
              username,
              first_name,
              last_name,
              language_code,
              referral_code,
              referred_by
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7
            )
            RETURNING *
            `,
            [
              telegramId,
              telegramUser.username || null,
              telegramUser.first_name || null,
              telegramUser.last_name || null,
              telegramUser.language_code || null,
              makeReferralCode(telegramId),
              referrerId
            ]
          );

          user = inserted.rows[0];

          await createDefaultProgress(client, user.id);

          if (referrerId) {
            await client.query(
              `
              INSERT INTO referrals (
                referrer_id,
                referred_user_id
              )
              VALUES ($1, $2)
              ON CONFLICT (referred_user_id)
              DO NOTHING
              `,
              [referrerId, user.id]
            );
          }
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const token = crypto.randomBytes(32).toString("hex");

      const tokenHash = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

      const sessionDays = Math.min(
        Math.max(Number(process.env.SESSION_DAYS || 7), 1),
        365
      );

      await pool.query(
        `
        INSERT INTO auth_sessions (
          id,
          user_id,
          token_hash,
          expires_at
        )
        VALUES (
          $1,
          $2,
          $3,
          NOW() + ($4 || ' days')::interval
        )
        `,
        [
          crypto.randomUUID(),
          user.id,
          tokenHash,
          String(sessionDays)
        ]
      );

      const progress = await pool.query(
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
        [user.id]
      );

      return res.json({
        success: true,
        token,

        user: {
          id: user.id,
          telegramId: user.telegram_id,
          username: user.username,
          firstName: user.first_name,
          lastName: user.last_name,

          coins: Number(user.coins),
          lives: user.lives,
          hints: user.hints,

          referralCode: user.referral_code,
          successfulReferrals: user.successful_referrals,
          referralProgressCoins: Number(
            user.referral_progress_coins
          ),

          totalGames: user.total_games,
          totalAds: user.total_ads,

          lastLifeAt: user.last_life_at,
          dailyBonusClaimedAt: user.daily_bonus_claimed_at,
          spinClaimedAt: user.spin_claimed_at,

          progress: progress.rows
        }
      });
    } catch (error) {
      console.error("Telegram authentication error:", error);

      return res.status(500).json({
        success: false,
        message: "Authentication failed"
      });
    }
  });
}
