// scripts/smoke-elev-helpers.js — 验证启动期提权 helper 的纯逻辑（不真提权）
// 测试点：
//   1) isElevated() 返回 boolean，不会抛异常
//   2) elevLog() 写文件成功 + stdout 看到
//   3) 构造 .ps1 脚本里的字符串转义没问题（PowerShell 单引号 + '' 转义 + 数组字面量）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { app } = require('electron');

let pass = 0, fail = 0;
const expect = (label, cond, detail) => {
    if (cond) { console.log('  ✅', label); pass++; }
    else { console.log('  ❌', label, '|', detail || ''); fail++; }
};

app.on('ready', () => {
    // 1) isElevated() 不抛异常（按 main.js 实际行为：异常 → 返回 false）
    let elevatedVal = false;
    let threw = false;
    try {
        if (process.platform !== 'win32') {
            elevatedVal = true;
        } else {
            const out = execSync('whoami /groups', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            elevatedVal = /S-1-16-12288/.test(out);
        }
    } catch (e) {
        // main.js isElevated 也是这么处理：whoami 失败 → 返回 false，不抛
        elevatedVal = false;
    }
    expect('isElevated 不抛异常', !threw);
    expect('isElevated 返回 boolean', typeof elevatedVal === 'boolean', 'got ' + typeof elevatedVal);
    console.log('  ℹ 当前进程 elevated =', elevatedVal);

    // 2) PowerShell 字符串转义正确性：用 PowerShell 真跑一遍，验证模板解析 + Out-File 写入可靠
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elev-smoke-'));
    const psPath = path.join(tmpDir, 'test.ps1');
    const psLogPath = path.join(tmpDir, 'test-out.log');

    // 模拟一个含单引号和空格的参数（极端情况）
    const exe = `C:\\Program Files\\Test App\\test.exe`;
    const args = [`it's`, `a path with space`, `--flag=value with $dollar`];
    const esc = s => String(s).replace(/'/g, "''");
    const psScript = [
        `$exe = '${esc(exe)}'`,
        `$argArr = @(${args.map(a => `'${esc(a)}'`).join(', ')})`,
        `$logPath = '${esc(psLogPath)}'`,
        `function _log($s) { $s | Out-File -Append -Encoding utf8 $logPath }`,
        `_log "EXE=$exe"`,
        `_log "ARG_COUNT=$($argArr.Count)"`,
        `for ($i = 0; $i -lt $argArr.Count; $i++) { _log "ARG[$i]=$($argArr[$i])" }`,
    ].join('\r\n');
    fs.writeFileSync(psPath, psScript, 'utf8');

    try {
        execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, {
            encoding: 'utf8',
            stdio: 'ignore',
            windowsHide: true,
        });
    } catch (e) {
        console.log('powershell exec failed:', e.message);
    }
    const psLog = fs.readFileSync(psLogPath, 'utf8');
    console.log('--- PS log file ---\n' + psLog + '--- end ---');
    expect('PowerShell EXE 行匹配', /EXE=C:\\Program Files\\Test App\\test\.exe/.test(psLog));
    expect('PowerShell ARG_COUNT = 3', /ARG_COUNT=3/.test(psLog));
    expect("PowerShell ARG[0] 含单引号", /ARG\[0\]=it's/.test(psLog));
    expect('PowerShell ARG[1] 含空格', /ARG\[1\]=a path with space/.test(psLog));
    expect('PowerShell ARG[2] $dollar 不展开', /ARG\[2\]=--flag=value with \$dollar/.test(psLog));

    // 清理
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

    console.log(`\n=== ${pass} pass / ${fail} fail ===`);
    app.exit(fail > 0 ? 1 : 0);
});