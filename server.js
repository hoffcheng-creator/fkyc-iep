const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
(() => {
    const envDir = path.join(__dirname, '.env');
    try {
        if (!fs.existsSync(envDir) || !fs.statSync(envDir).isDirectory()) return;
        for (const name of fs.readdirSync(envDir)) {
            const key = name.replace(/\.txt$/i, '');
            if (!key || process.env[key]) continue;
            const val = fs.readFileSync(path.join(envDir, name), 'utf8').trim();
            if (val) process.env[key] = val;
        }
    } catch (err) {
        console.error('[BOOT] 讀取 .env 目錄失敗:', err.message);
    }
})();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const docx = require('docx');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = docx;
const storageLayer = require('./lib/storage');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(UPLOADS_DIR, 'temp');
const BCRYPT_SALT_ROUNDS = 10;
const ALLOWED_UPLOAD_EXT = new Set(['.pdf', '.docx', '.png', '.jpg']);

const JWT_SECRET = process.env.JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!JWT_SECRET || JWT_SECRET === 'super_secret_jwt_key_change_me_in_prod') {
    console.error('[BOOT] 請在 .env 設定高熵 JWT_SECRET，拒絕使用預設值。');
    process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[BOOT] 缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY。');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
});

function createAuthClient() {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false }
    });
}

function getGeminiModel() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    const genAI = new GoogleGenerativeAI(apiKey);
    return genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
}

fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(TEMP_DIR);

if (process.env.TRUST_PROXY === '1') {
    app.set('trust proxy', 1);
}

// ---------------------------------------------------------------------------
// 第二階段：HTTP 標頭防護 + 限流
// npm i helmet express-rate-limit
// ---------------------------------------------------------------------------
app.disable('x-powered-by');
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hidePoweredBy: true
}));
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(__dirname));

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: '請求過於頻繁，請稍後再試。' }
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    skip: (req, res) => res.statusCode >= 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: '登入嘗試過於頻繁，請稍後再試。' }
});

const aiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'AI 諮詢次數過於頻繁，請稍等一分鐘。' }
});

app.use('/api/', apiLimiter);

// ---------------------------------------------------------------------------
// 資料對應：Supabase rows <-> 前端既有 JSON 形狀
// ---------------------------------------------------------------------------
function parseScopes(scopeStr) {
    if (!scopeStr) return [];
    if (Array.isArray(scopeStr)) {
        return scopeStr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    }
    return String(scopeStr).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function isAdminUser(user) {
    if (!user) return false;
    const roles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : []);
    return roles.includes('admin') || user.role === 'admin';
}

function toFrontendUser(row) {
    if (!row) return null;
    const roles = Array.isArray(row.roles) ? row.roles : [];
    return {
        id: row.id,
        username: row.username,
        name: row.name,
        role: row.role || (roles.includes('admin') ? 'admin' : 'teacher'),
        role_desc: row.role_desc || '',
        roles,
        homeroom_scope: row.homeroom_scope || '',
        case_scope: row.case_scope || '',
        teacher_scope: row.teacher_scope || ''
    };
}

function toFrontendStudent(row) {
    if (!row) return null;
    const iep = row.iep_data && typeof row.iep_data === 'object' && !Array.isArray(row.iep_data)
        ? row.iep_data
        : {};
    return {
        ...iep,
        id: row.student_id,
        name: row.name,
        medical_notes: row.medical_notes || iep.medical_notes || ''
    };
}

function toDbStudent(student) {
    const studentId = student && (student.id || student.student_id);
    if (!studentId) return null;
    const clone = { ...student };
    delete clone.id;
    delete clone.student_id;
    const name = clone.name || '';
    delete clone.name;
    const medicalNotes = clone.medical_notes || '';
    delete clone.medical_notes;
    delete clone.password;
    return {
        student_id: String(studentId).trim(),
        name,
        medical_notes: medicalNotes,
        iep_data: clone
    };
}

function toDbProfile(user, fallbackId) {
    const roles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : ['teacher']);
    const id = String(user.id || user.username || fallbackId);
    const username = user.username || id;
    return {
        id,
        username,
        email: user.email || `${String(username).toLowerCase()}@iep.internal`,
        name: user.name || username,
        role: user.role || (roles.includes('admin') ? 'admin' : 'teacher'),
        role_desc: user.role_desc || '',
        roles,
        homeroom_scope: user.homeroom_scope || '',
        case_scope: user.case_scope || '',
        teacher_scope: user.teacher_scope || ''
    };
}

function caseManagerOf(studentRow) {
    if (!studentRow) return '';
    const iep = studentRow.iep_data || {};
    return String(iep.caseManager || studentRow.caseManager || '').trim();
}

