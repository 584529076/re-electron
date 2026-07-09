// loras-store.js — Lora 库数据访问层（主进程）
//
// 设计：
// - 表结构单一（loras），元数据 + 资产索引都放一起；避免 join
// - 真实文件存 <assetsDir>/loras/files/<id>__<name>.safetensors（canonical，归我们管）
// - ComfyUI 那边一律走 admin mklink（UAC 提权）：跨盘 / 同盘统一路径，对齐
//   comfyui模型共享软件2.0.exe 的策略（不复制、不留双倍占盘、不依赖 Dev 模式）
// - DB 行里的 file_path / cover_image 都是相对 <assetsDir> 的路径（便于打包后路径漂移）
//
// 与 comfyui-tool-store.js 不同：本模块需要写磁盘 + 调 Win32 API 建符号链接，调用方拿到的对象是浅拷贝。

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const LORA_TYPES = ['character', 'clothing', 'animal', 'body_part', 'pose', 'concept', 'style', 'general'];

// ========== 临时调试日志（D-29 排查 addLora 失败） ==========
// 写 %APPDATA%\re-electron\loras-debug.log，仅用于诊断 addLora / createLinkElevated 行为。
// 排查结束后应删除此 helper 及所有 dbgLog 调用。
function dbgLog(msg) {
    try {
        const baseDir = process.platform === 'win32'
            ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
            : os.tmpdir();
        const logDir = path.join(baseDir, 're-electron');
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(
            path.join(logDir, 'loras-debug.log'),
            `[${new Date().toISOString()}] ${msg}\n`,
            'utf8'
        );
    } catch (_) { /* debug 日志绝不阻塞主流程 */ }
}

class LorasStore {
    /**
     * @param {Object} deps
     * @param {{exec:Function,query:Function}} deps.store  KVDb 实例（带 exec/query）
     * @param {Function} deps.getAssetsDir   返回当前资产目录绝对路径
     * @param {Function} deps.getComfyConfig 返回 { comfyDir, ... } 配置对象
     * @param {Function} [deps.getCoversDir]  返回封面图目录绝对路径（默认 <assetsDir>/loras/covers）
     *                                       main.js 注入独立目录，避免被资产扫描器扫到
     */
    constructor({ store, getAssetsDir, getComfyConfig, getCoversDir }) {
        if (!store) throw new Error('LorasStore: store 必填');
        if (typeof getAssetsDir !== 'function') throw new Error('LorasStore: getAssetsDir 必填');
        if (typeof getComfyConfig !== 'function') throw new Error('LorasStore: getComfyConfig 必填');
        this.store = store;
        this.getAssetsDir = getAssetsDir;
        this.getComfyConfig = getComfyConfig;
        this.getCoversDir = typeof getCoversDir === 'function'
            ? getCoversDir
            : () => path.join(this.getAssetsDir(), 'loras', 'covers');
    }

    // 封面图绝对路径：兼容旧版 "loras/covers/1.png" 与新版 "1.png"
    _coverAbs(coverImage) {
        if (!coverImage) return null;
        return path.join(this.getCoversDir(), path.basename(coverImage));
    }

