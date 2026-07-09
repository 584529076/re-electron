// scripts/smoke-loras.js — Phase 1 smoke test via Electron main process
// 用法: node_modules/.bin/electron scripts/smoke-loras.js --no-sandbox
// 目的: 在真实 Electron runtime 里跑 loras-store 全链路（add→list→resolve→delete），确认：
//   1) better-sqlite3 native binding 加载 OK（不在 system Node 跑 → 避开 ABI mismatch）
//   2) ensureTable 能建表
//   3) addLora 能拷文件 + 建链接
//   4) list / get / resolveByNames / delete 都正常
//   5) 退出码 0 表示成功

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

// 尽早 attach 退出 handler（任何异常都让 process.exit(1)）
process.on('uncaughtException', (e) => {
    console.error('[smoke] uncaughtException:', e);
    app.exit(1);
});

app.on('ready', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loras-smoke-'));
    const dbPath = path.join(tmpRoot, 'test.db');
    const assetsDir = path.join(tmpRoot, 'assets');
    const coversDir = path.join(tmpRoot, 'loras-covers');
    const comfyDir = path.join(tmpRoot, 'comfy');
    fs.mkdirSync(path.join(assetsDir, 'loras', 'files'), { recursive: true });
    fs.mkdirSync(path.join(comfyDir, 'models', 'loras'), { recursive: true });

    const { KVDb } = require('../db');
    const { LorasStore, LORA_TYPES } = require('../loras-store');

    const store = new KVDb(dbPath);
    const loras = new LorasStore({
        store,
        getAssetsDir: () => assetsDir,
        getCoversDir: () => coversDir,
        getComfyConfig: () => ({ comfyDir }),
    });

    try {
        // 1) ensureTable
        loras.ensureTable();
        const tables = store.query("SELECT name FROM sqlite_master WHERE type='table' AND name='loras'");
        console.log('[smoke] 1. ensureTable: loras 表存在 =', tables.length === 1);

        // 2) 准备源文件
        const srcPath = path.join(tmpRoot, 'fake.safetensors');
        fs.writeFileSync(srcPath, Buffer.alloc(64 * 1024, 'x'));
        console.log('[smoke] 2. 源文件 64KB 已准备');

        // 3) addLora
        //    smoke 环境没法真提权，用 hardlink 模拟成功路径
        const r1 = await loras.addLora({
            meta: {
                lora_type: 'character',
                display_name: 'Test Char',
                base_model: 'fake-v1',
                compatible_models: ['fake-v1', 'fake-v2'],
                recommended_weight: 0.75,
                trigger_words: 'testchar, tchar',
                sample_prompt: 'a test character',
            },
            srcPath,
            createLink: async (target, link) => { fs.linkSync(target, link); return true; },
        });
        console.log('[smoke] 3. addLora:', {
            id: r1.id,
            name: r1.name,
            link_type: r1.link_type,
            file_size: r1.file_size,
            file_exists: fs.existsSync(path.join(assetsDir, r1.file_path)),
            link_exists: fs.existsSync(r1._linkDst),
            linkError: r1._linkError,
        });

        // 4) listLoras
        const list = loras.listLoras();
        console.log('[smoke] 4. listLoras count =', list.length, '| first.compatible_models =', list[0]?.compatible_models);

        // 5) listCompatibleLoras
        const matchList = loras.listCompatibleLoras('fake-v1');
        const missList = loras.listCompatibleLoras('totally-different');
        console.log('[smoke] 5. listCompatibleLoras: matching =', matchList.length, '| non-matching =', missList.length);

        // 6) resolveByNames
        const resolved = loras.resolveByNames([r1.name, 'unknown.safetensors']);
        console.log('[smoke] 6. resolveByNames:', resolved);

        // 7) setCoverImage
        const coverSrc = path.join(tmpRoot, 'cover.png');
        fs.writeFileSync(coverSrc, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const r2 = loras.setCoverImage(r1.id, coverSrc);
        console.log('[smoke] 7. setCoverImage: cover_image =', r2.cover_image, '| url =', loras.readCover(r1.id));

        // 8) updateLora
        const r3 = loras.updateLora(r1.id, { display_name: 'Test Char V2', recommended_weight: 0.85 });
        console.log('[smoke] 8. updateLora: display_name =', r3.display_name, '| weight =', r3.recommended_weight);

        // 9) deleteLora
        const del = loras.deleteLora(r1.id);
        console.log('[smoke] 9. deleteLora:', del, '| file_exists =', fs.existsSync(path.join(assetsDir, r1.file_path)), '| link_exists =', fs.existsSync(r1._linkDst), '| cover_exists =', fs.existsSync(path.join(coversDir, r2.cover_image)));

        // 10) LORA_TYPES
        console.log('[smoke] 10. LORA_TYPES count =', LORA_TYPES.length, '| first =', LORA_TYPES[0]);

        // 11) 迁移测试：旧 <assetsDir>/loras/covers/legacy.png → 新 <coversDir>/legacy.png
        //     模拟存量数据：手工插入一条带旧前缀的 cover_image 行
        const legacyName = 'legacy.png';
        const legacyOldAbs = path.join(assetsDir, 'loras', 'covers', legacyName);
        const legacyNewAbs = path.join(coversDir, legacyName);
        fs.mkdirSync(path.join(assetsDir, 'loras', 'covers'), { recursive: true });
        fs.writeFileSync(legacyOldAbs, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        store.exec(
            "INSERT INTO loras (name, lora_type, file_path, cover_image) VALUES (?, ?, ?, ?)",
            'legacy-test.safetensors', 'general', 'loras/files/legacy.safetensors',
            'loras/covers/' + legacyName
        );
        // 触发迁移（ensureTable 末尾会跑一次 _migrateLegacyCovers）
        loras.ensureTable();
        const legacyRow = store.query("SELECT cover_image FROM loras WHERE name = 'legacy-test.safetensors'")[0];
        const migrated = {
            dbHasPrefix: legacyRow.cover_image.startsWith('loras/covers/'),
            dbValue: legacyRow.cover_image,
            newExists: fs.existsSync(legacyNewAbs),
            oldExists: fs.existsSync(legacyOldAbs),
            oldDirGone: !fs.existsSync(path.join(assetsDir, 'loras', 'covers')),
        };
        console.log('[smoke] 11. 迁移:', migrated);
        if (migrated.dbHasPrefix) throw new Error('迁移后 DB cover_image 仍带旧前缀');
        if (migrated.dbValue !== legacyName) throw new Error('迁移后 DB cover_image 不是裸文件名: ' + migrated.dbValue);
        if (!migrated.newExists) throw new Error('迁移后新目录缺文件');
        if (migrated.oldExists) throw new Error('迁移后旧文件还在');
        if (!migrated.oldDirGone) throw new Error('迁移后旧 covers 目录未清理');
        console.log('[smoke] ✅ 迁移测试通过');

        // 12) sweep 测试：在旧目录里塞一个孤儿文件（DB 也没行引用它），
        //     跑 ensureTable 后应被搬到新目录、旧目录清空
        const orphanName = 'orphan.png';
        const orphanOldAbs = path.join(assetsDir, 'loras', 'covers', orphanName);
        const orphanNewAbs = path.join(coversDir, orphanName);
        fs.mkdirSync(path.join(assetsDir, 'loras', 'covers'), { recursive: true });
        fs.writeFileSync(orphanOldAbs, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        loras.ensureTable();
        const sweepResult = {
            newExists: fs.existsSync(orphanNewAbs),
            oldExists: fs.existsSync(orphanOldAbs),
            oldDirGone: !fs.existsSync(path.join(assetsDir, 'loras', 'covers')),
        };
        console.log('[smoke] 12. sweep 孤儿文件:', sweepResult);
        if (!sweepResult.newExists) throw new Error('sweep 后新目录缺文件');
        if (sweepResult.oldExists) throw new Error('sweep 后旧文件还在');
        if (!sweepResult.oldDirGone) throw new Error('sweep 后旧 covers 目录未清理');
        console.log('[smoke] ✅ sweep 测试通过');

        // cleanup tmp
        store.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        console.log('[smoke] ✅ 全部通过');
        app.exit(0);
    } catch (e) {
        console.error('[smoke] ❌ 异常:', e && e.stack || e);
        app.exit(1);
    }
});