function hasStudentAccess(profile, studentId, studentRow) {
    if (isAdminUser(profile)) return true;
    const allowedIds = new Set([
        ...parseScopes(profile.homeroom_scope),
        ...parseScopes(profile.case_scope),
        ...parseScopes(profile.teacher_scope)
    ]);
    if (allowedIds.has('all')) return true;
    const sid = String(studentId || '').trim().toLowerCase();
    if (sid && allowedIds.has(sid)) return true;
    const cm = caseManagerOf(studentRow);
    if (cm && profile.name && cm.toLowerCase() === String(profile.name).toLowerCase()) return true;
    return false;
}

function decodePathParam(value) {
    const raw = Array.isArray(value) ? value.join('/') : String(value || '');
    try {
        return decodeURIComponent(raw);
    } catch (err) {
        return raw;
    }
}

function extractStudentId(req) {
    const direct = req.params.studentId
        || (req.body && (req.body.studentId || req.body.id || req.body.student_id))
        || req.query.studentId
        || req.headers['x-student-id'];
    if (direct && String(direct).trim()) {
        return storageLayer.sanitizeSegment(direct);
    }

    const fileRef = decodePathParam(
        (req.body && (req.body.filePath || req.body.fileName))
        || req.params.filepath
        || (req.params && req.params[0])
    );
    if (!fileRef) return '';
    const parts = String(fileRef).replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length >= 2) return storageLayer.sanitizeSegment(parts[0]);
    return '';
}

async function fetchProfile(userHint) {
    if (!userHint) return null;
    if (userHint.id) {
        const byId = await supabase.from('profiles').select('*').eq('id', userHint.id).maybeSingle();
        if (byId.error) throw byId.error;
        if (byId.data) return byId.data;
    }
    if (userHint.username) {
        const byName = await supabase.from('profiles').select('*').eq('username', userHint.username).maybeSingle();
        if (byName.error) throw byName.error;
        if (byName.data) return byName.data;
    }
    if (userHint.auth_user_id) {
        const byAuth = await supabase.from('profiles').select('*').eq('auth_user_id', userHint.auth_user_id).maybeSingle();
        if (byAuth.error) throw byAuth.error;
        return byAuth.data || null;
    }
    return null;
}

async function fetchStudent(studentId) {
    if (!studentId) return null;
    const exact = await supabase.from('students').select('*').eq('student_id', studentId).maybeSingle();
    if (exact.error) throw exact.error;
    if (exact.data) return exact.data;
    const { data, error } = await supabase.from('students').select('*');
    if (error) throw error;
    const needle = String(studentId).trim().toLowerCase();
    return (data || []).find((s) => String(s.student_id).trim().toLowerCase() === needle) || null;
}

async function fetchAllStudents() {
    const { data, error } = await supabase.from('students').select('*').order('student_id');
    if (error) throw error;
    return data || [];
}

async function fetchAllProfiles() {
    const { data, error } = await supabase.from('profiles').select('*').order('username');
    if (error) throw error;
    return data || [];
}

async function fetchSystemLogs() {
    const { data, error } = await supabase.from('app_meta').select('system_logs').eq('id', 'default').maybeSingle();
    if (error) throw error;
    return Array.isArray(data && data.system_logs) ? data.system_logs : [];
}

function publicUserFromProfile(profile) {
    const frontend = toFrontendUser(profile);
    return {
        id: frontend.id,
        username: frontend.username,
        role: frontend.role,
        roles: frontend.roles,
        name: frontend.name,
        homeroom_scope: frontend.homeroom_scope,
        case_scope: frontend.case_scope,
        teacher_scope: frontend.teacher_scope
    };
}

function profileEmail(profile) {
    return profile.email || `${String(profile.username).toLowerCase()}@iep.internal`;
}

async function signInWithPassword(email, password) {
    const authClient = createAuthClient();
    return authClient.auth.signInWithPassword({ email, password });
}

async function bootstrapAuthUser(profile, password) {
    const email = profileEmail(profile);
    const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { username: profile.username, profile_id: profile.id }
    });
    if (!error && data && data.user) return data.user;

    const listed = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const existing = ((listed.data && listed.data.users) || []).find((u) =>
        String(u.email || '').toLowerCase() === String(email).toLowerCase()
    );
    if (existing) {
        await supabase.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
        return existing;
    }
    if (error) throw error;
    return null;
}

async function loginWithSupabase(profile, password) {
    const email = profileEmail(profile);
    let { data, error } = await signInWithPassword(email, password);

    if (error || !data || !data.session) {
        const hashOk = profile.password_hash
            && String(profile.password_hash).startsWith('$2')
            && await bcrypt.compare(password, profile.password_hash);
        if (!hashOk) return null;
        await bootstrapAuthUser(profile, password);
        ({ data, error } = await signInWithPassword(email, password));
    }

    if (error || !data || !data.session || !data.user) return null;

    const authUserId = data.user.id;
    await supabase.auth.admin.updateUserById(authUserId, {
        user_metadata: { username: profile.username, profile_id: profile.id }
    }).catch(() => {});
    await supabase.from('profiles').update({ email }).eq('id', profile.id).then(() => {}, () => {});

    return {
        accessToken: data.session.access_token,
        authUserId
    };
}

