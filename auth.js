import crypto from "crypto";
import pool from "../db/pool.js";

export async function requireAuth(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    const token = authorization
      .slice("Bearer ".length)
      .trim();

    if (!token || token.length < 32 || token.length > 256) {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token"
      });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const result = await pool.query(
      `
      SELECT
        s.id AS session_id,
        s.user_id,
        s.expires_at,

        u.id,
        u.telegram_id,
        u.username,
        u.first_name,
        u.last_name,
        u.language_code,

        u.coins,
        u.lives,
        u.hints,

        u.last_life_at,

        u.daily_bonus_claimed_at,
        u.spin_claimed_at,

        u.total_games,
        u.total_ads,

        u.life_ads_used,
        u.life_ads_day,

        u.hint_ads_used,
        u.hint_ads_day,

        u.referral_code,
        u.referred_by,

        u.successful_referrals,
        u.referral_progress_coins,

        u.created_at,
        u.updated_at

      FROM auth_sessions s

      INNER JOIN users u
        ON u.id = s.user_id

      WHERE s.token_hash = $1
        AND s.expires_at > NOW()

      LIMIT 1
      `,
      [tokenHash]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success: false,
        message: "Session expired or invalid"
      });
    }

    const session = result.rows[0];

    /*
     * Make authenticated identity available
     * to every protected route.
     */
    req.user = session;
    req.userId = session.user_id;
    req.sessionId = session.session_id;

    /*
     * Session activity is bookkeeping only.
     * Do not turn a successful authentication
     * into a 500 error because this update fails.
     */
    try {
      await pool.query(
        `
        UPDATE auth_sessions
        SET last_used_at = NOW()
        WHERE id = $1
        `,
        [req.sessionId]
      );
    } catch (error) {
      console.error(
        "Failed to update auth session activity:",
        error
      );
    }

    return next();

  } catch (error) {
    console.error("requireAuth error:", error);

    return res.status(500).json({
      success: false,
      message: "Authentication check failed"
    });
  }
}
