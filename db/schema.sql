-- ============================================
-- MISSING WORDS DATABASE
-- ============================================

-- USERS
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
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================
-- AUTH SESSIONS
-- ============================================

CREATE TABLE IF NOT EXISTS auth_sessions (
    id UUID PRIMARY KEY,

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


-- ============================================
-- GAME PROGRESS
-- ============================================

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


-- ============================================
-- GAME SESSIONS
-- ============================================

CREATE TABLE IF NOT EXISTS game_sessions (
    id UUID PRIMARY KEY,

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


CREATE INDEX IF NOT EXISTS idx_game_sessions_status
ON game_sessions(status);


-- Only one active game per user.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_game_per_user
ON game_sessions(user_id)
WHERE status = 'started';


-- ============================================
-- COIN TRANSACTIONS
-- ============================================

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

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS idx_coin_transactions_user
ON coin_transactions(user_id);


CREATE INDEX IF NOT EXISTS idx_coin_transactions_created
ON coin_transactions(created_at);


-- ============================================
-- DAILY REWARDS
-- ============================================

CREATE TABLE IF NOT EXISTS daily_rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    reward_date DATE NOT NULL,

    reward_coins BIGINT NOT NULL DEFAULT 150,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(user_id, reward_date)
);


-- ============================================
-- AD REWARDS
-- ============================================

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

    UNIQUE(provider, provider_event_id)
);


CREATE INDEX IF NOT EXISTS idx_ad_rewards_user
ON ad_rewards(user_id);


-- ============================================
-- LUCKY SPINS
-- ============================================

CREATE TABLE IF NOT EXISTS lucky_spins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    reward_type TEXT NOT NULL,

    reward_amount BIGINT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS idx_lucky_spins_user
ON lucky_spins(user_id);


-- ============================================
-- REFERRALS
-- ============================================

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

    UNIQUE(referred_user_id)
);


CREATE INDEX IF NOT EXISTS idx_referrals_referrer
ON referrals(referrer_id);


-- ============================================
-- WITHDRAWALS
-- ============================================

CREATE TABLE IF NOT EXISTS withdrawals (
    id UUID PRIMARY KEY,

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


CREATE INDEX IF NOT EXISTS idx_withdrawals_status
ON withdrawals(status);


-- ============================================
-- ACHIEVEMENTS
-- ============================================

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

    UNIQUE(user_id, achievement_key)
);


CREATE INDEX IF NOT EXISTS idx_achievements_user
ON user_achievements(user_id);


-- ============================================
-- HINT TRANSACTIONS
-- ============================================

CREATE TABLE IF NOT EXISTS hint_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    type TEXT NOT NULL,

    amount INTEGER NOT NULL DEFAULT 1,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS idx_hint_transactions_user
ON hint_transactions(user_id);


-- ============================================
-- AUTO UPDATE updated_at
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


DROP TRIGGER IF EXISTS users_updated_at
ON users;

CREATE TRIGGER users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();


DROP TRIGGER IF EXISTS progress_updated_at
ON user_game_progress;

CREATE TRIGGER progress_updated_at
BEFORE UPDATE ON user_game_progress
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();


DROP TRIGGER IF EXISTS achievements_updated_at
ON user_achievements;

CREATE TRIGGER achievements_updated_at
BEFORE UPDATE ON user_achievements
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();


-- ============================================
-- ENABLE UUID GENERATION
-- ============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
