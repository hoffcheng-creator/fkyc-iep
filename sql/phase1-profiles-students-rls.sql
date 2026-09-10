-- =============================================================================
-- 第一階段：profiles / students 建表 + PostgreSQL RLS
-- 用法：在 Supabase Dashboard → SQL Editor 整份一次執行
--
-- 設計原則
-- 1. profiles.id = auth.users.id（即 Supabase Auth 的 user_id）
-- 2. 老師只能接觸 homeroom_scope / case_scope / teacher_scope 內的學生
--    Scope 字串格式與現有系統相同：逗號分隔學生編號，或 "all"
-- 3. admin（role = 'admin' 或 roles JSON 含 "admin"）可讀寫全部
-- 4. 老師不可改自己的 scope / role（防止權限自我提升）
-- 5. Express 若使用 service_role 金鑰會略過 RLS；本政策是直連
--    PostgREST / anon / authenticated 時的強制防線
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. profiles：教職員檔案（1:1 對應 auth.users）
--    必須先建表。DROP POLICY 即使寫 IF EXISTS，資料表不存在仍會報 42P01。
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  -- 對應 Supabase Auth 的 user_id（auth.users.id）
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  username        TEXT UNIQUE NOT NULL,
  email           TEXT UNIQUE,
  name            TEXT NOT NULL DEFAULT '',
  role            TEXT NOT NULL DEFAULT 'teacher',
  role_desc       TEXT NOT NULL DEFAULT '',
  -- 與前端 users[].roles 對齊，例如 ["case","teacher"]
  roles           JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- 老師 Scope：逗號分隔學生編號（S001,S002）或 all
  homeroom_scope  TEXT NOT NULL DEFAULT '',
  case_scope      TEXT NOT NULL DEFAULT '',
  teacher_scope   TEXT NOT NULL DEFAULT '',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.profiles IS '教職員權限檔；id = auth.users.id (Auth user_id)';
COMMENT ON COLUMN public.profiles.id IS 'Supabase Auth user_id';
COMMENT ON COLUMN public.profiles.homeroom_scope IS '班主任可存取的學生編號 CSV 或 all';
COMMENT ON COLUMN public.profiles.case_scope IS '個案經理可存取的學生編號 CSV 或 all';
COMMENT ON COLUMN public.profiles.teacher_scope IS '科任老師可存取的學生編號 CSV 或 all';

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_lower
  ON public.profiles (lower(username));
CREATE INDEX IF NOT EXISTS idx_profiles_email_lower
  ON public.profiles (lower(email));

