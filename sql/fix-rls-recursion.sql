-- 先拆掉全部相關政策（立即停止 500 / infinite recursion）
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname, tablename
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('profiles', 'teachers', 'students')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- 權限函式：查 teachers/profiles 時關閉 RLS，避免自己呼叫自己
CREATE OR REPLACE FUNCTION public.parse_scope_tokens(scope_text text)
RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT SET search_path = public
AS $$
  SELECT COALESCE(ARRAY(
    SELECT trim(token)
    FROM unnest(string_to_array(lower(coalesce(scope_text, '')), ',')) AS token
    WHERE trim(token) <> ''
  ), ARRAY[]::text[]);
$$;

CREATE OR REPLACE FUNCTION public.scope_covers(scope_text text, p_student_id text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public
AS $$
  SELECT p_student_id IS NOT NULL AND trim(p_student_id) <> '' AND (
    'all' = ANY (public.parse_scope_tokens(scope_text))
    OR lower(trim(p_student_id)) = ANY (public.parse_scope_tokens(scope_text))
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE ok boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.teachers t
    WHERE t.id = auth.uid()
      AND (t.role = 'admin' OR COALESCE(t.roles, '[]'::jsonb) ? 'admin')
  ) INTO ok;
  IF ok THEN RETURN true; END IF;

  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND (p.role = 'admin' OR COALESCE(p.roles, '[]'::jsonb) ? 'admin')
    ) INTO ok;
  EXCEPTION WHEN undefined_table THEN
    ok := false;
  END;

  RETURN COALESCE(ok, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.student_in_scope(p_student_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE ok boolean := false;
BEGIN
  IF public.is_admin() THEN RETURN true; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.teachers t
    WHERE t.id = auth.uid()
      AND (
        public.scope_covers(t.homeroom_scope, p_student_id)
        OR public.scope_covers(t.case_scope, p_student_id)
        OR public.scope_covers(t.teacher_scope, p_student_id)
      )
  ) INTO ok;
  IF ok THEN RETURN true; END IF;

  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND (
          public.scope_covers(p.homeroom_scope, p_student_id)
          OR public.scope_covers(p.case_scope, p_student_id)
          OR public.scope_covers(p.teacher_scope, p_student_id)
        )
    ) INTO ok;
  EXCEPTION WHEN undefined_table THEN
    ok := false;
  END;

  RETURN COALESCE(ok, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.student_in_scope(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.parse_scope_tokens(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.scope_covers(text, text) TO authenticated, service_role;

ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 重新建立不會遞迴的政策
CREATE POLICY students_select_in_scope ON public.students
FOR SELECT TO authenticated
USING (public.student_in_scope(student_id));

CREATE POLICY students_write_in_scope ON public.students
FOR INSERT TO authenticated
WITH CHECK (public.student_in_scope(student_id) OR public.is_admin());

CREATE POLICY students_update_in_scope ON public.students
FOR UPDATE TO authenticated
USING (public.student_in_scope(student_id))
WITH CHECK (public.student_in_scope(student_id));

CREATE POLICY students_delete_admin ON public.students
FOR DELETE TO authenticated
USING (public.is_admin());

CREATE POLICY teachers_select_own ON public.teachers
FOR SELECT TO authenticated
USING (id = auth.uid());

CREATE POLICY teachers_select_admin ON public.teachers
FOR SELECT TO authenticated
USING (public.is_admin());

CREATE POLICY teachers_write_admin ON public.teachers
FOR ALL TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY profiles_select_own ON public.profiles
FOR SELECT TO authenticated
USING (id = auth.uid());

CREATE POLICY profiles_select_admin ON public.profiles
FOR SELECT TO authenticated
USING (public.is_admin());

CREATE POLICY profiles_write_admin ON public.profiles
FOR ALL TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

SELECT 'rls_fixed' AS status;
