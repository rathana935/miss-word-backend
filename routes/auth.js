import crypto from "crypto";
import pool from "../db/pool.js";

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const AUTH_DATA_MAX_AGE_SECONDS =
  Number(
    process.env.TELEGRAM_AUTH_MAX_AGE ||
      86400
  );

const MAX_FUTURE_SECONDS = 60;

const DEFAULT_SESSION_DAYS = 7;
const MAX_SESSION_DAYS = 365;

const MODES = [
  "easy",
  "medium",
  "hard",
  "difficult"
];


/*
|--------------------------------------------------------------------------
| TELEGRAM INIT DATA VALIDATION
|--------------------------------------------------------------------------
|
| Telegram Mini App authentication:
|
| 1. Parse initData
| 2. Remove hash
| 3. Sort parameters
| 4. Build data-check-string
| 5. Create Telegram secret key
| 6. Calculate HMAC-SHA256
| 7. Constant-time compare
|
|--------------------------------------------------------------------------
*/

export function validateTelegramInitData(
  initData
) {
  if (
    typeof initData !== "string" ||
    !initData.trim()
  ) {
    return null;
  }

  const botToken =
    process.env.BOT_TOKEN;

  if (
    typeof botToken !== "string" ||
    !botToken.trim()
  ) {
    console.error(
      "BOT_TOKEN is missing"
    );

    return null;
  }

  try {
    const params =
      new URLSearchParams(
        initData
      );

    const receivedHash =
      params.get("hash");

    const authDate =
      Number(
        params.get("auth_date") || 0
      );

    /*
     * Required Telegram fields.
     */
    if (
      !receivedHash ||
      !/^[a-f0-9]{64}$/i.test(
        receivedHash
      ) ||
      !Number.isInteger(authDate) ||
      authDate <= 0
    ) {
      return null;
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    /*
     * Reject timestamps from too far in the future.
     *
     * This prevents a future-dated initData payload from
     * remaining valid for an unexpectedly long time.
     */
    if (
      authDate >
      now + MAX_FUTURE_SECONDS
    ) {
      return null;
    }

    /*
     * Reject stale authentication data.
     */
    if (
      now - authDate >
      AUTH_DATA_MAX_AGE_SECONDS
    ) {
      return null;
    }

    /*
     * hash is NOT included in the data-check-string.
     */
    params.delete("hash");

    const dataCheckString =
      [...params.entries()]
        .sort(
          ([keyA], [keyB]) =>
            keyA.localeCompare(
              keyB
            )
        )
        .map(
          ([key, value]) =>
            `${key}=${value}`
        )
        .join("\n");

    /*
     * Telegram WebApp secret key.
     */
    const secretKey =
      crypto
        .createHmac(
          "sha256",
          "WebAppData"
        )
        .update(
          botToken
        )
        .digest();

    /*
     * Calculate expected hash.
     */
    const calculatedHash =
      crypto
        .createHmac(
          "sha256",
          secretKey
        )
        .update(
          dataCheckString
        )
        .digest("hex");

    /*
     * Constant-time comparison.
     */
    const receivedBuffer =
      Buffer.from(
        receivedHash,
        "hex"
      );

    const calculatedBuffer =
      Buffer.from(
        calculatedHash,
        "hex"
      );

    if (
      receivedBuffer.length !==
      calculatedBuffer.length
    ) {
      return null;
    }

    if (
      !crypto.timingSafeEqual(
        calculatedBuffer,
        receivedBuffer
      )
    ) {
      return null;
    }

    /*
     * Telegram user information.
     */
    const telegramUserRaw =
      params.get("user");

    if (!telegramUserRaw) {
      return null;
    }

    let telegramUser;

    try {
      telegramUser =
        JSON.parse(
          telegramUserRaw
        );
    } catch {
      return null;
    }

    if (
      !telegramUser ||
      typeof telegramUser !== "object"
    ) {
      return null;
    }

    /*
     * Telegram user ID must exist.
     */
    const telegramId =
      Number(
        telegramUser.id
      );

    if (
      !Number.isSafeInteger(
        telegramId
      ) ||
      telegramId <= 0
    ) {
      return null;
    }

    return {
      user: telegramUser,

      startParam:
        params.get(
          "start_param"
        ) || ""
    };

  } catch (error) {
    console.error(
      "Telegram initData validation error:",
      error
    );

    return null;
  }
}


/*
|--------------------------------------------------------------------------
| REFERRAL CODE
|--------------------------------------------------------------------------
*/

function makeReferralCode(
  telegramId
) {
  /*
   * Keep the existing MW format so existing
   * referral links remain compatible.
   */
  return `MW${String(
    telegramId
  ).slice(-10)}`;
}


/*
|--------------------------------------------------------------------------
| CREATE DEFAULT GAME PROGRESS
|--------------------------------------------------------------------------
*/

async function createDefaultProgress(
  client,
  userId
) {
  for (const mode of MODES) {
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
        userId,
        mode
      ]
    );
  }
}