// ---------------------------------------------------------------------------
// 第二階段：核心安全中間件
// npm i @supabase/supabase-js jsonwebtoken
// ---------------------------------------------------------------------------
function getBearerToken(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || typeof authHeader !== 'string') return '';
    const parts = authHeader.split(' ');
    if (parts.length === 2 && /^Bearer$/i.test(parts[0])) return parts[1].trim();
    return '';
}

function denyScope(res) {
    return res.status(403).json({ success: false, message: '權限不足' });
}

function profileIsAdmin(profile) {
    if (!profile) return false;
    const roles = Array.isArray(profile.roles) ? profile.roles : [];
    return profile.role === 'admin' || roles.includes('admin');
}

function scopeAllowsStudent(profile, studentId) {
    if (!profile) return false;
    if (profileIsAdmin(profile)) return true;
    const sid = String(studentId || '').trim().toLowerCase();
    if (!sid) return false;
    const tokens = [
        ...parseScopes(profile.homeroom_scope),
        ...parseScopes(profile.case_scope),
        ...parseScopes(profile.teacher_scope)
    ];
    return tokens.includes('all') || tokens.includes(sid);
}

async function fetchProfileByUserId(userId) {
    if (!userId) return null;
    const byId = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (!byId.error && byId.data) return byId.data;
    return null;
}

/**
 * 從 Authorization: Bearer <token> 解析 Supabase Auth JWT 的 user_id。
 * 遷移期：若不是 GoTrue token，回退驗證既有 Express JWT。
 */
async function resolveAuthUser(req) {
    const token = getBearerToken(req);
    if (!token) return null;

    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data && data.user && data.user.id) {
        const meta = data.user.user_metadata || {};
        return {
            user_id: data.user.id,
            id: meta.profile_id || data.user.id,
            email: data.user.email || '',
            username: meta.username || '',
            source: 'supabase'
        };
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        return {
            user_id: payload.user_id || payload.sub || payload.id,
            id: payload.id,
            username: payload.username,
            email: payload.email,
            source: 'express'
        };
    } catch (err) {
        return null;
    }
}

async function authenticateToken(req, res, next) {
    try {
        const authUser = await resolveAuthUser(req);
        if (!authUser || !authUser.user_id) {
            return res.status(401).json({ success: false, message: '未提供認證 Token' });
        }
        req.user_id = authUser.user_id;
        req.user = authUser;
        next();
    } catch (err) {
        console.error('Auth Error:', err);
        return res.status(403).json({ success: false, message: 'Token 無效或已過期' });
    }
}

async function loadProfile(req, res, next) {
    try {
        let profile = await fetchProfileByUserId(req.user_id || (req.user && req.user.id));
        if (!profile && req.user) {
            profile = await fetchProfile(req.user);
        }
        if (!profile) {
            return res.status(403).json({ success: false, message: 'Token 無效或已過期' });
        }
        req.profile = profile;
        const fresh = publicUserFromProfile(profile);
        req.user = { ...req.user, ...fresh, user_id: req.user_id || profile.id, id: profile.id };
        next();
    } catch (err) {
        console.error('Load Profile Error:', err);
        res.status(500).json({ success: false, message: '讀取老師權限失敗' });
    }
}

/**
 * checkStudentScope
 * 1. 從 Supabase Auth JWT 解析 user_id
 * 2. 查 profiles，核對 homeroom_scope / case_scope / teacher_scope
 * 3. 不符則 403 { success: false, message: "權限不足" }
 *
 * 用法：
 *   app.get('/api/export-iep-word/:studentId', authenticateToken, checkStudentScope, handler)
 *   app.post('/api/upload-clinical-doc', authenticateToken, checkStudentScope, handler)
 */
async function checkStudentScope(req, res, next) {
    try {
        if (!req.user_id) {
            const authUser = await resolveAuthUser(req);
            if (!authUser || !authUser.user_id) {
                return denyScope(res);
            }
            req.user_id = authUser.user_id;
            req.user = { ...(req.user || {}), ...authUser };
        }

        let profile = req.profile;
        if (!profile) {
            profile = await fetchProfileByUserId(req.user_id);
            if (!profile && req.user) {
                profile = await fetchProfile(req.user);
            }
        }
        if (!profile) {
            return denyScope(res);
        }
        req.profile = profile;

        const studentId = extractStudentId(req);
        if (!studentId) {
            return denyScope(res);
        }

        if (!scopeAllowsStudent(profile, studentId)) {
            return denyScope(res);
        }

        const student = await fetchStudent(studentId);
        req.scopedStudentId = (student && student.student_id) || studentId;
        req.scopedStudent = student || null;
        next();
    } catch (err) {
        console.error('Scope Check Error:', err);
        return denyScope(res);
    }
}

