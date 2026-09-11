-- Storage：clinical-docs 私有 bucket + 依老師 Scope 的 RLS
-- 路徑格式：{studentId}/{filename}，與前端 index.html 一致
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('clinical-docs', 'clinical-docs', false, 10485760)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 10485760;

DROP POLICY IF EXISTS clinical_docs_select_scope ON storage.objects;
CREATE POLICY clinical_docs_select_scope ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'clinical-docs' AND public.student_in_scope(split_part(name, '/', 1)));

DROP POLICY IF EXISTS clinical_docs_insert_scope ON storage.objects;
CREATE POLICY clinical_docs_insert_scope ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'clinical-docs' AND public.student_in_scope(split_part(name, '/', 1)));

DROP POLICY IF EXISTS clinical_docs_update_scope ON storage.objects;
CREATE POLICY clinical_docs_update_scope ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'clinical-docs' AND public.student_in_scope(split_part(name, '/', 1)))
WITH CHECK (bucket_id = 'clinical-docs' AND public.student_in_scope(split_part(name, '/', 1)));

DROP POLICY IF EXISTS clinical_docs_delete_scope ON storage.objects;
CREATE POLICY clinical_docs_delete_scope ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'clinical-docs' AND public.student_in_scope(split_part(name, '/', 1)));