/*
|--------------------------------------------------------------------------
| PARSE REFERRAL CODE
|--------------------------------------------------------------------------
*/

function parseReferralCode(
  startParam
) {
  const value =
    String(
      startParam || ""
    ).trim();

  if (
    value.startsWith("ref_")
  ) {
    return value.slice(4);
  }

  if (
    value.startsWith("REF-")
  ) {
    return value.slice(4);
  }

  return null;
}


/*
|--------------------------------------------------------------------------
| CREATE UNIQUE REFERRAL CODE
|--------------------------------------------------------------------------
|
| Normally MW + Telegram ID is unique.
| This function also protects against a database collision.
|
|--------------------------------------------------------------------------
*/

async function createReferralCode(
  client,
  telegramId
) {
  const base =
    makeReferralCode(
      telegramId
    );

  /*
   * First attempt: existing format.
   */
  const existing =
    await client.query(
      `
      SELECT id
      FROM users
      WHERE referral_code = $1
      LIMIT 1
      `,
      [base]
    );

  if (
    !existing.rows.length
  ) {
    return base;
  }

  /*
   * Extremely unlikely fallback.
   */
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix =
      crypto
        .randomBytes(3)
        .toString("hex")
        .toUpperCase();

    const candidate =
      `${base}-${suffix}`;

    const check =
      await client.query(
        `
        SELECT id
        FROM users
        WHERE referral_code = $1
        LIMIT 1
        `,
        [candidate]
      );

    if (
      !check.rows.length
    ) {
      return candidate;
    }
  }

  throw new Error(
    "Unable to generate unique referral code"
  );
}


/*
|--------------------------------------------------------------------------
| ROUTES
|--------------------------------------------------------------------------
*/