/**
 * /api/sen-chat 相容層：正式契約是 { studentId, prompt }。
 * 現有前端仍可能只傳 studentContext.name（零改動），僅用姓名在 Scope 內對應，
 * 絕不採信前端送來的 IEP / 醫療欄位。
 */
async function prepareSenChatScope(req, res, next) {
    try {
        const prompt = req.body && req.body.prompt;
        if (!prompt || typeof prompt !== 'string') {
            return res.status(400).json({ success: false, message: '未提供問題' });
        }

        let studentId = storageLayer.sanitizeSegment(
            (req.body && (req.body.studentId || req.body.student_id)) || ''
        );

        if (!studentId) {
            const hintedName = req.body && req.body.studentContext && req.body.studentContext.name;
            if (hintedName && req.profile) {
                const all = await fetchAllStudents();
                const needle = String(hintedName).trim().toLowerCase();
                const matches = all.filter((row) =>
                    scopeAllowsStudent(req.profile, row.student_id)
                    && String(row.name || '').trim().toLowerCase() === needle
                );
                if (matches.length === 1) {
                    studentId = matches[0].student_id;
                }
            }
        }

        if (req.body) {
            delete req.body.studentContext;
        }

        if (!studentId) {
            req.scopedStudent = null;
            req.scopedStudentId = null;
            return next();
        }

        req.body.studentId = studentId;
        return checkStudentScope(req, res, next);
    } catch (err) {
        console.error('SEN Chat Scope Error:', err);
        return denyScope(res);
    }
}

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, TEMP_DIR),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').toLowerCase();
            const base = path.basename(file.originalname || 'file', ext).replace(/[^a-zA-Z0-9_-]/g, '');
            cb(null, `${Date.now()}_${base || 'file'}${ext}`);
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (!ALLOWED_UPLOAD_EXT.has(ext)) {
            return cb(new Error('不支援的檔案類型'));
        }
        cb(null, true);
    }
});

// ---------------------------------------------------------------------------
// 1. 使用者登入（supabase.auth.signInWithPassword）
//    前端仍傳 { username, password }，成功回 { success, token, user }
// ---------------------------------------------------------------------------
app.post('/api/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
        }

        const { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('username', String(username).trim())
            .maybeSingle();

        if (error) throw error;
        if (!profile) {
            return res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
        }

        const session = await loginWithSupabase(profile, password);
        if (!session) {
            return res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
        }

        let freshProfile = await fetchProfileByUserId(session.authUserId);
        if (!freshProfile) {
            freshProfile = await fetchProfile({ id: profile.id, username: profile.username });
        }
        if (!freshProfile) {
            return res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
        }

        const tokenPayload = publicUserFromProfile(freshProfile);
        res.json({ success: true, token: session.accessToken, user: tokenPayload });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ success: false, message: '伺服器處理登入時發生錯誤' });
    }
});

// ---------------------------------------------------------------------------
// 2. 獲取系統資料
// ---------------------------------------------------------------------------
app.get('/api/get-all-data', authenticateToken, loadProfile, async (req, res) => {
    try {
        const [profileRows, studentRows, systemLogs] = await Promise.all([
            fetchAllProfiles(),
            fetchAllStudents(),
            fetchSystemLogs()
        ]);

        if (isAdminUser(req.profile)) {
            return res.json({
                users: profileRows.map(toFrontendUser),
                students: studentRows.map(toFrontendStudent),
                systemLogs
            });
        }

        const accessibleStudents = studentRows
            .filter((row) => hasStudentAccess(req.profile, row.student_id, row))
            .map(toFrontendStudent);

        res.json({ users: [], students: accessibleStudents, systemLogs: [] });
    } catch (err) {
        console.error('Get All Data Error:', err);
        res.status(500).json({ success: false, message: '讀取資料失敗' });
    }
});

