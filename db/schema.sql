-- ============================================================
-- MISSING WORDS DATABASE
-- Production PostgreSQL Schema
-- ============================================================

-- ============================================================
-- EXTENSIONS
-- MUST COME BEFORE TABLES USING gen_random_uuid()
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    telegram_id BIGINT UNIQUE NOT NULL,

    username TEXT,
    first_name TEXT,
    last_name TEXT,
    language_code TEXT,

    coins BIGINT NOT NULL DEFAULT 0,
    lives INTEGER NOT NULL DEFAULT 5,
    hints INTEGER NOT NULL DEFAULT 3,

    last_life_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    daily_bonus_claimed_at TIMESTAMPTZ,
    spin_claimed_at TIMESTAMPTZ,

    total_games INTEGER NOT NULL DEFAULT 0,
    total_ads INTEGER NOT NULL DEFAULT 0,

    life_ads_used INTEGER NOT NULL DEFAULT 0,
    life_ads_day DATE NOT NULL DEFAULT CURRENT_DATE,

    hint_ads_used INTEGER NOT NULL DEFAULT 0,
    hint_ads_day DATE NOT NULL DEFAULT CURRENT_DATE,

    referral_code TEXT UNIQUE,
    referred_by UUID REFERENCES users(id),

    successful_referrals INTEGER NOT NULL DEFAULT 0,
    referral_progress_coins BIGINT NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (coins >= 0),
    CHECK (lives >= 0),
    CHECK (lives <= 5),
    CHECK (hints >= 0),
    CHECK (total_games >= 0),
    CHECK (total_ads >= 0),
    CHECK (life_ads_used >= 0),
    CHECK (hint_ads_used >= 0),
    CHECK (successful_referrals >= 0),
    CHECK (referral_progress_coins >= 0)
);


CREATE INDEX IF NOT EXISTS idx_users_telegram_id
ON users(telegram_id);

CREATE INDEX IF NOT EXISTS idx_users_referral_code
ON users(referral_code);

CREATE INDEX IF NOT EXISTS idx_users_referred_by
ON users(referred_by);

CREATE INDEX IF NOT EXISTS idx_users_coins
ON users(coins DESC);


-- ============================================================
-- AUTH SESSIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    token_hash TEXT UNIQUE NOT NULL,

    expires_at TIMESTAMPTZ NOT NULL,

    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS idx_auth_sessions_token
ON auth_sessions(token_hash);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
ON auth_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
ON auth_sessions(expires_at);


-- ============================================================
-- GAME PROGRESS
-- ============================================================

CREATE TABLE IF NOT EXISTS user_game_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    mode TEXT NOT NULL,

    current_level INTEGER NOT NULL DEFAULT 1,

    completed_levels INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(user_id, mode),

    CHECK (
        mode IN (
            'easy',
            'medium',
            'hard',
            'difficult'
        )
    ),

    CHECK (current_level >= 1),

    CHECK (completed_levels >= 0)
);


CREATE INDEX IF NOT EXISTS idx_game_progress_user
ON user_game_progress(user_id);

CREATE INDEX IF NOT EXISTS idx_game_progress_mode
ON user_game_progress(mode);


-- ============================================================
-- GAME SESSIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS game_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    mode TEXT NOT NULL,

    level INTEGER NOT NULL,

    word TEXT NOT NULL,

    puzzle JSONB NOT NULL,

    puzzle_hash TEXT NOT NULL,

    reward_coins BIGINT NOT NULL DEFAULT 0,

    status TEXT NOT NULL DEFAULT 'started',

    expires_at TIMESTAMPTZ NOT NULL,

    completed_at TIMESTAMPTZ,

    completion_token TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        mode IN (
            'easy',
            'medium',
            'hard',
            'difficult'
        )
    ),

    CHECK (level >= 1),

    CHECK (reward_coins >= 0),

    CHECK (
        status IN (
            'started',
            'completed',
            'cancelled',
            'expired'
        )
    )
);


CREATE INDEX IF NOT EXISTS idx_game_sessions_user
ON game_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_game_sessions_user_created
ON game_sessions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_game_sessions_status
ON game_sessions(status);

CREATE INDEX IF NOT EXISTS idx_game_sessions_expires
ON game_sessions(expires_at);


-- Only one active game session per user.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_game_per_user
ON game_sessions(user_id)
WHERE status = 'started';


-- ============================================================
-- COIN TRANSACTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS coin_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    amount BIGINT NOT NULL,

    balance_after BIGINT NOT NULL,

    type TEXT NOT NULL,

    reference_id TEXT,

    description TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (balance_after >= 0)
);


CREATE INDEX IF NOT EXISTS idx_coin_transactions_user
ON coin_transactions(user_id);

CREATE INDEX IF NOT EXISTS idx_coin_transactions_user_created
ON coin_transactions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_coin_transactions_created
ON coin_transactions(created_at);

CREATE INDEX IF NOT EXISTS idx_coin_transactions_type
ON coin_transactions(type);


-- ============================================================
-- DAILY REWARDS
-- ============================================================

CREATE TABLE IF NOT EXISTS daily_rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    reward_date DATE NOT NULL,

    reward_coins BIGINT NOT NULL DEFAULT 150,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(user_id, reward_date),

    CHECK (reward_coins >= 0)
);


CREATE INDEX IF NOT EXISTS idx_daily_rewards_user
ON daily_rewards(user_id);

