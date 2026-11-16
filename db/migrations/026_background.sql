-- A background picture for the app, chosen per user (from Wallhaven). The
-- picture itself is kept on the server; this says which one it is and how
-- much the page colour is laid over it so text stays readable.
ALTER TABLE user_settings ADD COLUMN background JSONB;
ALTER TABLE user_settings ADD CONSTRAINT user_settings_background_object
    CHECK (background IS NULL OR jsonb_typeof(background) = 'object');
