BEGIN;

-- Existing usernames and passwords are intentionally preserved.
ALTER TABLE public.orgs ADD COLUMN IF NOT EXISTS login_prefix text;

CREATE OR REPLACE FUNCTION public.pug_clinic_login_base(value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  result text := '';
  letter text;
  transliteration jsonb := '{"а":"a","б":"b","в":"v","г":"h","ґ":"g","д":"d","е":"e","є":"ye","ё":"yo","ж":"zh","з":"z","и":"y","і":"i","ї":"yi","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f","х":"kh","ц":"ts","ч":"ch","ш":"sh","щ":"shch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya"}'::jsonb;
BEGIN
  FOREACH letter IN ARRAY regexp_split_to_array(lower(coalesce(value, '')), '') LOOP
    result := result || coalesce(transliteration ->> letter, letter);
  END LOOP;
  result := trim(both '-' from regexp_replace(result, '[^a-z0-9]+', '-', 'g'));
  result := trim(both '-' from left(result, 32));
  RETURN coalesce(nullif(result, ''), 'clinic');
END;
$$;

-- Backfill stable prefixes, assigning a suffix when clinic names coincide.
DO $$
DECLARE
  org record;
  base text;
  candidate text;
  number integer;
BEGIN
  FOR org IN SELECT id, name FROM public.orgs WHERE login_prefix IS NULL ORDER BY id LOOP
    base := public.pug_clinic_login_base(org.name);
    candidate := base;
    number := 1;
    WHILE EXISTS (SELECT 1 FROM public.orgs WHERE login_prefix = candidate) LOOP
      number := number + 1;
      candidate := base || '-' || number;
    END LOOP;
    UPDATE public.orgs SET login_prefix = candidate WHERE id = org.id;
  END LOOP;
END;
$$;

ALTER TABLE public.orgs ALTER COLUMN login_prefix SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orgs_login_prefix_unique ON public.orgs (login_prefix);
CREATE UNIQUE INDEX IF NOT EXISTS clinic_users_username_normalized_unique
  ON public.clinic_users (lower(btrim(username)));

CREATE OR REPLACE FUNCTION public.pug_assign_clinic_login_prefix()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  base text;
  candidate text;
  number integer := 1;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.login_prefix IS DISTINCT FROM OLD.login_prefix THEN
      RAISE EXCEPTION 'CLINIC_LOGIN_PREFIX_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- Compute the prefix from the clinic name, ignoring client-supplied values.
  base := public.pug_clinic_login_base(NEW.name);
  PERFORM pg_advisory_xact_lock(hashtextextended('pug-login-prefix-allocation', 0));
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM public.orgs WHERE login_prefix = candidate) LOOP
    number := number + 1;
    candidate := base || '-' || number;
  END LOOP;
  NEW.login_prefix := candidate;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pug_clinic_login_prefix ON public.orgs;
CREATE TRIGGER pug_clinic_login_prefix
  BEFORE INSERT OR UPDATE OF login_prefix ON public.orgs
  FOR EACH ROW EXECUTE FUNCTION public.pug_assign_clinic_login_prefix();

CREATE OR REPLACE FUNCTION public.pug_check_staff_login_prefix()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prefix text;
  local_login text;
BEGIN
  IF NEW.staff_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.username IS NOT DISTINCT FROM OLD.username
       AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
       AND NEW.staff_id IS NOT DISTINCT FROM OLD.staff_id THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT login_prefix INTO prefix FROM public.orgs WHERE id = NEW.org_id;
  NEW.username := lower(btrim(NEW.username));
  IF prefix IS NULL OR NEW.username IS NULL
     OR left(NEW.username, length(prefix) + 1) <> prefix || '.' THEN
    RAISE EXCEPTION 'STAFF_LOGIN_PREFIX_REQUIRED' USING ERRCODE = '23514';
  END IF;
  local_login := substring(NEW.username FROM length(prefix) + 2);
  IF local_login !~ '^[a-z0-9][a-z0-9._-]{2,39}$' THEN
    RAISE EXCEPTION 'STAFF_LOGIN_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pug_staff_login_prefix ON public.clinic_users;
CREATE TRIGGER pug_staff_login_prefix
  BEFORE INSERT OR UPDATE OF username, org_id, staff_id ON public.clinic_users
  FOR EACH ROW EXECUTE FUNCTION public.pug_check_staff_login_prefix();

-- Server-only trigger functions; no additional client permissions or RLS changes.
REVOKE ALL ON FUNCTION public.pug_clinic_login_base(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pug_assign_clinic_login_prefix() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pug_check_staff_login_prefix() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pug_clinic_login_base(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pug_assign_clinic_login_prefix() TO service_role;
GRANT EXECUTE ON FUNCTION public.pug_check_staff_login_prefix() TO service_role;

COMMIT;
