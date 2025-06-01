-- Check if users table exists and update it if it does
DO $$ 
BEGIN
    -- Check if users table exists
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users') THEN
        -- Add new columns if they don't exist
        BEGIN
            ALTER TABLE users 
                ADD COLUMN IF NOT EXISTS avatar_url TEXT,
                ADD COLUMN IF NOT EXISTS bio TEXT,
                ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'offline',
                ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP WITH TIME ZONE,
                ADD COLUMN IF NOT EXISTS theme VARCHAR(20) DEFAULT 'dark',
                ADD COLUMN IF NOT EXISTS notification_enabled BOOLEAN DEFAULT true,
                ADD COLUMN IF NOT EXISTS language VARCHAR(10) DEFAULT 'en',
                ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'UTC';

            -- Add status check constraint if it doesn't exist
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint 
                WHERE conname = 'users_status_check'
            ) THEN
                ALTER TABLE users 
                    ADD CONSTRAINT users_status_check 
                    CHECK (status IN ('online', 'offline', 'away'));
            END IF;

            -- Add theme check constraint if it doesn't exist
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint 
                WHERE conname = 'users_theme_check'
            ) THEN
                ALTER TABLE users 
                    ADD CONSTRAINT users_theme_check 
                    CHECK (theme IN ('dark', 'light'));
            END IF;

            -- Add language check constraint if it doesn't exist
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint 
                WHERE conname = 'users_language_check'
            ) THEN
                ALTER TABLE users 
                    ADD CONSTRAINT users_language_check 
                    CHECK (language IN ('en', 'es', 'fr', 'de'));
            END IF;
        END;
    ELSE
        -- Create users table if it doesn't exist
        CREATE TABLE users (
            id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
            display_name VARCHAR(50) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            avatar_url TEXT,
            bio TEXT,
            status VARCHAR(20) DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'away')),
            last_seen TIMESTAMP WITH TIME ZONE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
            last_login TIMESTAMP WITH TIME ZONE,
            is_online BOOLEAN DEFAULT false,
            theme VARCHAR(20) DEFAULT 'dark' CHECK (theme IN ('dark', 'light')),
            notification_enabled BOOLEAN DEFAULT true,
            language VARCHAR(10) DEFAULT 'en' CHECK (language IN ('en', 'es', 'fr', 'de')),
            timezone VARCHAR(50) DEFAULT 'UTC'
        );
    END IF;
END $$;

-- Create or update indexes
CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(display_name);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen);

-- Create user_settings table if it doesn't exist
CREATE TABLE IF NOT EXISTS user_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email_notifications BOOLEAN DEFAULT true,
    sound_enabled BOOLEAN DEFAULT true,
    voice_activity BOOLEAN DEFAULT true,
    push_to_talk BOOLEAN DEFAULT false,
    keybindings JSONB DEFAULT '{}',
    custom_status TEXT,
    status_emoji TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- Create user_activity_log table if it doesn't exist
CREATE TABLE IF NOT EXISTS user_activity_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    activity_type VARCHAR(50) NOT NULL,
    activity_details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- Create user_friends table if it doesn't exist
CREATE TABLE IF NOT EXISTS user_friends (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    friend_id UUID REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()),
    UNIQUE(user_id, friend_id)
);

-- Create user_notifications table if it doesn't exist
CREATE TABLE IF NOT EXISTS user_notifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- Enable Row Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_friends ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;

-- Create or replace RLS policies
DO $$ 
BEGIN
    -- Users table policies
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'users' AND policyname = 'Users can create accounts') THEN
        CREATE POLICY "Users can create accounts" ON users
            FOR INSERT TO public WITH CHECK (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'users' AND policyname = 'Users can read user data') THEN
        CREATE POLICY "Users can read user data" ON users
            FOR SELECT TO public USING (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'users' AND policyname = 'Users can update their own data') THEN
        CREATE POLICY "Users can update their own data" ON users
            FOR UPDATE TO public USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
    END IF;

    -- User settings policies
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_settings' AND policyname = 'Users can manage their own settings') THEN
        CREATE POLICY "Users can manage their own settings" ON user_settings
            FOR ALL TO public USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
    END IF;

    -- Activity log policies
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_activity_log' AND policyname = 'Users can view their own activity') THEN
        CREATE POLICY "Users can view their own activity" ON user_activity_log
            FOR SELECT TO public USING (auth.uid() = user_id);
    END IF;

    -- Friends policies
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_friends' AND policyname = 'Users can manage their own friends') THEN
        CREATE POLICY "Users can manage their own friends" ON user_friends
            FOR ALL TO public USING (auth.uid() = user_id OR auth.uid() = friend_id)
            WITH CHECK (auth.uid() = user_id OR auth.uid() = friend_id);
    END IF;

    -- Notifications policies
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_notifications' AND policyname = 'Users can manage their own notifications') THEN
        CREATE POLICY "Users can manage their own notifications" ON user_notifications
            FOR ALL TO public USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
    END IF;
END $$;

-- Create or replace last_seen update function and trigger
CREATE OR REPLACE FUNCTION update_last_seen()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_seen = TIMEZONE('utc'::text, NOW());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger 
        WHERE tgname = 'update_user_last_seen'
    ) THEN
        CREATE TRIGGER update_user_last_seen
            BEFORE UPDATE ON users
            FOR EACH ROW
            EXECUTE FUNCTION update_last_seen();
    END IF;
END $$;

-- Create storage bucket for avatars if it doesn't exist
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

-- Create storage policy for avatars
CREATE POLICY "Avatar images are publicly accessible"
ON storage.objects FOR SELECT
USING (bucket_id = 'avatars');

CREATE POLICY "Users can upload their own avatar"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'avatars' 
    AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can update their own avatar"
ON storage.objects FOR UPDATE
USING (
    bucket_id = 'avatars' 
    AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can delete their own avatar"
ON storage.objects FOR DELETE
USING (
    bucket_id = 'avatars' 
    AND auth.uid()::text = (storage.foldername(name))[1]
); 