export function authRoutes(app) {

  /*
  |--------------------------------------------------------------------------
  | TELEGRAM LOGIN
  |--------------------------------------------------------------------------
  */

  app.post(
    "/api/auth/telegram",
    async (req, res) => {

      try {

        const initData =
          req.body?.initData;

        const validated =
          validateTelegramInitData(
            initData
          );

        if (!validated) {
          return res.status(401).json({
            success: false,
            message:
              "Telegram user information is missing or invalid"
          });
        }

        const telegramUser =
          validated.user;

        const telegramId =
          Number(
            telegramUser.id
          );

        /*
         * Normalize Telegram profile data.
         */
        const username =
          telegramUser.username
            ? String(
                telegramUser.username
              ).slice(0, 255)
            : null;

        const firstName =
          telegramUser.first_name
            ? String(
                telegramUser.first_name
              ).slice(0, 255)
            : null;

        const lastName =
          telegramUser.last_name
            ? String(
                telegramUser.last_name
              ).slice(0, 255)
            : null;

        const languageCode =
          telegramUser.language_code
            ? String(
                telegramUser.language_code
              ).slice(0, 50)
            : null;


        const client =
          await pool.connect();

        let user;

        try {

          await client.query(
            "BEGIN"
          );

          /*
           * Lock an existing user if present.
           *
           * This protects concurrent Telegram login
           * requests for the same account.
           */
          const existing =
            await client.query(
              `
              SELECT *
              FROM users
              WHERE telegram_id = $1
              FOR UPDATE
              `,
              [telegramId]
            );


          /*
           * EXISTING USER
           */
          if (
            existing.rows.length
          ) {

            const updated =
              await client.query(
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
                  username,
                  firstName,
                  lastName,
                  languageCode
                ]
              );

            user =
              updated.rows[0];

            /*
             * Ensure progress rows exist.
             */
            await createDefaultProgress(
              client,
              user.id
            );

          } else {

            /*
             * NEW USER
             */

            let referrerId =
              null;

            const referralCode =
              parseReferralCode(
                validated.startParam
              );


            /*
             * Find the referrer.
             */
            if (
              referralCode
            ) {

              const referrer =
                await client.query(
                  `
                  SELECT
                    id,
                    telegram_id
                  FROM users
                  WHERE referral_code = $1
                  LIMIT 1
                  `,
                  [referralCode]
                );

              if (
                referrer.rows.length
              ) {

                /*
                 * Prevent self-referral.
                 */
                if (
                  Number(
                    referrer.rows[0]
                      .telegram_id
                  ) !==
                  telegramId
                ) {
                  referrerId =
                    referrer.rows[0].id;
                }
              }
            }


            /*
             * Generate referral code.
             */
            const newReferralCode =
              await createReferralCode(
                client,
                telegramId
              );


            /*
             * Create user.
             *
             * Database defaults handle:
             * coins
             * lives
             * hints
             * referral counters
             * timestamps
             */
            try {

              const inserted =
                await client.query(
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
                    username,
                    firstName,
                    lastName,
                    languageCode,
                    newReferralCode,
                    referrerId
                  ]
                );

              user =
                inserted.rows[0];

            } catch (error) {

              /*
               * Another simultaneous login may have
               * created the same Telegram account.
               *
               * PostgreSQL unique violation:
               * 23505
               */
              if (
                error.code ===
                "23505"
              ) {

                const concurrent =
                  await client.query(
                    `
                    SELECT *
                    FROM users
                    WHERE telegram_id = $1
                    FOR UPDATE
                    `,
                    [telegramId]
                  );

                if (
                  !concurrent.rows.length
                ) {
                  throw error;
                }

                const updated =
                  await client.query(
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
                      username,
                      firstName,
                      lastName,
                      languageCode
                    ]
                  );

                user =
                  updated.rows[0];

              } else {
                throw error;
              }
            }


            /*
             * Ensure game progress.
             */
            await createDefaultProgress(
              client,
              user.id
            );


            /*
             * Create referral record only for
             * a genuine referrer.
             */
            if (
              referrerId &&
              referrerId !== user.id
            ) {

              await client.query(
                `
                INSERT INTO referrals (
                  referrer_id,
                  referred_user_id,
                  qualifying_coins,
                  required_coins,
                  reward_coins,
                  rewarded
                )
                VALUES (
                  $1,
                  $2,
                  0,
                  1000,
                  1000,
                  FALSE
                )
                ON CONFLICT (
                  referred_user_id
                )
                DO NOTHING
                `,
                [
                  referrerId,
                  user.id
                ]
              );
            }
          }


          await client.query(
            "COMMIT"
          );

        } catch (error) {

          await client.query(
            "ROLLBACK"
          );

          throw error;

        } finally {

          client.release();
        }


        /*
        |--------------------------------------------------------------------------
        | AUTH SESSION
        |--------------------------------------------------------------------------
        */

        const token =
          crypto
            .randomBytes(32)
            .toString("hex");

        const tokenHash =
          crypto
            .createHash("sha256")
            .update(token)
            .digest("hex");


        let sessionDays =
          Number(
            process.env.SESSION_DAYS ||
              DEFAULT_SESSION_DAYS
          );

        if (
          !Number.isFinite(
            sessionDays
          )
        ) {
          sessionDays =
            DEFAULT_SESSION_DAYS;
        }

        sessionDays =
          Math.min(
            Math.max(
              Math.floor(
                sessionDays
              ),
              1
            ),
            MAX_SESSION_DAYS
          );


        /*
         * Store only the hash.
         *
         * The raw authentication token is returned
         * once to the frontend and is never stored in
         * the database.
         */
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
            NOW() +
              ($4::integer * INTERVAL '1 day')
          )
          `,
          [
            crypto.randomUUID(),
            user.id,
            tokenHash,
            sessionDays
          ]
        );


        /*
        |--------------------------------------------------------------------------
        | GAME PROGRESS
        |--------------------------------------------------------------------------
        */

        const progress =
          await pool.query(
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
            [user.id]
          );


        /*
        |--------------------------------------------------------------------------
        | RESPONSE
        |--------------------------------------------------------------------------
        */

        return res.json({
          success: true,

          token,

          session: {
            expiresInDays:
              sessionDays
          },

          user: {
            id:
              user.id,

            telegramId:
              Number(
                user.telegram_id
              ),

            username:
              user.username,

            firstName:
              user.first_name,

            lastName:
              user.last_name,

            languageCode:
              user.language_code,

            coins:
              Number(
                user.coins || 0
              ),

            lives:
              Number(
                user.lives || 0
              ),

            hints:
              Number(
                user.hints || 0
              ),

            referralCode:
              user.referral_code,

            successfulReferrals:
              Number(
                user.successful_referrals ||
                  0
              ),

            referralProgressCoins:
              Number(
                user.referral_progress_coins ||
                  0
              ),

            totalGames:
              Number(
                user.total_games || 0
              ),

            totalAds:
              Number(
                user.total_ads || 0
              ),

            lastLifeAt:
              user.last_life_at,

            dailyBonusClaimedAt:
              user.daily_bonus_claimed_at,

            spinClaimedAt:
              user.spin_claimed_at,

            progress:
              progress.rows.map(
                (row) => ({
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
          }
        });

      } catch (error) {

        console.error(
          "Telegram authentication error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Authentication failed"
        });
      }
    }
  );
}
