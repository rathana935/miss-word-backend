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

    const token = authorization.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
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
        s.expires_at,
        u.*
      FROM auth_sessions s
      JOIN users u
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
        message: "Session expired"
      });
    }

    req.user = result.rows[0];
    req.sessionId = result.rows[0].session_id;

    await pool.query(
      `
      UPDATE auth_sessions
      SET last_used_at = NOW()
      WHERE id = $1
      `,
      [req.sessionId]
    );

    next();
  } catch (error) {
    console.error("requireAuth error:", error);

    return res.status(500).json({
      success: false,
      message: "Authentication check failed"
    });
  }
}