// ---------------------------------------------------------------------------
// 3. 儲存全系統資料
// ---------------------------------------------------------------------------
app.post('/api/save-all-data', authenticateToken, loadProfile, async (req, res) => {
    try {
        const { students, users, systemLogs } = req.body || {};

        if (isAdminUser(req.profile)) {
            if (Array.isArray(students)) {
                const incoming = students.map(toDbStudent).filter(Boolean);
                const incomingIds = incoming.map((s) => s.student_id);
                const existing = await fetchAllStudents();
                const toDelete = existing
                    .map((s) => s.student_id)
                    .filter((id) => !incomingIds.includes(id));

                if (incoming.length) {
                    const { error } = await supabase.from('students').upsert(incoming, { onConflict: 'student_id' });
                    if (error) throw error;
                }
                if (toDelete.length) {
                    const { error } = await supabase.from('students').delete().in('student_id', toDelete);
                    if (error) throw error;
                }
                if (!incoming.length && existing.length) {
                    const { error } = await supabase.from('students').delete().neq('student_id', '');
                    if (error) throw error;
                }
            }

            if (Array.isArray(systemLogs)) {
                const { error } = await supabase.from('app_meta').upsert({
                    id: 'default',
                    system_logs: systemLogs
                }, { onConflict: 'id' });
                if (error) throw error;
            }

            if (Array.isArray(users)) {
                const existingProfiles = await fetchAllProfiles();
                const existingByKey = new Map();
                existingProfiles.forEach((p) => {
                    existingByKey.set(p.id, p);
                    if (p.username) existingByKey.set(`u:${p.username}`, p);
                });

                const merged = [];
                for (let i = 0; i < users.length; i += 1) {
                    const newUser = users[i];
                    const existing = (newUser.id && existingByKey.get(newUser.id))
                        || (newUser.username && existingByKey.get(`u:${newUser.username}`))
                        || null;
                    const row = toDbProfile(newUser, existing ? existing.id : `U${Date.now()}_${i}`);

                    if (newUser.password && String(newUser.password).trim() !== '') {
                        if (!String(newUser.password).startsWith('$2')) {
                            row.password_hash = await bcrypt.hash(newUser.password, BCRYPT_SALT_ROUNDS);
                        } else {
                            row.password_hash = newUser.password;
                        }
                    } else if (existing && existing.password_hash) {
                        row.password_hash = existing.password_hash;
                    }

                    if (existing && existing.auth_user_id) {
                        row.auth_user_id = existing.auth_user_id;
                    }
                    if (!row.password_hash) delete row.password_hash;
                    merged.push(row);
                }

                if (merged.length) {
                    const { error } = await supabase.from('profiles').upsert(merged, { onConflict: 'id' });
                    if (error) throw error;
                }

                const keepIds = new Set(merged.map((p) => p.id));
                const stale = existingProfiles.filter((p) => !keepIds.has(p.id) && p.id !== req.profile.id);
                if (stale.length) {
                    const { error } = await supabase.from('profiles').delete().in('id', stale.map((p) => p.id));
                    if (error) throw error;
                }
            }
        } else if (Array.isArray(students)) {
            const existing = await fetchAllStudents();
            const existingMap = new Map(existing.map((s) => [String(s.student_id).trim().toLowerCase(), s]));
            const allowed = [];

            for (const incomingStudent of students) {
                const row = toDbStudent(incomingStudent);
                if (!row) continue;
                const key = String(row.student_id).trim().toLowerCase();
                const existingRow = existingMap.get(key) || null;
                if (hasStudentAccess(req.profile, row.student_id, existingRow || row)) {
                    allowed.push(row);
                }
            }

            if (allowed.length) {
                const { error } = await supabase.from('students').upsert(allowed, { onConflict: 'student_id' });
                if (error) throw error;
            }
        }

        res.json({ success: true, message: '資料儲存成功' });
    } catch (err) {
        console.error('Save All Data Error:', err);
        res.status(500).json({ success: false, message: '儲存資料失敗' });
    }
});

// ---------------------------------------------------------------------------
// 4. 上傳醫療文件  POST /api/upload-clinical-doc
//    multipart 先解析（才有 studentId），再掛 checkStudentScope
// ---------------------------------------------------------------------------
function parseClinicalMultipart(req, res, next) {
    upload.any()(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            console.error('Multer Upload Error:', err);
            return res.status(400).json({ success: false, message: `檔案上傳失敗: ${err.message}` });
        }
        if (err) {
            console.error('Server Upload Error:', err);
            const msg = err.message === '不支援的檔案類型' ? err.message : '伺服器處理上傳時發生錯誤';
            return res.status(400).json({ success: false, message: msg });
        }
        const uploadedFile = (req.files && req.files[0]) || req.file || null;
        req.uploadedFile = uploadedFile;
        if (!uploadedFile) {
            return res.status(400).json({ success: false, message: '未提供檔案' });
        }
        next();
    });
}

function cleanupTempOnDeny(req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = function jsonWithCleanup(body) {
        if (res.statusCode === 403 && req.uploadedFile && req.uploadedFile.path) {
            fs.remove(req.uploadedFile.path).catch(() => {});
        }
        return originalJson(body);
    };
    next();
}