    // 一次性迁移：把旧 <assetsDir>/loras/covers/ 下的封面图搬到 getCoversDir()，
    // 并把 DB 里的 cover_image 从 "loras/covers/1.png" 改成 "1.png"。
    _migrateLegacyCovers() {
        const defaultDir = path.join(this.getAssetsDir(), 'loras', 'covers');
        const newDir = this.getCoversDir();
        if (path.resolve(defaultDir) === path.resolve(newDir)) return;
        const rows = this.store.query(
            "SELECT id, cover_image FROM loras WHERE cover_image LIKE 'loras/covers/%'"
        );
        if (!rows || !rows.length) return;
        // 即使旧目录已不存在，也把 DB 里的前缀剥掉（让后续 readCover 走新目录查找）
        if (!fs.existsSync(defaultDir)) {
            for (const row of rows) {
                this.store.exec(
                    'UPDATE loras SET cover_image = ? WHERE id = ?',
                    path.basename(row.cover_image), row.id
                );
            }
            return;
        }
        try { fs.mkdirSync(newDir, { recursive: true }); } catch (_) {}
        for (const row of rows) {
            const filename = path.basename(row.cover_image);
            const oldAbs = path.join(defaultDir, filename);
            const newAbs = path.join(newDir, filename);
            try {
                if (fs.existsSync(oldAbs) && !fs.existsSync(newAbs)) {
                    fs.copyFileSync(oldAbs, newAbs);
                    try { fs.unlinkSync(oldAbs); } catch (_) {}
                }
                this.store.exec(
                    'UPDATE loras SET cover_image = ? WHERE id = ?',
                    filename, row.id
                );
            } catch (_) { /* 单个失败不阻塞后续 */ }
        }
        // 旧目录空了则清掉（连带空的 loras 目录）
        try {
            if (fs.readdirSync(defaultDir).length === 0) {
                fs.rmdirSync(defaultDir);
                const lorasDir = path.join(this.getAssetsDir(), 'loras');
                if (fs.existsSync(lorasDir) && fs.readdirSync(lorasDir).length === 0) {
                    fs.rmdirSync(lorasDir);
                }
            }
        } catch (_) {}
    }

    // 每次启动都跑：重试搬运 / 删除旧 <assetsDir>/loras/covers/ 下的文件。
    // 解决 Windows 上文件被锁（explorer 预览、图片查看器）导致 unlink 失败、
    // 第一次迁移没搬完的问题。幂等：文件已在新目录就跳过 copy，DB 已无旧前缀就跳过 UPDATE。
    _sweepLegacyCovers() {
        const defaultDir = path.join(this.getAssetsDir(), 'loras', 'covers');
        const newDir = this.getCoversDir();
        if (path.resolve(defaultDir) === path.resolve(newDir)) return;
        if (!fs.existsSync(defaultDir)) return;
        let swept = 0, copyFailed = 0, unlinkFailed = 0;
        try {
            for (const name of fs.readdirSync(defaultDir)) {
                const oldAbs = path.join(defaultDir, name);
                let isFile = false;
                try { isFile = fs.statSync(oldAbs).isFile(); } catch (_) { continue; }
                if (!isFile) continue;
                const newAbs = path.join(newDir, name);
                try { fs.mkdirSync(newDir, { recursive: true }); } catch (_) {}
                if (!fs.existsSync(newAbs)) {
                    try {
                        fs.copyFileSync(oldAbs, newAbs);
                    } catch (e) {
                        copyFailed++;
                        dbgLog(`[sweep] copy failed: ${name} ${e.code || e.message}`);
                        continue;
                    }
                }
                try {
                    fs.unlinkSync(oldAbs);
                    swept++;
                } catch (e) {
                    unlinkFailed++;
                    dbgLog(`[sweep] unlink failed (will retry next start): ${name} ${e.code || e.message}`);
                }
            }
        } catch (e) {
            dbgLog(`[sweep] readdir failed: ${e.message}`);
        }
        // 旧目录空了才清（不空说明还有锁住的文件，下一次启动再试）
        try {
            if (fs.existsSync(defaultDir) && fs.readdirSync(defaultDir).length === 0) {
                fs.rmdirSync(defaultDir);
                const lorasDir = path.join(this.getAssetsDir(), 'loras');
                if (fs.existsSync(lorasDir) && fs.readdirSync(lorasDir).length === 0) {
                    fs.rmdirSync(lorasDir);
                }
            }
        } catch (_) {}
        if (swept || copyFailed || unlinkFailed) {
            dbgLog(`[sweep] done swept=${swept} copyFailed=${copyFailed} unlinkFailed=${unlinkFailed} from ${defaultDir}`);
        }
    }

