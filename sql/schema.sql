-- SEN/IEP 系統：Supabase Postgres schema + RLS
-- 於 Supabase SQL Editor 整份執行。
-- Express 以 service_role 作為 BFF 代理層（會略過 RLS）；
-- 下列政策是 defense-in-depth，防止 anon/authenticated 金鑰外洩後直連資料庫。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. profiles：老師權限
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id              TEXT PRIMARY KEY,
  auth_user_id    UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  username        TEXT UNIQUE NOT NULL,
  email           TEXT UNIQUE,
  name            TEXT NOT NULL DEFAULT '',
  role            TEXT NOT NULL DEFAULT 'teacher',
  role_desc       TEXT NOT NULL DEFAULT '',
  roles           JSONB NOT NULL DEFAULT '[]'::jsonb,
  homeroom_scope  TEXT NOT NULL DEFAULT '',
  case_scope      TEXT NOT NULL DEFAULT '',
  teacher_scope   TEXT NOT NULL DEFAULT '',
  password_hash   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_auth_user_id ON public.profiles (auth_user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_username_lower ON public.profiles (lower(username));

-- ---------------------------------------------------------------------------
-- 2. students：學生 IEP / 敏感資料
--    student_id 對應前端的 students[].id
--    iep_data   存放 class/grade/goals/logs/clinical_files 等完整 IEP JSON
--    medical_notes 單獨存放醫療備註
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.students (
  student_id     TEXT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT '',
  iep_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  medical_notes  TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_students_name ON public.students (lower(name));

-- ---------------------------------------------------------------------------
-- 3. app_meta：系統日誌（維持前端 systemLogs 陣列契約）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_meta (
  id           TEXT PRIMARY KEY DEFAULT 'default',
  system_logs  JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.app_meta (id, system_logs)
VALUES ('default', '[]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- RLS helper：目前登入者是否為 admin
-- ---------------------------------------------------------------------------
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
    WHERE (p.auth_user_id = auth.uid() OR p.id = auth.uid()::text)
      AND (
        p.role = 'admin'
        OR COALESCE(p.roles, '[]'::jsonb) ? 'admin'
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS helper：學生編號是否落在老師 homeroom/case/teacher scope
-- 只讀 profiles，避免對 students 產生 RLS 遞迴
-- ---------------------------------------------------------------------------
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
    WHERE (p.auth_user_id = auth.uid() OR p.id = auth.uid()::text)
      AND (
        lower(trim(coalesce(p.homeroom_scope, ''))) = 'all'
        OR lower(trim(coalesce(p.case_scope, ''))) = 'all'
        OR lower(trim(coalesce(p.teacher_scope, ''))) = 'all'
        OR lower(trim(p_student_id)) = ANY (
          SELECT trim(x)
          FROM unnest(
            string_to_array(
              lower(concat_ws(',', p.homeroom_scope, p.case_scope, p.teacher_scope)),
              ','
            )
          ) AS x
          WHERE trim(x) <> ''
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.student_in_scope(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_in_scope(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enable RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_meta ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.students FORCE ROW LEVEL SECURITY;
ALTER TABLE public.app_meta FORCE ROW LEVEL SECURITY;

-- profiles
DROP POLICY IF EXISTS profiles_select_self_or_admin ON public.profiles;
CREATE POLICY profiles_select_self_or_admin
ON public.profiles FOR SELECT
TO authenticated
USING (
  auth_user_id = auth.uid()
  OR id = auth.uid()::text
  OR public.is_admin()
);

DROP POLICY IF EXISTS profiles_write_admin ON public.profiles;
CREATE POLICY profiles_write_admin
ON public.profiles FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- students
DROP POLICY IF EXISTS students_select_in_scope ON public.students;
CREATE POLICY students_select_in_scope
ON public.students FOR SELECT
TO authenticated
USING (public.student_in_scope(student_id));

DROP POLICY IF EXISTS students_insert_in_scope ON public.students;
CREATE POLICY students_insert_in_scope
ON public.students FOR INSERT
TO authenticated
WITH CHECK (public.student_in_scope(student_id) OR public.is_admin());

DROP POLICY IF EXISTS students_update_in_scope ON public.students;
CREATE POLICY students_update_in_scope
ON public.students FOR UPDATE
TO authenticated
USING (public.student_in_scope(student_id))
WITH CHECK (public.student_in_scope(student_id));

DROP POLICY IF EXISTS students_delete_admin ON public.students;
CREATE POLICY students_delete_admin
ON public.students FOR DELETE
TO authenticated
USING (public.is_admin());

-- app_meta：僅 admin
DROP POLICY IF EXISTS app_meta_admin_all ON public.app_meta;
CREATE POLICY app_meta_admin_all
ON public.app_meta FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- ---------------------------------------------------------------------------
-- Storage bucket：clinical-docs（私有）
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('clinical-docs', 'clinical-docs', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS clinical_docs_select_scope ON storage.objects;
CREATE POLICY clinical_docs_select_scope
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'clinical-docs'
  AND public.student_in_scope(split_part(name, '/', 1))
);

DROP POLICY IF EXISTS clinical_docs_insert_scope ON storage.objects;
CREATE POLICY clinical_docs_insert_scope
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'clinical-docs'
  AND public.student_in_scope(split_part(name, '/', 1))
);

DROP POLICY IF EXISTS clinical_docs_update_scope ON storage.objects;
CREATE POLICY clinical_docs_update_scope
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'clinical-docs'
  AND public.student_in_scope(split_part(name, '/', 1))
)
WITH CHECK (
  bucket_id = 'clinical-docs'
  AND public.student_in_scope(split_part(name, '/', 1))
);

DROP POLICY IF EXISTS clinical_docs_delete_scope ON storage.objects;
CREATE POLICY clinical_docs_delete_scope
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'clinical-docs'
  AND public.student_in_scope(split_part(name, '/', 1))
);

GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles, public.students, public.app_meta TO authenticated, service_role;