app.post(
    '/api/upload-clinical-doc',
    authenticateToken,
    loadProfile,
    parseClinicalMultipart,
    cleanupTempOnDeny,
    checkStudentScope,
    async (req, res) => {
        const uploadedFile = req.uploadedFile;
        const studentId = req.scopedStudentId;
        const safeName = path.basename(uploadedFile.filename);
        const ext = path.extname(safeName).toLowerCase();

        if (!ALLOWED_UPLOAD_EXT.has(ext)) {
            await fs.remove(uploadedFile.path).catch(() => {});
            return res.status(400).json({ success: false, message: '不支援的檔案類型' });
        }

        try {
            const driver = storageLayer.getDriver();
            let relativePath;

            if (driver === 'supabase') {
                // 寫法 B：Supabase Storage bucket `clinical-docs`
                const stored = await storageLayer.saveToSupabase(
                    supabase,
                    studentId,
                    safeName,
                    uploadedFile.path,
                    uploadedFile.mimetype
                );
                relativePath = stored.relativePath;
                await fs.remove(uploadedFile.path).catch(() => {});
            } else {
                // 寫法 A：本地 ./uploads/{studentId}/{filename}（multer temp → move）
                const stored = await storageLayer.saveToLocal(
                    UPLOADS_DIR,
                    studentId,
                    safeName,
                    uploadedFile.path
                );
                relativePath = stored.relativePath;

                if (driver === 'dual') {
                    try {
                        await storageLayer.saveToSupabase(
                            supabase,
                            studentId,
                            safeName,
                            stored.localPath,
                            uploadedFile.mimetype
                        );
                    } catch (syncErr) {
                        console.error('[storage] dual-write to clinical-docs failed:', syncErr.message || syncErr);
                    }
                }
            }

            res.json({
                success: true,
                filePath: relativePath,
                fileName: relativePath
            });
        } catch (moveErr) {
            await fs.remove(uploadedFile.path).catch(() => {});
            console.error('Move File Error:', moveErr);
            res.status(500).json({ success: false, message: '檔案歸檔至學生資料夾時失敗' });
        }
    }
);

