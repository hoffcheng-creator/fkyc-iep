-- =============================================================================
-- Serverless 步驟 1：students + teachers 建表、RLS、匯入 data.json
-- 於 Supabase SQL Editor 整份執行
--
-- 注意：
-- 1. teachers.id 必須等於 auth.users.id（UUID），密碼只存在 Authentication，不寫入本表
-- 2. 若先前已有 public.profiles，會一併把現有列複製到 teachers
-- 3. 學生巢狀欄位（goals / logs / accommodations 等）全部放在 iep_data JSONB
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- students
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.students (
  student_id     TEXT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT '',
  iep_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  medical_notes  TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT students_student_id_format
    CHECK (student_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
);

CREATE INDEX IF NOT EXISTS idx_students_name_lower ON public.students (lower(name));
CREATE INDEX IF NOT EXISTS idx_students_iep_data_gin ON public.students USING gin (iep_data);

-- -----------------------------------------------------------------------------
-- teachers（對應前端教職員；id = Auth user_id）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.teachers (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username        TEXT UNIQUE NOT NULL,
  email           TEXT UNIQUE,
  name            TEXT NOT NULL DEFAULT '',
  role            TEXT NOT NULL DEFAULT 'teacher',
  role_desc       TEXT NOT NULL DEFAULT '',
  roles           JSONB NOT NULL DEFAULT '[]'::jsonb,
  homeroom_scope  TEXT NOT NULL DEFAULT '',
  case_scope      TEXT NOT NULL DEFAULT '',
  teacher_scope   TEXT NOT NULL DEFAULT '',
  extra           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_teachers_username_lower ON public.teachers (lower(username));
CREATE INDEX IF NOT EXISTS idx_teachers_email_lower ON public.teachers (lower(email));

-- 若舊表 profiles 已有資料，複製過來
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'profiles'
  ) THEN
    INSERT INTO public.teachers (id, username, email, name, role, role_desc, roles, homeroom_scope, case_scope, teacher_scope)
    SELECT p.id, p.username, p.email, p.name, p.role, p.role_desc, p.roles, p.homeroom_scope, p.case_scope, p.teacher_scope
    FROM public.profiles p
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 更新時間
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_students_updated_at ON public.students;
CREATE TRIGGER trg_students_updated_at
BEFORE UPDATE ON public.students
FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS trg_teachers_updated_at ON public.teachers;
CREATE TRIGGER trg_teachers_updated_at
BEFORE UPDATE ON public.teachers
FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS helpers（以 teachers 為準）
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.parse_scope_tokens(scope_text text)
RETURNS text[] LANGUAGE sql IMMUTABLE STRICT SET search_path = public AS $$
  SELECT COALESCE(ARRAY(
    SELECT trim(token)
    FROM unnest(string_to_array(lower(scope_text), ',')) AS token
    WHERE trim(token) <> ''
  ), ARRAY[]::text[]);
$$;

CREATE OR REPLACE FUNCTION public.scope_covers(scope_text text, p_student_id text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT p_student_id IS NOT NULL AND trim(p_student_id) <> '' AND (
    'all' = ANY (public.parse_scope_tokens(scope_text))
    OR lower(trim(p_student_id)) = ANY (public.parse_scope_tokens(scope_text))
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.teachers t
    WHERE t.id = auth.uid()
      AND (t.role = 'admin' OR COALESCE(t.roles, '[]'::jsonb) ? 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.student_in_scope(p_student_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_admin() OR EXISTS (
    SELECT 1 FROM public.teachers t
    WHERE t.id = auth.uid()
      AND (
        public.scope_covers(t.homeroom_scope, p_student_id)
        OR public.scope_covers(t.case_scope, p_student_id)
        OR public.scope_covers(t.teacher_scope, p_student_id)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.parse_scope_tokens(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scope_covers(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.student_in_scope(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.parse_scope_tokens(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.scope_covers(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.student_in_scope(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.teachers (id, username, email, name, role, roles)
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

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students FORCE ROW LEVEL SECURITY;
ALTER TABLE public.teachers FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.students FROM PUBLIC, anon;
REVOKE ALL ON public.teachers FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.students TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.teachers TO authenticated, service_role;

DROP POLICY IF EXISTS teachers_select_own_or_admin ON public.teachers;
CREATE POLICY teachers_select_own_or_admin ON public.teachers
FOR SELECT TO authenticated
USING (id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS teachers_insert_admin ON public.teachers;
CREATE POLICY teachers_insert_admin ON public.teachers
FOR INSERT TO authenticated
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS teachers_update_own ON public.teachers;
CREATE POLICY teachers_update_own ON public.teachers
FOR UPDATE TO authenticated
USING (id = auth.uid() OR public.is_admin())
WITH CHECK (id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS teachers_delete_admin ON public.teachers;
CREATE POLICY teachers_delete_admin ON public.teachers
FOR DELETE TO authenticated
USING (public.is_admin());

DROP POLICY IF EXISTS students_select_in_scope ON public.students;
CREATE POLICY students_select_in_scope ON public.students
FOR SELECT TO authenticated
USING (public.student_in_scope(student_id));

DROP POLICY IF EXISTS students_insert_in_scope ON public.students;
CREATE POLICY students_insert_in_scope ON public.students
FOR INSERT TO authenticated
WITH CHECK (public.student_in_scope(student_id) OR public.is_admin());

DROP POLICY IF EXISTS students_update_in_scope ON public.students;
CREATE POLICY students_update_in_scope ON public.students
FOR UPDATE TO authenticated
USING (public.student_in_scope(student_id))
WITH CHECK (public.student_in_scope(student_id));

DROP POLICY IF EXISTS students_delete_admin ON public.students;
CREATE POLICY students_delete_admin ON public.students
FOR DELETE TO authenticated
USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- 匯入 data.json 學生
-- -----------------------------------------------------------------------------
INSERT INTO public.students (student_id, name, iep_data, medical_notes) VALUES (
  'S001', 'Chan',
  '{"class":"1AC","grade":"S1","sen_category":"ADHD,ASD,MI","tier_support":"第二層支援","profile":"學生為中一新生，整體智力正常，適應中學生活期間表現出積極態度。唯因ADHD影響，學生喺課堂上較難長時間集中注意力，容易受周圍環境干擾，偶有遺漏作業或忘記帶書本嘅情況。社交方面性格開朗，但有時因衝動行為或未能細心聆聽他人說話而與同儕產生輕微摩擦。","goals":{"long":["自主學習與自我監控：建立自我監控專注力嘅習慣，能獨立完成至少30分鐘嘅家課學習時間。","社交與情緒調節：喺遭遇挫折或情緒高漲時，能運用適當嘅停頓策略（如深呼吸或向老師求助），建立良好嘅同儕關係。"],"mid":["執行功能：能獨立運用「顏色標籤/分類資料夾」整理個人書包及各科課本/工作紙，將遺漏功課嘅頻次減少至每週少於1次。","衝動控制：喺課堂回答問題或分組討論時，學習「先舉手、等叫名、再回答」，並能完整聆聽同學發言而不打斷。"],"short":["課堂專注：喺40分鐘嘅課堂內，能喺老師提示下維持至少20分鐘嘅專注力，減少離座及玩弄手邊物件嘅次數。","常規管理：學習使用手冊及手帳，每日自行記錄當天功課，並喺離校前由課堂/導師檢查。"]},"logs":["[2026/9/9 - 系統管理員] 上數學堂時經常出座","[2026/9/9 - cheng] VA課時玩筆，老師話佢，佢會發脾氣。"],"clinical_files":[],"accommodations":["抽離/特別試場：安排喺少人/安靜嘅試場進行考試，以減少環境干擾。","延長作答時間：各科筆試獲得 15% 嘅額外加時調適。","提示與提示卡：監考老師喺考試中段給予一次時間及專注力提示；允許使用空白草稿紙協助解題。","放大/特別試卷格式：行距加寬，方便閱讀及標記重點。"]}'::jsonb,
  ''
) ON CONFLICT (student_id) DO UPDATE SET name = EXCLUDED.name, iep_data = EXCLUDED.iep_data;

INSERT INTO public.students (student_id, name, iep_data, medical_notes) VALUES (
  'S002', 'Cheung',
  '{"class":"2HC","grade":"S2","sen_category":"ASD","tier_support":"第三層支援","profile":"","goals":{"long":[],"mid":[],"short":[]},"logs":[],"clinical_files":[]}'::jsonb,
  ''
) ON CONFLICT (student_id) DO UPDATE SET name = EXCLUDED.name, iep_data = EXCLUDED.iep_data;

INSERT INTO public.students (student_id, name, iep_data, medical_notes) VALUES (
  's003', 'lee',
  '{"class":"1dr","grade":"s1","sen_category":"MI","tier_support":"第三層支援","profile":"","goals":{"long":[],"mid":[],"short":[]},"accommodations":[],"logs":[],"clinical_files":[]}'::jsonb,
  ''
) ON CONFLICT (student_id) DO UPDATE SET name = EXCLUDED.name, iep_data = EXCLUDED.iep_data;

INSERT INTO public.students (student_id, name, iep_data, medical_notes) VALUES (
  'S00345', 'Ddd',
  '{"class":"1ss","grade":"S1","sen_category":"ASD,MI","tier_support":"第三層支援","profile":"","goals":{"short":[],"mid":[],"long":[]},"accommodations":[],"logs":[],"clinical_files":[]}'::jsonb,
  ''
) ON CONFLICT (student_id) DO UPDATE SET name = EXCLUDED.name, iep_data = EXCLUDED.iep_data;

-- 保留你已手動新增的 s001 陳小明（大小寫不同，不會被上面 S001 覆蓋）

-- -----------------------------------------------------------------------------
-- 匯入教師：只在 Authentication 已有對應 email 時寫入
-- 請先在 Auth 建立帳號（建議 Auto Confirm），email 如下：
--   admin  -> admin@iep.internal
--   chk    -> chk@iep.internal
--   HCY    -> hcy@iep.internal
--   CHH    -> chh@iep.internal
--   iep_fkyc 若已存在則只更新 scope／角色
-- 密碼不要寫進 SQL，只存在 Authentication。
-- -----------------------------------------------------------------------------
INSERT INTO public.teachers (id, username, email, name, role, role_desc, roles, homeroom_scope, case_scope, teacher_scope)
SELECT u.id, v.username, u.email, v.name, v.role, v.role_desc, v.roles::jsonb, v.homeroom_scope, v.case_scope, v.teacher_scope
FROM auth.users u
JOIN (VALUES
  ('admin@iep.internal', 'admin', '系統管理員', 'admin', '最高管理者', '["case","admin"]', '', 'all', ''),
  ('chk@iep.internal',   'chk',   'cheng',     'teacher', '',           '["case","teacher"]', '', 'S001', 's003'),
  ('hcy@iep.internal',   'HCY',   'Miss Ho',   'admin',   '',           '["teacher","admin"]', '', '', ''),
  ('chh@iep.internal',   'CHH',   'Mr CHEUNG', 'teacher', '',           '["case","teacher"]', '', 'S00345', '')
) AS v(email, username, name, role, role_desc, roles, homeroom_scope, case_scope, teacher_scope)
  ON lower(u.email) = lower(v.email)
ON CONFLICT (id) DO UPDATE SET
  username = EXCLUDED.username,
  name = EXCLUDED.name,
  role = EXCLUDED.role,
  role_desc = EXCLUDED.role_desc,
  roles = EXCLUDED.roles,
  homeroom_scope = EXCLUDED.homeroom_scope,
  case_scope = EXCLUDED.case_scope,
  teacher_scope = EXCLUDED.teacher_scope;

-- 驗收
SELECT student_id, name FROM public.students ORDER BY student_id;
SELECT username, email, roles, homeroom_scope, case_scope, teacher_scope FROM public.teachers;
