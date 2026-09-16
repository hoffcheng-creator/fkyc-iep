-- FKYC IEP: RLS hardening (2026-09-16)
-- Applied live to project atbptsrpubmefyydgnde; keep in repo for history / re-apply.

BEGIN;

-- 1) app_meta: revoke anon, admin-only policy, FORCE RLS
REVOKE ALL ON TABLE public.app_meta FROM anon;
DROP POLICY IF EXISTS "Allow full access for authenticated users" ON public.app_meta;
DROP POLICY IF EXISTS app_meta_admin_all ON public.app_meta;
CREATE POLICY app_meta_admin_all ON public.app_meta
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
ALTER TABLE public.app_meta FORCE ROW LEVEL SECURITY;

-- 2) Align senco with admin in is_admin()
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $function$
DECLARE ok boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.teachers t
    WHERE t.id = auth.uid()
      AND (
        t.role IN ('admin', 'senco')
        OR COALESCE(t.roles, '[]'::jsonb) ? 'admin'
        OR COALESCE(t.roles, '[]'::jsonb) ? 'senco'
      )
  ) INTO ok;
  IF ok THEN RETURN true; END IF;

  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND (
          p.role IN ('admin', 'senco')
          OR COALESCE(p.roles, '[]'::jsonb) ? 'admin'
          OR COALESCE(p.roles, '[]'::jsonb) ? 'senco'
        )
    ) INTO ok;
  EXCEPTION WHEN undefined_table THEN
    ok := false;
  END;

  RETURN COALESCE(ok, false);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

-- 3) Teachers privilege-escalation trigger (defense in depth)
CREATE OR REPLACE FUNCTION public.prevent_teacher_privilege_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.username IS DISTINCT FROM OLD.username
     OR NEW.email IS DISTINCT FROM OLD.email
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
$function$;

DROP TRIGGER IF EXISTS trg_teachers_no_escalation ON public.teachers;
CREATE TRIGGER trg_teachers_no_escalation
  BEFORE UPDATE ON public.teachers
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_teacher_privilege_escalation();

-- 4) profile_student_map: use is_admin()
DROP POLICY IF EXISTS "Map access policy" ON public.profile_student_map;
DROP POLICY IF EXISTS profile_student_map_own_or_admin ON public.profile_student_map;
CREATE POLICY profile_student_map_own_or_admin ON public.profile_student_map
  FOR ALL TO authenticated
  USING (teacher_id = (auth.uid())::text OR public.is_admin())
  WITH CHECK (teacher_id = (auth.uid())::text OR public.is_admin());

COMMIT;