    // ========== 表初始化 ==========
    ensureTable() {
        this.store.exec(`
            CREATE TABLE IF NOT EXISTS loras (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                name                TEXT    NOT NULL UNIQUE,
                display_name        TEXT    DEFAULT '',
                lora_type           TEXT    NOT NULL,
                base_model          TEXT    DEFAULT '',
                compatible_models   TEXT    DEFAULT '[]',
                recommended_weight  REAL    DEFAULT 1.0,
                recommended_pairings TEXT   DEFAULT '[]',
                trigger_words       TEXT    DEFAULT '',
                sample_prompt       TEXT    DEFAULT '',
                cover_image         TEXT    DEFAULT '',
                file_path           TEXT    DEFAULT '',
                file_size           INTEGER DEFAULT 0,
                link_type           TEXT    DEFAULT '',
                description         TEXT    DEFAULT '',
                created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                updated_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            )
        `);
        this.store.exec(`CREATE INDEX IF NOT EXISTS idx_loras_type       ON loras(lora_type)`);
        this.store.exec(`CREATE INDEX IF NOT EXISTS idx_loras_base_model ON loras(base_model)`);
        this._migrateLegacyCovers();
        // 每次启动都跑：retry unlink（Windows 文件锁）+ 扫尾搬运
        this._sweepLegacyCovers();
    }

    // ========== 基础 CRUD ==========
    _rowToRecord(r) {
        if (!r) return null;
        return {
            id: Number(r.id),
            name: r.name,
            display_name: r.display_name || '',
            lora_type: r.lora_type || 'general',
            base_model: r.base_model || '',
            compatible_models: tryParseJson(r.compatible_models, []),
            recommended_weight: Number(r.recommended_weight) || 1.0,
            recommended_pairings: tryParseJson(r.recommended_pairings, []),
            trigger_words: r.trigger_words || '',
            sample_prompt: r.sample_prompt || '',
            cover_image: r.cover_image || '',
            file_path: r.file_path || '',
            file_size: Number(r.file_size) || 0,
            link_type: r.link_type || '',
            description: r.description || '',
            created_at: Number(r.created_at) || 0,
            updated_at: Number(r.updated_at) || 0,
        };
    }

    listLoras({ type, searchText, limit = 200, offset = 0 } = {}) {
        const where = [];
        const params = [];
        if (type) { where.push('lora_type = ?'); params.push(type); }
        if (searchText) {
            const like = '%' + String(searchText).replace(/[%_]/g, c => '\\' + c) + '%';
            where.push('(name LIKE ? OR display_name LIKE ?)');
            params.push(like, like);
        }
        let sql = 'SELECT * FROM loras';
        if (where.length) sql += ' WHERE ' + where.join(' AND ');
        sql += ' ORDER BY display_name, name LIMIT ? OFFSET ?';
        params.push(Number(limit) || 200, Number(offset) || 0);
        const rows = this.store.query(sql, ...params);
        return rows.map(r => this._rowToRecord(r));
    }

    getLora(id) {
        const rows = this.store.query('SELECT * FROM loras WHERE id = ?', Number(id));
        return this._rowToRecord(rows[0]);
    }