CREATE INDEX IF NOT EXISTS idx_daily_rewards_date
ON daily_rewards(reward_date);


-- ============================================================
-- AD REWARDS
-- ============================================================

CREATE TABLE IF NOT EXISTS ad_rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    ad_type TEXT NOT NULL,

    provider TEXT NOT NULL,

    provider_event_id TEXT NOT NULL,

    reward_amount BIGINT NOT NULL DEFAULT 1,

    status TEXT NOT NULL DEFAULT 'completed',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(provider, provider_event_id),

    CHECK (reward_amount >= 0),

    CHECK (
        status IN (
            'completed',
            'rejected',
            'pending'
        )
    )
);


CREATE INDEX IF NOT EXISTS idx_ad_rewards_user
ON ad_rewards(user_id);

CREATE INDEX IF NOT EXISTS idx_ad_rewards_user_created
ON ad_rewards(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ad_rewards_provider_event
ON ad_rewards(provider, provider_event_id);


-- ============================================================
-- LUCKY SPINS
-- ============================================================

CREATE TABLE IF NOT EXISTS lucky_spins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    reward_type TEXT NOT NULL,

    reward_amount BIGINT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (reward_amount >= 0)
);


CREATE INDEX IF NOT EXISTS idx_lucky_spins_user
ON lucky_spins(user_id);

CREATE INDEX IF NOT EXISTS idx_lucky_spins_created
ON lucky_spins(created_at DESC);


-- ============================================================
-- REFERRALS
-- ============================================================

CREATE TABLE IF NOT EXISTS referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    referrer_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    referred_user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    qualifying_coins BIGINT NOT NULL DEFAULT 0,

    required_coins BIGINT NOT NULL DEFAULT 1000,

    reward_coins BIGINT NOT NULL DEFAULT 1000,

    rewarded BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    rewarded_at TIMESTAMPTZ,

    UNIQUE(referred_user_id),

    CHECK (qualifying_coins >= 0),
    CHECK (required_coins > 0),
    CHECK (reward_coins >= 0)
);


CREATE INDEX IF NOT EXISTS idx_referrals_referrer
ON referrals(referrer_id);

CREATE INDEX IF NOT EXISTS idx_referrals_referred
ON referrals(referred_user_id);

CREATE INDEX IF NOT EXISTS idx_referrals_rewarded
ON referrals(rewarded);


-- ============================================================
-- WITHDRAWALS
-- ============================================================

CREATE TABLE IF NOT EXISTS withdrawals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    method TEXT NOT NULL,

    amount_coins BIGINT NOT NULL,

    amount_usd NUMERIC(12, 4) NOT NULL,

    destination TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending',

    admin_note TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    processed_at TIMESTAMPTZ,

    CHECK (
        method IN (
            'faucetpay',
            'aba_bank',
            'mlbb'
        )
    ),

    CHECK (amount_coins > 0),

    CHECK (amount_usd > 0),

    CHECK (
        status IN (
            'pending',
            'processing',
            'paid',
            'rejected',
            'cancelled'
        )
    )
);


CREATE INDEX IF NOT EXISTS idx_withdrawals_user
ON withdrawals(user_id);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user_created
ON withdrawals(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_withdrawals_status
ON withdrawals(status);

CREATE INDEX IF NOT EXISTS idx_withdrawals_created
ON withdrawals(created_at DESC);


-- ============================================================
-- ACHIEVEMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS user_achievements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    achievement_key TEXT NOT NULL,

    progress INTEGER NOT NULL DEFAULT 0,

    completed BOOLEAN NOT NULL DEFAULT FALSE,

    claimed BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(user_id, achievement_key),

    CHECK (progress >= 0)
);


CREATE INDEX IF NOT EXISTS idx_achievements_user
ON user_achievements(user_id);

CREATE INDEX IF NOT EXISTS idx_achievements_completed
ON user_achievements(completed);


-- ============================================================
-- HINT TRANSACTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS hint_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    type TEXT NOT NULL,

    amount INTEGER NOT NULL DEFAULT 1,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (amount > 0)
);


CREATE INDEX IF NOT EXISTS idx_hint_transactions_user
ON hint_transactions(user_id);

CREATE INDEX IF NOT EXISTS idx_hint_transactions_created
ON hint_transactions(created_at DESC);


-- ============================================================
-- AUTOMATIC updated_at FUNCTION
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- USERS UPDATED_AT TRIGGER
-- ============================================================

DROP TRIGGER IF EXISTS users_updated_at
ON users;

CREATE TRIGGER users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();


-- ============================================================
-- GAME PROGRESS UPDATED_AT TRIGGER
-- ============================================================

DROP TRIGGER IF EXISTS progress_updated_at
ON user_game_progress;

CREATE TRIGGER progress_updated_at
BEFORE UPDATE ON user_game_progress
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();


-- ============================================================
-- ACHIEVEMENTS UPDATED_AT TRIGGER
-- ============================================================

DROP TRIGGER IF EXISTS achievements_updated_at
ON user_achievements;

CREATE TRIGGER achievements_updated_at
BEFORE UPDATE ON user_achievements
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();


-- ============================================================
-- OPTIONAL CLEANUP INDEXES
-- ============================================================

-- Helpful for finding expired sessions.
CREATE INDEX IF NOT EXISTS idx_game_sessions_active_lookup
ON game_sessions(user_id, status, expires_at);


-- ============================================================
-- SCHEMA COMPLETE
-- ============================================================
