/**
 * 將既有 data.json 匯入 Supabase profiles / students / app_meta。
 * 用法：在專案根目錄執行  node scripts/migrate-from-data-json.js
 *
 * 密碼：只遷移 bcrypt hash 到 profiles.password_hash。
 * 無法從 hash 還原明文，因此不會建立 auth.users；
 * 使用者第一次成功登入時，server.js 會 lazy 綁定 GoTrue 帳號。
 */
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
(() => {
    const envDir = path.join(__dirname, '..', '.env');
    try {
        if (!fs.existsSync(envDir) || !fs.statSync(envDir).isDirectory()) return;
        for (const name of fs.readdirSync(envDir)) {
            const key = name.replace(/\.txt$/i, '');
            if (!key || process.env[key]) continue;
            const val = fs.readFileSync(path.join(envDir, name), 'utf8').trim();
            if (val) process.env[key] = val;
        }
    } catch (err) {
        console.error('讀取 .env 目錄失敗:', err.message);
    }
})();
const { createClient } = require('@supabase/supabase-js');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

function toDbStudent(student) {
    const studentId = student.id || student.student_id;
    const { id, student_id, name, medical_notes, password, ...iep } = student;
    return {
        student_id: studentId,
        name: name || '',
        medical_notes: medical_notes || '',
        iep_data: iep
    };
}

function toDbProfile(user, index) {
    const roles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : ['teacher']);
    const id = user.id || user.username || `U${String(index + 1).padStart(3, '0')}`;
    const username = user.username || id;
    return {
        id: String(id),
        username,
        email: user.email || `${String(username).toLowerCase()}@iep.internal`,
        name: user.name || username,
        role: user.role || (roles.includes('admin') ? 'admin' : 'teacher'),
        role_desc: user.role_desc || '',
        roles,
        homeroom_scope: user.homeroom_scope || '',
        case_scope: user.case_scope || '',
        teacher_scope: user.teacher_scope || '',
        password_hash: user.password && String(user.password).startsWith('$2') ? user.password : null
    };
}

async function main() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        console.error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY，請先填寫 .env');
        process.exit(1);
    }
    if (!await fs.pathExists(DATA_FILE)) {
        console.error('找不到 data.json');
        process.exit(1);
    }

    const db = await fs.readJson(DATA_FILE);
    const supabase = createClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false }
    });

    const profiles = (db.users || []).map(toDbProfile);
    const students = (db.students || []).map(toDbStudent).filter((s) => s.student_id);

    if (profiles.length) {
        const { error } = await supabase.from('profiles').upsert(profiles, { onConflict: 'id' });
        if (error) throw error;
        console.log(`profiles upserted: ${profiles.length}`);
    }

    if (students.length) {
        const { error } = await supabase.from('students').upsert(students, { onConflict: 'student_id' });
        if (error) throw error;
        console.log(`students upserted: ${students.length}`);
    }

    const { error: metaErr } = await supabase.from('app_meta').upsert({
        id: 'default',
        system_logs: Array.isArray(db.systemLogs) ? db.systemLogs : []
    }, { onConflict: 'id' });
    if (metaErr) throw metaErr;
    console.log('app_meta.system_logs upserted');

    console.log('遷移完成。請確認 sql/schema.sql 已在 Supabase SQL Editor 執行。');
}

main().catch((err) => {
    console.error('遷移失敗:', err);
    process.exit(1);
});
