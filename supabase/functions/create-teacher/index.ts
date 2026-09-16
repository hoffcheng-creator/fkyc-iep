import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function isPrivilegedAdmin(role: unknown, roles: unknown): boolean {
  const list = Array.isArray(roles) ? roles.map(String) : [];
  const primary = String(role || '');
  return primary === 'admin' || primary === 'senco' || list.includes('admin') || list.includes('senco');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ success: false, message: '未登入' }, 401);

    const url = Deno.env.get('SUPABASE_URL') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData.user) return json({ success: false, message: 'Token 無效' }, 401);

    const { data: me } = await admin.from('teachers').select('role, roles').eq('id', userData.user.id).maybeSingle();
    if (!isPrivilegedAdmin(me?.role, me?.roles)) {
      return json({ success: false, message: '只有管理員可以新增教職員' }, 403);
    }

    const body = await req.json();
    const name = String(body.name || '').trim();
    const username = String(body.username || '').trim();
    const password = String(body.password || '').trim();
    const roleDesc = String(body.role_desc || '').trim();
    const selectedRoles = Array.isArray(body.roles) ? body.roles.map(String) : [];
    const homeroom_scope = String(body.homeroom_scope || '').trim();
    const case_scope = String(body.case_scope || '').trim();
    const teacher_scope = String(body.teacher_scope || '').trim();

    if (!name || !username || !password) {
      return json({ success: false, message: '請填寫姓名、帳號與密碼' });
    }
    if (password.length < 6) {
      return json({ success: false, message: '密碼至少 6 個字元' });
    }

    const email = username.includes('@') ? username : `${username}@fkyc.edu.hk`;
    const role = (selectedRoles.includes('admin') || selectedRoles.includes('senco'))
      ? (selectedRoles.includes('admin') ? 'admin' : 'senco')
      : 'teacher';

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username, name, roles: selectedRoles },
    });

    let userId = created?.user?.id || '';
    if (createErr) {
      const msg = createErr.message || '';
      if (/already|registered|exists/i.test(msg)) {
        const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const existing = (listed.data?.users || []).find((u) =>
          String(u.email || '').toLowerCase() === email.toLowerCase()
        );
        if (!existing) return json({ success: false, message: '帳號已存在但找不到對應 Auth 使用者' });
        userId = existing.id;
        await admin.auth.admin.updateUserById(userId, { password, email_confirm: true });
      } else {
        return json({ success: false, message: '建立登入帳號失敗：' + msg });
      }
    }

    const row = {
      id: userId,
      username,
      email,
      name,
      role,
      role_desc: roleDesc,
      roles: selectedRoles,
      homeroom_scope,
      case_scope,
      teacher_scope,
    };
    const { error: upsertErr } = await admin.from('teachers').upsert(row, { onConflict: 'id' });
    if (upsertErr) return json({ success: false, message: '寫入 teachers 失敗：' + upsertErr.message });

    return json({ success: true, teacher: row });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ success: false, message: msg });
  }
});