-- =============================================================================
-- 2. students：學生 IEP / 敏感資料
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.students (
  student_id     TEXT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT '',
  -- 完整 IEP JSON（class, grade, goals, logs, clinical_files, accommodations...）
  iep_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 醫療備註（敏感欄位，與 IEP 分開存放）
  medical_notes  TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT students_student_id_format
    CHECK (student_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
);

COMMENT ON TABLE  public.students IS '學生 IEP 與醫療敏感資料';
COMMENT ON COLUMN public.students.student_id IS '對應前端 students[].id';
COMMENT ON COLUMN public.students.iep_data IS 'IEP 完整 JSON（不含 student_id / name / medical_notes）';
COMMENT ON COLUMN public.students.medical_notes IS '醫療評估備註';

CREATE INDEX IF NOT EXISTS idx_students_name_lower
  ON public.students (lower(name));
CREATE INDEX IF NOT EXISTS idx_students_iep_data_gin
  ON public.students USING gin (iep_data);

-- -----------------------------------------------------------------------------
-- 清掉舊政策（此時表已存在，才可 DROP POLICY）
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS profiles_select_own_or_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own_safe ON public.profiles;
DROP POLICY IF EXISTS profiles_update_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_delete_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_select_self_or_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_write_admin ON public.profiles;

DROP POLICY IF EXISTS students_select_in_scope ON public.students;
DROP POLICY IF EXISTS students_insert_in_scope ON public.students;
DROP POLICY IF EXISTS students_update_in_scope ON public.students;
DROP POLICY IF EXISTS students_delete_admin ON public.students;

-- =============================================================================
-- 3. 共用函式
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS trg_students_updated_at ON public.students;
CREATE TRIGGER trg_students_updated_at
BEFORE UPDATE ON public.students
FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- 將 "S001, S002, all" 轉成小寫 trim 後的 token 陣列
CREATE OR REPLACE FUNCTION public.parse_scope_tokens(scope_text text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT COALESCE(
    ARRAY(
      SELECT trim(token)
      FROM unnest(string_to_array(lower(scope_text), ',')) AS token
      WHERE trim(token) <> ''
    ),
    ARRAY[]::text[]
  );
$$;

-- 單一 scope 欄位是否涵蓋該學生
CREATE OR REPLACE FUNCTION public.scope_covers(scope_text text, p_student_id text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT
    p_student_id IS NOT NULL
    AND trim(p_student_id) <> ''
    AND (
      'all' = ANY (public.parse_scope_tokens(scope_text))
      OR lower(trim(p_student_id)) = ANY (public.parse_scope_tokens(scope_text))
    );
$$;

-- 目前登入者是否為 admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND (
        p.role = 'admin'
        OR COALESCE(p.roles, '[]'::jsonb) ? 'admin'
      )
  );
$$;

-- 目前登入老師對某學生是否具備任一 Scope
-- 三欄獨立判斷：班主任 / 個案經理 / 科任
CREATE OR REPLACE FUNCTION public.student_in_scope(p_student_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_admin()
  OR EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND (
        public.scope_covers(p.homeroom_scope, p_student_id)
        OR public.scope_covers(p.case_scope, p_student_id)
        OR public.scope_covers(p.teacher_scope, p_student_id)
      )
  );
$$;

-- 目前登入者的 profile（供政策與除錯使用）
CREATE OR REPLACE FUNCTION public.current_profile()
RETURNS SETOF public.profiles
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public.profiles
  WHERE id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.parse_scope_tokens(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scope_covers(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.student_in_scope(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_profile() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.parse_scope_tokens(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.scope_covers(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.student_in_scope(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_profile() TO authenticated, service_role;

-- Auth 新帳號自動建立空白 profile（scope 預設空，需由 admin 指派）
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, username, email, name, role, roles)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1), NEW.id::text),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1), ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'teacher'),
    COALESCE(NEW.raw_user_meta_data->'roles', '["teacher"]'::jsonb)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 非 admin 禁止改 id / username / role / roles / 三個 scope（避免 RLS 自參照遞迴）
CREATE OR REPLACE FUNCTION public.prevent_profile_privilege_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- service_role / SQL Editor：auth.uid() 為 NULL，放行（BFF 代理層負責授權）
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.username IS DISTINCT FROM OLD.username
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.roles IS DISTINCT FROM OLD.roles
     OR NEW.homeroom_scope IS DISTINCT FROM OLD.homeroom_scope
     OR NEW.case_scope IS DISTINCT FROM OLD.case_scope
     OR NEW.teacher_scope IS DISTINCT FROM OLD.teacher_scope
  THEN
    RAISE EXCEPTION 'not allowed to modify privilege fields'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_no_escalation ON public.profiles;
CREATE TRIGGER trg_profiles_no_escalation
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE PROCEDURE public.prevent_profile_privilege_escalation();

-- =============================================================================
-- 4. 啟用 RLS（FORCE：即使 table owner 也套用；service_role 仍 BYPASSRLS）
-- =============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.students FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.profiles FROM PUBLIC, anon;
REVOKE ALL ON public.students FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.students TO authenticated, service_role;

-- =============================================================================
-- 5. profiles RLS
-- =============================================================================

-- 讀：本人 或 admin
CREATE POLICY profiles_select_own_or_admin
ON public.profiles
FOR SELECT
TO authenticated
USING (
  id = auth.uid()
  OR public.is_admin()
);

-- 新增：僅 admin（一般老師由 handle_new_user 觸發器寫入，該觸發器為 DEFINER）
CREATE POLICY profiles_insert_admin
ON public.profiles
FOR INSERT
TO authenticated
WITH CHECK (public.is_admin());

-- 老師可更新自己的列；權限欄位由 trg_profiles_no_escalation 鎖定
CREATE POLICY profiles_update_own_safe
ON public.profiles
FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- admin 可更新任何人（含指派 scope）
CREATE POLICY profiles_update_admin
ON public.profiles
FOR UPDATE
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- 刪除：僅 admin
CREATE POLICY profiles_delete_admin
ON public.profiles
FOR DELETE
TO authenticated
USING (public.is_admin());

-- =============================================================================
-- 6. students RLS（以老師 Scope 鎖定）
-- =============================================================================

-- 讀：學生編號落在自己的 homeroom / case / teacher scope，或 admin
CREATE POLICY students_select_in_scope
ON public.students
FOR SELECT
TO authenticated
USING (public.student_in_scope(student_id));

-- 新增：寫入的 student_id 必須已在自己的 scope 內（或 admin）
-- 避免老師自建範圍外學生後再讀取
CREATE POLICY students_insert_in_scope
ON public.students
FOR INSERT
TO authenticated
WITH CHECK (public.student_in_scope(student_id) OR public.is_admin());

-- 更新：舊列與新列的 student_id 都必須在 scope 內（禁止把學生改號逃出範圍）
CREATE POLICY students_update_in_scope
ON public.students
FOR UPDATE
TO authenticated
USING (public.student_in_scope(student_id))
WITH CHECK (public.student_in_scope(student_id));

-- 刪除：僅 admin
CREATE POLICY students_delete_admin
ON public.students
FOR DELETE
TO authenticated
USING (public.is_admin());

-- =============================================================================
-- 7. 驗收查詢（執行後可在 SQL Editor 單獨跑，確認政策存在）
-- =============================================================================
-- SELECT tablename, policyname, cmd
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN ('profiles', 'students')
-- ORDER BY tablename, policyname;
