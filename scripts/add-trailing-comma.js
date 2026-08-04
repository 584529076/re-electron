// 给指定文件每行（跳过空行/纯空白行）末尾加一个英文 ","
const fs = require('fs');
const path = process.argv[2];
if (!path) { console.error('用法: node add-trailing-comma.js <文件路径>'); process.exit(1); }

const original = fs.readFileSync(path);
// 用 utf8 解码时保留原文件换行符（CRLF / LF）
const text = original.toString('utf8');

const crlf = /\r\n/.test(text);
const EOL = crlf ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);

let touched = 0;
const out = lines.map((line, idx) => {
    // 跳过：最后一段（文件尾的空字符串，由 split('\n') 产生）和纯空白行
    const isLastEmpty = (idx === lines.length - 1) && line === '';
    if (isLastEmpty || line.trim() === '') return line;
    touched++;
    return line + ',';
}).join(EOL);

fs.writeFileSync(path, out, 'utf8');
console.log(`处理完成：共 ${lines.length} 行，给 ${touched} 行加了逗号`);
console.log(`换行符：${crlf ? 'CRLF' : 'LF'}`);
