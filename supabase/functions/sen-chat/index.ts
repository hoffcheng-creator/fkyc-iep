import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function flattenStudent(row: Record<string, unknown> | null) {
  if (!row) return {};
  const iep = (row.iep_data && typeof row.iep_data === 'object') ? row.iep_data as Record<string, unknown> : {};
  return {
    ...iep,
    id: row.student_id,
    name: row.name,
    medical_notes: row.medical_notes || '',
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return json({ success: false, message: '未登入' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '';
    if (!supabaseUrl || !serviceKey) {
      return json({ success: false, message: 'Function 缺少 SUPABASE_URL / SERVICE_ROLE' }, 500);
    }
    // Never fall back to service_role for student reads — that bypasses RLS.
    if (!anonKey) {
      return json({ success: false, message: 'Function 缺少 SUPABASE_ANON_KEY（學生讀取必須受 RLS 約束）' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData.user) {
      return json({ success: false, message: 'Token 無效或已過期' }, 401);
    }

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : '';
    if (!prompt) return json({ success: false, message: '未提供問題' }, 400);

    let trustedContext: Record<string, unknown> = {};
    if (studentId) {
      const userClient = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: 'Bearer ' + token } },
      });
      const { data: student, error: stErr } = await userClient
        .from('students')
        .select('student_id, name, iep_data, medical_notes')
        .eq('student_id', studentId)
        .maybeSingle();
      if (stErr) {
        return json({ success: false, message: '讀取學生失敗：' + stErr.message }, 200);
      }
      if (!student) {
        return json({ success: false, message: '權限不足或找不到該學生' }, 200);
      }
      trustedContext = flattenStudent(student);
    }

    const apiKey = String(Deno.env.get('GEMINI_API_KEY') || Deno.env.get('AI_API_KEY') || '')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/^['"]+|['"]+$/g, '')
      .trim();
    if (!apiKey) {
      return json({ success: false, message: '伺服器未設定 Gemini API Key' }, 200);
    }

    const systemInstruction = `你是一位專業的特教(SEN)專家顧問。請根據以下學生的Context資料回答問題。
        學生 Context: ${JSON.stringify(trustedContext || {})}
        回答原則：專業、具體可行、嚴謹保護隱私。`;

    const models = ['gemini-3.8-flash', 'gemini-3.6-flash'];
    let reply = '';
    let lastMsg = '';
    const promptText = systemInstruction + '\n\n問題: ' + prompt;

    for (const model of models) {
      const aiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
          }),
        },
      );
      const aiJson = await aiRes.json();
      reply = aiJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (reply) break;
      lastMsg = aiJson?.error?.message || JSON.stringify(aiJson).slice(0, 300);
    }

    if (!reply) {
      const interRes = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          model: models[0],
          input: promptText,
        }),
      });
      const interJson = await interRes.json();
      reply = interJson?.output_text
        || interJson?.outputs?.[0]?.text
        || interJson?.candidates?.[0]?.content?.parts?.[0]?.text
        || '';
      if (!reply) {
        lastMsg = interJson?.error?.message || lastMsg || JSON.stringify(interJson).slice(0, 300);
      }
    }
    if (!reply) {
      return json({ success: false, message: 'AI 服務呼叫失敗：' + lastMsg }, 200);
    }
    return json({ success: true, reply });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err);
    return json({ success: false, message: 'AI 服務呼叫失敗：' + msg }, 200);
  }
});