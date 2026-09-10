/**
 * 醫療評估檔案儲存層
 *
 * STORAGE_DRIVER=local     寫法 A：伺服器本地 ./uploads/{studentId}/{filename}
 * STORAGE_DRIVER=supabase  寫法 B：Supabase Storage bucket `clinical-docs`
 * STORAGE_DRIVER=dual      遷移期雙寫：先本地，再同步 bucket
 *
 * 對外契約不變：filePath / fileName 皆為 "{studentId}/{filename}"
 */
const fs = require('fs-extra');
const path = require('path');

const BUCKET = 'clinical-docs';

function getDriver() {
    const raw = String(process.env.STORAGE_DRIVER || 'local').trim().toLowerCase();
    if (raw === 'supabase' || raw === 'dual' || raw === 'local') return raw;
    return 'local';
}

function sanitizeSegment(value) {
    const base = path.basename(String(value || ''));
    if (!base || base === '.' || base === '..') return '';
    return base.replace(/[^a-zA-Z0-9._-]/g, '');
}

function toRelativePath(studentId, filename) {
    return `${sanitizeSegment(studentId)}/${sanitizeSegment(filename)}`;
}

function resolveLocalPath(uploadsDir, relativePath) {
    const raw = String(relativePath || '').replace(/\\/g, '/');
    const segments = raw.split('/').filter(Boolean).map((seg) => sanitizeSegment(seg)).filter(Boolean);
    if (segments.length === 0) {
        const err = new Error('empty_path');
        err.code = 'EMPTY_PATH';
        throw err;
    }
    const root = path.resolve(uploadsDir);
    const resolved = path.resolve(root, ...segments);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        const err = new Error('path_traversal');
        err.code = 'PATH_TRAVERSAL';
        throw err;
    }
    return resolved;
}

// ----- 寫法 A：本地磁碟 -----
async function saveToLocal(uploadsDir, studentId, filename, sourcePath) {
    const relativePath = toRelativePath(studentId, filename);
    const finalPath = resolveLocalPath(uploadsDir, relativePath);
    await fs.ensureDir(path.dirname(finalPath));
    await fs.move(sourcePath, finalPath, { overwrite: true });
    return { relativePath, localPath: finalPath };
}

async function readFromLocal(uploadsDir, relativePath) {
    const localPath = resolveLocalPath(uploadsDir, relativePath);
    if (!await fs.pathExists(localPath)) return null;
    return { localPath, buffer: await fs.readFile(localPath) };
}

async function deleteFromLocal(uploadsDir, relativePath) {
    const localPath = resolveLocalPath(uploadsDir, relativePath);
    if (!await fs.pathExists(localPath)) return false;
    await fs.remove(localPath);
    return true;
}

// ----- 寫法 B：Supabase Storage bucket `clinical-docs` -----
async function saveToSupabase(supabase, studentId, filename, sourcePath, mimeType) {
    const relativePath = toRelativePath(studentId, filename);
    const buffer = await fs.readFile(sourcePath);
    const { error } = await supabase.storage.from(BUCKET).upload(relativePath, buffer, {
        contentType: mimeType || 'application/octet-stream',
        upsert: true
    });
    if (error) throw error;
    return { relativePath };
}

function toObjectPath(relativePath) {
    return String(relativePath || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .map((seg) => sanitizeSegment(seg))
        .filter(Boolean)
        .join('/');
}

async function readFromSupabase(supabase, relativePath) {
    const objectPath = toObjectPath(relativePath);
    const { data, error } = await supabase.storage.from(BUCKET).download(objectPath);
    if (error || !data) return null;
    const buffer = Buffer.from(await data.arrayBuffer());
    return { buffer, objectPath };
}

async function deleteFromSupabase(supabase, relativePath) {
    const objectPath = toObjectPath(relativePath);
    const { error } = await supabase.storage.from(BUCKET).remove([objectPath]);
    if (error) throw error;
    return true;
}

async function saveClinicalDoc({ uploadsDir, supabase, studentId, filename, sourcePath, mimeType }) {
    const driver = getDriver();
    const relativePath = toRelativePath(studentId, filename);

    if (driver === 'supabase') {
        await saveToSupabase(supabase, studentId, filename, sourcePath, mimeType);
        await fs.remove(sourcePath).catch(() => {});
        return { filePath: relativePath, fileName: relativePath };
    }

    const local = await saveToLocal(uploadsDir, studentId, filename, sourcePath);

    if (driver === 'dual') {
        try {
            await saveToSupabase(supabase, studentId, filename, local.localPath, mimeType);
        } catch (err) {
            console.error('[storage] dual-write to clinical-docs failed:', err.message || err);
        }
    }

    return { filePath: local.relativePath, fileName: local.relativePath };
}

async function readClinicalDoc({ uploadsDir, supabase, relativePath }) {
    const driver = getDriver();

    if (driver === 'local' || driver === 'dual') {
        const local = await readFromLocal(uploadsDir, relativePath);
        if (local) return local;
        if (driver === 'local') return null;
    }

    return readFromSupabase(supabase, relativePath);
}

async function deleteClinicalDoc({ uploadsDir, supabase, relativePath }) {
    const driver = getDriver();
    let removed = false;

    if (driver === 'local' || driver === 'dual') {
        removed = (await deleteFromLocal(uploadsDir, relativePath)) || removed;
    }

    if (driver === 'supabase' || driver === 'dual') {
        try {
            await deleteFromSupabase(supabase, relativePath);
            removed = true;
        } catch (err) {
            if (driver === 'supabase') throw err;
            console.error('[storage] dual-delete from clinical-docs failed:', err.message || err);
        }
    }

    return removed;
}

module.exports = {
    BUCKET,
    getDriver,
    sanitizeSegment,
    toRelativePath,
    resolveLocalPath,
    saveToLocal,
    saveToSupabase,
    deleteFromLocal,
    deleteFromSupabase,
    saveClinicalDoc,
    readClinicalDoc,
    deleteClinicalDoc
};