    async addLora({ meta, srcPath, createLink }) {
        dbgLog(`[addLora] entry src=${srcPath} type=${meta && meta.lora_type} createLink=${typeof createLink}`);
        if (!srcPath) throw new Error('srcPath 必填');
        if (!fs.existsSync(srcPath)) throw new Error('源文件不存在: ' + srcPath);
        meta = meta || {};
        if (!meta.lora_type) throw new Error('lora_type 必填');
        if (!LORA_TYPES.includes(meta.lora_type)) throw new Error('lora_type 非法: ' + meta.lora_type);

        const originalName = (meta.name && String(meta.name).trim()) || path.basename(srcPath);
        if (!originalName) throw new Error('name 无法推导（srcPath 异常）');
        const safeName = sanitizeFileName(originalName);

        // 1) 拷贝源文件到 <assetsDir>/loras/files/.tmp-<rand>
        const lorasFilesDir = path.join(this.getAssetsDir(), 'loras', 'files');
        fs.mkdirSync(lorasFilesDir, { recursive: true });
        const tmpPath = path.join(lorasFilesDir, '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
        fs.copyFileSync(srcPath, tmpPath);
        const fileSize = fs.statSync(tmpPath).size;

        // === 回滚准备：所有「副作用资源」路径集中在这里，try 内任一失败都能完整回收 ===
        // 重要：rollback 不清理 linkDst（ComfyUI 端的链接）。
        //   - 如果 existsSync 触发：linkDst 是用户原本的文件，**不能删**
        //   - 如果 createLink 失败：symlink 通常不存在；半成品的 broken symlink 让用户自己清
        //   简单可靠：永远不碰 linkDst。
        let id = NaN;
        let finalAbsPath = '';
        const comfyCfg = this.getComfyConfig() || {};
        const comfyDir = comfyCfg.comfyDir || '';
        const rollback = (err) => {
            try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
            try { if (finalAbsPath && fs.existsSync(finalAbsPath)) fs.unlinkSync(finalAbsPath); } catch (_) {}
            try { if (!Number.isNaN(id)) this.store.exec('DELETE FROM loras WHERE id = ?', id); } catch (_) {}
            throw err;
        };

        try {
            // 2) INSERT 拿 id（先占位 file_path=''，拿到 id 后再 update）
            const insertInfo = this.store.exec(
                `INSERT INTO loras (
                    name, display_name, lora_type, base_model, compatible_models,
                    recommended_weight, recommended_pairings, trigger_words, sample_prompt,
                    cover_image, file_path, file_size, description
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                originalName,
                meta.display_name || '',
                meta.lora_type,
                meta.base_model || '',
                JSON.stringify(Array.isArray(meta.compatible_models) ? meta.compatible_models : []),
                Number(meta.recommended_weight) || 1.0,
                JSON.stringify(Array.isArray(meta.recommended_pairings) ? meta.recommended_pairings : []),
                meta.trigger_words || '',
                meta.sample_prompt || '',
                '',  // cover_image 后置
                '',  // file_path 后置
                fileSize,
                meta.description || ''
            );
            id = Number(insertInfo.lastInsertRowid);

            // 3) 重命名 tmp → <id>__<safeName>
            const finalFileName = `${id}__${safeName}`;
            finalAbsPath = path.join(lorasFilesDir, finalFileName);
            try {
                fs.renameSync(tmpPath, finalAbsPath);
            } catch (e) {
                // rename 失败就回退（极端情况下 tmp 和 final 不在同一 fs）
                try {
                    fs.copyFileSync(tmpPath, finalAbsPath);
                    fs.unlinkSync(tmpPath);
                } catch (copyErr) {
                    throw new Error('无法拷贝源文件到资产目录: ' + copyErr.message);
                }
            }

            // 4) 在 ComfyUI/models/loras/ 下建链接（UAC → admin mklink）
            let linkType = '';
            if (comfyDir) {
                const comfyLorasDir = path.join(comfyDir, 'models', 'loras');
                try {
                    fs.mkdirSync(comfyLorasDir, { recursive: true });
                } catch (e) {
                    throw new Error('无法创建 ComfyUI loras 目录: ' + e.message);
                }
                const linkDst = path.join(comfyLorasDir, safeName);
                if (fs.existsSync(linkDst)) {
                    throw new Error(`ComfyUI loras 目录已存在同名文件: ${safeName}`);
                }
                const fn = typeof createLink === 'function' ? createLink : createLinkElevated;
                dbgLog(`[addLora] before createLink fn=${fn === createLinkElevated ? 'createLinkElevated(default)' : 'injected'} target=${finalAbsPath} link=${linkDst}`);
                const ok = await fn(finalAbsPath, linkDst);
                dbgLog(`[addLora] createLink returned ${ok}`);
                if (!ok) {
                    throw new Error('提权 mklink 失败（用户拒绝 UAC 或命令失败），Lora 添加终止');
                }
                linkType = 'symlink';
            }

            // 5) UPDATE file_path + link_type（DB 损坏等极端情况也算失败，回滚兜底）
            const relFilePath = path.join('loras', 'files', finalFileName);
            this.store.exec(
                `UPDATE loras SET file_path = ?, link_type = ?, updated_at = strftime('%s','now') WHERE id = ?`,
                relFilePath, linkType, id
            );
        } catch (e) {
            dbgLog(`[addLora] caught: ${e && e.message}`);
            rollback(e);
        }

        const record = this.getLora(id);
        record._linkError = '';
        record._linkDst = comfyDir ? path.join(comfyDir, 'models', 'loras', safeName) : '';
        return record;
    }

    updateLora(id, patch) {
        const cur = this.getLora(id);
        if (!cur) throw new Error(`lora id=${id} 不存在`);
        patch = patch || {};
        const sets = [];
        const params = [];
        const scalarFields = ['display_name', 'lora_type', 'base_model', 'recommended_weight', 'trigger_words', 'sample_prompt', 'description'];
        for (const k of scalarFields) {
            if (patch[k] !== undefined) {
                sets.push(`${k} = ?`);
                params.push(patch[k]);
            }
        }
        if (patch.compatible_models !== undefined) {
            sets.push('compatible_models = ?');
            params.push(JSON.stringify(Array.isArray(patch.compatible_models) ? patch.compatible_models : []));
        }
        if (patch.recommended_pairings !== undefined) {
            sets.push('recommended_pairings = ?');
            params.push(JSON.stringify(Array.isArray(patch.recommended_pairings) ? patch.recommended_pairings : []));
        }
        if (patch.cover_image !== undefined) {
            sets.push('cover_image = ?');
            params.push(patch.cover_image || '');
        }
        if (!sets.length) return cur;
        sets.push(`updated_at = strftime('%s','now')`);
        params.push(Number(id));
        this.store.exec(`UPDATE loras SET ${sets.join(', ')} WHERE id = ?`, ...params);
        return this.getLora(id);
    }

    deleteLora(id) {
        const cur = this.getLora(id);
        if (!cur) return { ok: true, alreadyDeleted: true };
        // 1) 删 ComfyUI/models/loras/<name> 链接
        const comfyCfg = this.getComfyConfig() || {};
        if (cur.link_type && comfyCfg.comfyDir) {
            const linkDst = path.join(comfyCfg.comfyDir, 'models', 'loras', cur.name);
            try { fs.unlinkSync(linkDst); } catch {}
        }
        // 2) 删 asset file
        if (cur.file_path) {
            const abs = path.join(this.getAssetsDir(), cur.file_path);
            try { fs.unlinkSync(abs); } catch {}
        }
        // 3) 删 cover
        if (cur.cover_image) {
            const abs = this._coverAbs(cur.cover_image);
            if (abs && fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch {} }
        }
        // 4) 删 DB 行
        this.store.exec('DELETE FROM loras WHERE id = ?', Number(id));
        return { ok: true };
    }

    // ========== 封面图 ==========
    setCoverImage(id, absSrcPath) {
        if (!absSrcPath || !fs.existsSync(absSrcPath)) throw new Error('封面图源文件不存在');
        const cur = this.getLora(id);
        if (!cur) throw new Error(`lora id=${id} 不存在`);
        // 删旧封面
        if (cur.cover_image) {
            const oldAbs = this._coverAbs(cur.cover_image);
            if (oldAbs && fs.existsSync(oldAbs)) { try { fs.unlinkSync(oldAbs); } catch {} }
        }
        const coversDir = this.getCoversDir();
        fs.mkdirSync(coversDir, { recursive: true });
        const ext = (path.extname(absSrcPath).toLowerCase() || '.png').replace(/[^.a-z0-9]/g, '');
        const destName = `${id}${ext}`;
        const destAbs = path.join(coversDir, destName);
        fs.copyFileSync(absSrcPath, destAbs);
        // DB 只存文件名，路径解析走 getCoversDir()
        this.store.exec(
            `UPDATE loras SET cover_image = ?, updated_at = strftime('%s','now') WHERE id = ?`,
            destName, Number(id)
        );
        return this.getLora(id);
    }

    clearCoverImage(id) {
        const cur = this.getLora(id);
        if (cur && cur.cover_image) {
            const abs = this._coverAbs(cur.cover_image);
            if (abs && fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch {} }
        }
        this.store.exec(
            `UPDATE loras SET cover_image = '', updated_at = strftime('%s','now') WHERE id = ?`,
            Number(id)
        );
        return this.getLora(id);
    }

    readCover(id) {
        const cur = this.getLora(id);
        if (!cur || !cur.cover_image) return null;
        const abs = this._coverAbs(cur.cover_image);
        if (!abs || !fs.existsSync(abs)) return null;
        return 'file:///' + abs.replace(/\\/g, '/');
    }

    // ========== 工作流集成辅助 ==========
    // 按 model 列表筛兼容 Lora：
    //  - targets 为数组时，匹配 lora.base_model 或 lora.compatible_models 与 targets 有任一交集
    //  - 同时仍兼容「字符串入参」（旧调用形式）：自动包成 [str]
    //  - targets 为空 / null：返回全部
    // 用途：AI 工具调用时按 schema.models（如 ["ZIB","ZIT"]）筛出可用 Lora。
    // 同时，lora.lora_type === 'general' 的通用 Lora 始终保留（不限定模型）。
    listCompatibleLoras(modelOrArray) {
        const all = this.listLoras({ limit: 100000 });
        const targets = Array.isArray(modelOrArray)
            ? modelOrArray.filter(Boolean)
            : (modelOrArray ? [String(modelOrArray)] : []);
        if (!targets.length) return all;
        return all.filter(l =>
            l.lora_type === 'general' ||
            targets.includes(l.base_model) ||
            (Array.isArray(l.compatible_models) && l.compatible_models.some(m => targets.includes(m)))
        );
    }

    // 把 workflow 里的 lora_name basename 数组解析成 [{basename, loraId, loraName}]
    resolveByNames(basenames) {
        if (!Array.isArray(basenames) || !basenames.length) return [];
        const cleaned = basenames.filter(Boolean);
        if (!cleaned.length) return [];
        const placeholders = cleaned.map(() => '?').join(',');
        const rows = this.store.query(
            `SELECT id, name, display_name FROM loras WHERE name IN (${placeholders})`,
            ...cleaned
        );
        return rows.map(r => ({
            basename: r.name,
            loraId: Number(r.id),
            loraName: r.name,
            displayName: r.display_name || r.name,
        }));
    }

    // 清理 addLora 中残留的 .tmp-* staging 文件。
    // 仅删除 mtime 超过 maxAgeMs 的（默认 1 小时），防止误删正在进行的 addLora。
    // 设计依据：
    //   - happy path 下 .tmp-* 存在时间 ~ 几毫秒（rename 完就没了）
    //   - 只有 addLora 流程被异常中断（进程被杀 / 断电 / OS 崩）才会留下 .tmp-*
    //   - 用 1 小时兜底，正常启动时被中断的残留在 >1h 后稳清
    sweepStagingFiles(maxAgeMs = 60 * 60 * 1000) {
        const dir = path.join(this.getAssetsDir(), 'loras', 'files');
        const result = { swept: 0, errors: [] };
        let entries;
        try {
            entries = fs.readdirSync(dir);
        } catch (e) {
            // 目录不存在 → 没什么要清的
            return result;
        }
        const cutoff = Date.now() - maxAgeMs;
        for (const name of entries) {
            if (!name.startsWith('.tmp-')) continue;
            const full = path.join(dir, name);
            try {
                const st = fs.statSync(full);
                if (!st.isFile()) continue;
                if (st.mtimeMs > cutoff) continue;  // 还在 age 窗口内，留着
                fs.unlinkSync(full);
                result.swept++;
            } catch (e) {
                result.errors.push({ file: name, error: e.message });
            }
        }
        return result;
    }
}

// ========== helpers ==========
function tryParseJson(s, fallback) {
    if (!s) return fallback;
    try { return JSON.parse(s); } catch { return fallback; }
}

function sanitizeFileName(name) {
    // 去掉路径分隔符 + Windows 非法字符 + 收尾空白/点
    return String(name)
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/^\.+|\.+$/g, '')
        .trim() || 'unnamed';
}

// 创建 symlink：要求调用方进程已具备管理员权限（main.js 启动期已一次性 UAC 提权）。
// 这里直接走 Node.js fs.symlinkSync，底层就是 Win32 CreateSymbolicLinkW（libuv 实现），
// 跟 comfyui模型共享软件2.0.exe 在 API 层面完全等价。
//
// 设计（D-28 + D-29）：
//   - main.js 启动时 isElevated() → 没权限就 Start-Process -Verb Runas 自重启 + --elevated 标记
//   - 重启后的进程是 admin，本函数直接 fs.symlinkSync 即可，不再 spawn cmd.exe / mklink
//   - 失败 / 权限不够 → 返回 false，由调用方决定下一步
//
// 演进：
//   - D-28：spawn('cmd.exe', ['/c', 'mklink', link, target])  ← 当时想保留"全走 shell"语义
//   - D-29：直接 fs.symlinkSync(target, link, 'file')
//     原因：cmd /c mklink 路径上有 (a) 引号剥离导致 `&` 被吃，
//           (b) GBK 中文错误信息被 UTF-8 读成 mojibake 看不到真因，
//           (c) 与 comfyui 模型共享软件对比后发现 .exe 直接 CreateSymbolicLinkW，
//               Node fs.symlinkSync 走的就是同一条 Win32 API 路径，等价。
//
// 之所以叫 createLinkElevated（而不是 createLinkSymlink）：
//   - 保留向后兼容的命名（main.js / smoke 测试 / 调用方都引用过）
//   - 体现"需要在 elevated 进程里调用"的契约
async function createLinkElevated(targetAbs, linkAbs) {
    if (process.platform !== 'win32') return false;
    dbgLog(`[createLinkElevated] entry target=${targetAbs} link=${linkAbs}`);
    // fs.symlinkSync(target, link, type):
    //   - target 在前：要指向的真实文件（assets/loras/files/<id>__<safeName>.safetensors）
    //   - link 在后：新建的符号链接路径（ComfyUI/models/loras/<safeName>）
    //   - type='file'：文件 symlink（等价于 mklink，不带 /D /J）
    //   - 在 Windows 上 type 是必填，否则 fs.symlinkSync 抛 "type argument is required"
    try {
        fs.symlinkSync(targetAbs, linkAbs, 'file');
        const exists = fs.existsSync(linkAbs);
        dbgLog(`[createLinkElevated] fs.symlinkSync ok existsSync=${exists}`);
        return exists;
    } catch (e) {
        // 常见错误码：
        //   EEXIST: linkDst 已存在（addLora 已前置检查，这里通常不该触发）
        //   EPERM: 没有权限 / SeCreateSymbolicLinkPrivilege 被剥
        //   ENOENT: targetAbs 不存在 / linkDst 父目录不存在
        dbgLog(`[createLinkElevated] fs.symlinkSync failed code=${e.code} message=${e.message}`);
        return false;
    }
}

module.exports = { LorasStore, LORA_TYPES, createLinkElevated };