// ---------------------------------------------------------------------------
// 5. 匯出完整 Word (.docx)
//    先 checkStudentScope，通過後才向 Supabase students 撈 IEP
// ---------------------------------------------------------------------------
app.get('/api/export-iep-word/:studentId', authenticateToken, loadProfile, checkStudentScope, async (req, res) => {
    try {
        const studentId = req.scopedStudentId || req.params.studentId;
        const { data: row, error } = await supabase
            .from('students')
            .select('student_id, name, iep_data, medical_notes')
            .eq('student_id', studentId)
            .maybeSingle();
        if (error) throw error;

        const student = toFrontendStudent(row);
        if (!student) {
            return res.status(404).json({ success: false, message: '找不到該學生資料' });
        }

        const goalsShort = (student.goals && student.goals.short) || [];
        const goalsMid = (student.goals && student.goals.mid) || [];
        const goalsLong = (student.goals && student.goals.long) || [];
        const groupActivities = student.group_activities || [];
        const accommodations = student.accommodations || [];
        const logs = student.logs || [];
        const iepReview = student.iep_review_report || '';

        let docsList = [];
        if (Array.isArray(student.clinical_files)) {
            docsList = student.clinical_files;
        } else if (Array.isArray(student.clinicalDocs)) {
            docsList = student.clinicalDocs;
        } else if (student.docPath) {
            docsList = [student.docPath];
        }

        const doc = new Document({
            sections: [{
                properties: {},
                children: [
                    new Paragraph({
                        text: '粉嶺救恩書院 Fanling Kau Yan College',
                        alignment: AlignmentType.CENTER,
                        heading: HeadingLevel.TITLE
                    }),
                    new Paragraph({
                        text: '個別學習計劃 (IEP) 完整報告',
                        alignment: AlignmentType.CENTER,
                        heading: HeadingLevel.HEADING_2,
                        space: { after: 300 }
                    }),

                    new Paragraph({ text: '一、 學生基本資料', heading: HeadingLevel.HEADING_2, space: { before: 200, after: 100 } }),
                    new Paragraph({ children: [new TextRun({ text: '學生姓名：', bold: true }), new TextRun(student.name || 'N/A')] }),
                    new Paragraph({ children: [new TextRun({ text: '學生編號：', bold: true }), new TextRun(student.id || 'N/A')] }),
                    new Paragraph({ children: [new TextRun({ text: '班別：', bold: true }), new TextRun(student.class || 'N/A')] }),
                    new Paragraph({ children: [new TextRun({ text: '出生日期：', bold: true }), new TextRun(student.birthday || '未填寫')] }),
                    new Paragraph({ children: [new TextRun({ text: '特殊需要分類：', bold: true }), new TextRun(student.sen_category || '無')] }),
                    new Paragraph({ children: [new TextRun({ text: '支援層級：', bold: true }), new TextRun(student.tier_support || '第二層支援')] }),
                    new Paragraph({ children: [new TextRun({ text: '簡介描述：', bold: true }), new TextRun(student.profile || '無')] }),

                    new Paragraph({ text: '二、 個別學習計劃 (IEP) 目標', heading: HeadingLevel.HEADING_2, space: { before: 300, after: 100 } }),
                    new Paragraph({ text: '短期目標：', bold: true }),
                    ...(goalsShort.length > 0 ? goalsShort.map((g) => new Paragraph({ text: `• ${g}`, bullet: { level: 0 } })) : [new Paragraph({ text: '（暫無）' })]),
                    new Paragraph({ text: '中期目標：', bold: true, space: { before: 100 } }),
                    ...(goalsMid.length > 0 ? goalsMid.map((g) => new Paragraph({ text: `• ${g}`, bullet: { level: 0 } })) : [new Paragraph({ text: '（暫無）' })]),
                    new Paragraph({ text: '長期目標：', bold: true, space: { before: 100 } }),
                    ...(goalsLong.length > 0 ? goalsLong.map((g) => new Paragraph({ text: `• ${g}`, bullet: { level: 0 } })) : [new Paragraph({ text: '（暫無）' })]),

                    new Paragraph({ text: '三、 小組支援活動紀錄', heading: HeadingLevel.HEADING_2, space: { before: 300, after: 100 } }),
                    ...(Array.isArray(groupActivities) && groupActivities.length > 0
                        ? groupActivities.map((act) => new Paragraph({ text: `• ${act}`, bullet: { level: 0 } }))
                        : [new Paragraph({ text: typeof groupActivities === 'string' && groupActivities ? groupActivities : '（暫無小組支援活動紀錄）' })]),

                    new Paragraph({ text: '四、 評估及考試調適安排', heading: HeadingLevel.HEADING_2, space: { before: 300, after: 100 } }),
                    ...(accommodations.length > 0 ? accommodations.map((a) => new Paragraph({ text: `• ${a}`, bullet: { level: 0 } })) : [new Paragraph({ text: '（暫無特別調適）' })]),

                    new Paragraph({ text: '五、 課堂觀測與追蹤日誌', heading: HeadingLevel.HEADING_2, space: { before: 300, after: 100 } }),
                    ...(logs.length > 0 ? logs.map((l) => new Paragraph({ text: `• ${l}` })) : [new Paragraph({ text: '（暫無日誌紀錄）' })]),

                    new Paragraph({ text: '六、 IEP 檢討報告', heading: HeadingLevel.HEADING_2, space: { before: 300, after: 100 } }),
                    new Paragraph({ text: iepReview || '（暫無檢討報告）' }),

                    new Paragraph({ text: '七、 醫療證明 / 專家評估信件清單', heading: HeadingLevel.HEADING_2, space: { before: 300, after: 100 } }),
                    ...(docsList.length > 0 ? docsList.map((f, idx) => {
                        const fileName = typeof f === 'object' ? (f.fileName || f.filePath) : f;
                        return new Paragraph({ text: `[文件 ${idx + 1}] ${fileName}` });
                    }) : [new Paragraph({ text: '（暫無上傳文件）' })]),

                    new Paragraph({ text: '\n\n' }),
                    new Paragraph({ text: '特教統籌主任 (SENCO) 簽署：____________________', space: { before: 400 } }),
                    new Paragraph({ text: '個案負責老師 / 班主任簽署：____________________', space: { before: 200 } }),
                    new Paragraph({ text: '日期：____________________    校印：____________________', space: { before: 200 } })
                ]
            }]
        });

        const buffer = await Packer.toBuffer(doc);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="IEP_${student.id || 'report'}.docx"`);
        res.send(buffer);
    } catch (err) {
        console.error('Export Word Error:', err);
        res.status(500).json({ success: false, message: '匯出 Word 失敗' });
    }
});

// ---------------------------------------------------------------------------
// 6. 下載檔案
// ---------------------------------------------------------------------------
app.get('/api/files/*filepath', authenticateToken, loadProfile, checkStudentScope, async (req, res) => {
    try {
        const relativePath = req.params.filepath || req.params[0];
        if (!relativePath) return res.status(400).json({ success: false, message: '未指定檔案路徑' });

        const decoded = decodePathParam(relativePath);
        const parts = decoded.replace(/\\/g, '/').split('/').filter(Boolean)
            .map((seg) => storageLayer.sanitizeSegment(seg))
            .filter(Boolean);
        if (parts.length >= 2 && req.scopedStudentId
            && parts[0].toLowerCase() !== String(req.scopedStudentId).toLowerCase()) {
            return res.status(403).json({ success: false, message: '無權存取該學生資料' });
        }
        const file = await storageLayer.readClinicalDoc({
            uploadsDir: UPLOADS_DIR,
            supabase,
            relativePath: decoded
        });

        if (!file) {
            return res.status(404).json({ success: false, message: '檔案不存在' });
        }

        if (file.localPath) {
            return res.sendFile(file.localPath);
        }

        const downloadName = path.basename(decoded);
        res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
        res.send(file.buffer);
    } catch (err) {
        if (err.code === 'PATH_TRAVERSAL' || err.code === 'EMPTY_PATH') {
            return res.status(403).json({ success: false, message: '非法檔案路徑' });
        }
        console.error('Read File Error:', err);
        res.status(500).json({ success: false, message: '讀取檔案失敗' });
    }
});

// ---------------------------------------------------------------------------
// 7. 刪除檔案
//    前端現有契約為 POST；同時提供 DELETE（第四階段規格）
//    檔名一律 path.basename()，只允許刪 {scopedStudentId}/{basename}
// ---------------------------------------------------------------------------
async function deletePhysicalFileHandler(req, res) {
    try {
        const rawFileName = (req.body && (req.body.filePath || req.body.fileName))
            || req.query.filePath
            || req.query.fileName;
        if (!rawFileName) return res.status(400).json({ success: false, message: '未指定檔案' });

        const studentId = req.scopedStudentId || extractStudentId(req);
        const safeName = path.basename(String(rawFileName).replace(/\\/g, '/'));
        if (!safeName || safeName === '.' || safeName === '..') {
            return res.status(403).json({ success: false, message: '非法檔案路徑' });
        }

        const relativePath = `${studentId}/${safeName}`;
        const driver = storageLayer.getDriver();
        let removed = false;

        if (driver === 'local' || driver === 'dual') {
            // 寫法 A：本地 ./uploads/
            removed = (await storageLayer.deleteFromLocal(UPLOADS_DIR, relativePath)) || removed;
        }
        if (driver === 'supabase' || driver === 'dual') {
            // 寫法 B：Supabase Storage `clinical-docs`
            try {
                await storageLayer.deleteFromSupabase(supabase, relativePath);
                removed = true;
            } catch (storageErr) {
                if (driver === 'supabase') throw storageErr;
                console.error('[storage] dual-delete from clinical-docs failed:', storageErr.message || storageErr);
            }
        }

        if (!removed) {
            return res.status(404).json({ success: false, message: '找不到該檔案' });
        }
        return res.json({ success: true, message: '檔案已刪除' });
    } catch (err) {
        if (err.code === 'PATH_TRAVERSAL' || err.code === 'EMPTY_PATH') {
            return res.status(403).json({ success: false, message: '非法檔案路徑' });
        }
        console.error('Delete File Error:', err);
        res.status(500).json({ success: false, message: '刪除失敗' });
    }
}

app.post('/api/delete-physical-file', authenticateToken, loadProfile, checkStudentScope, deletePhysicalFileHandler);
app.delete('/api/delete-physical-file', authenticateToken, loadProfile, checkStudentScope, deletePhysicalFileHandler);

// ---------------------------------------------------------------------------
// 8. AI 諮詢：{ studentId, prompt } → checkStudentScope → students 完整 Context → Gemini
//    回傳維持 { success: true, reply }
// ---------------------------------------------------------------------------
app.post('/api/sen-chat', authenticateToken, loadProfile, aiLimiter, prepareSenChatScope, async (req, res) => {
    const { prompt } = req.body || {};
    const model = getGeminiModel();

    if (!model) return res.status(500).json({ success: false, message: '伺服器未設定 Gemini API Key' });

    try {
        let studentRow = req.scopedStudent || null;
        if (!studentRow && req.scopedStudentId) {
            studentRow = await fetchStudent(req.scopedStudentId);
        }
        if (!studentRow && req.body && req.body.studentId) {
            if (!scopeAllowsStudent(req.profile, req.body.studentId)) {
                return denyScope(res);
            }
            const { data, error } = await supabase
                .from('students')
                .select('student_id, name, iep_data, medical_notes')
                .eq('student_id', req.body.studentId)
                .maybeSingle();
            if (error) throw error;
            studentRow = data;
        }

        const trustedContext = studentRow ? toFrontendStudent(studentRow) : {};

        const systemInstruction = `你是一位專業的特教(SEN)專家顧問。請根據以下學生的Context資料回答問題。
        學生 Context: ${JSON.stringify(trustedContext || {})}
        回答原則：專業、具體可行、嚴謹保護隱私。`;

        const result = await model.generateContent(systemInstruction + '\n\n問題: ' + prompt);
        const response = await result.response;

        res.json({ success: true, reply: response.text() });
    } catch (err) {
        console.error('Gemini API Error:', err);
        res.status(500).json({ success: false, message: 'AI 服務呼叫失敗' });
    }
});

app.listen(PORT, () => {
    console.log(`[SECURE SERVER] 伺服器已成功啟動：http://localhost:${PORT}`);
    console.log(`[SECURE SERVER] storage driver = ${storageLayer.getDriver()}`);
});
