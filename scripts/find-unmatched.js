// Find unmatched md nodes
const fs = require('fs');
const md = fs.readFileSync('D:\\nsfw-prompt-templates-asian解析文件\\01-完整分类树-ASCII.md', 'utf8');

function cleanTitle(s) {
    if (!s) return '';
    let t = String(s).replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, '').replace(/[\uFE0F]/g, '').trim();
    t = t.replace(/^undefined[wrs]+\s+/i, '').trim();
    return t;
}
function stripSuffix(code) { return String(code).replace(/[_][wrx]+$/, ''); }

function parseLine(line) {
    let i = 0, depth = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === ' ' || ch === '\u2502') i++; else break;
        if (i % 4 === 0) depth++;
    }
    if (i >= line.length) return null;
    if (line[i] !== '\u251C' && line[i] !== '\u2514') return null;
    i++;
    if (line[i] !== '\u2500' || line[i+1] !== '\u2500') return null;
    i += 2;
    if (line[i] !== ' ') return null;
    i++;
    const rest = line.substring(i);
    const bracketMatch = rest.match(/\[([^\]]+)\]\s*$/);
    if (!bracketMatch) return null;
    const fullBracket = bracketMatch[1];
    if (/^undefined/.test(fullBracket)) return null;
    const baseBracket = stripSuffix(fullBracket);
    if (baseBracket.split('.').length > 4) return null;
    const beforeBracket = rest.substring(0, rest.length - bracketMatch[0].length).trimEnd();
    const visualMatch = beforeBracket.match(/^(\d+(?:\.\d+)*)\s+(.+)$/);
    const title = cleanTitle(visualMatch ? visualMatch[2] : beforeBracket);
    if (!title) return null;
    return { depth, title, fullBracket, baseBracket };
}

const mdNodes = [];
for (const line of md.split('\n')) {
    const n = parseLine(line);
    if (n) mdNodes.push(n);
}

const cats = JSON.parse(fs.readFileSync('parsed-nsfw-asian/categories.json', 'utf8'));
const catsByMT = new Map();
for (const c of cats) {
    const mc = String(c.module_code || '').padStart(2, '0');
    const k = mc + '|' + cleanTitle(c.title);
    if (!catsByMT.has(k)) catsByMT.set(k, []);
    catsByMT.get(k).push(c);
}

let noMatch = 0;
const unmatched = [];
for (const n of mdNodes) {
    const mc = String(Number(n.baseBracket.split('.')[0])).padStart(2, '0');
    const k = mc + '|' + n.title;
    if (!catsByMT.has(k)) {
        noMatch++;
        unmatched.push({ mc, title: n.title, bracket: n.baseBracket });
    }
}
console.log('Unmatched md nodes:', noMatch);
for (const u of unmatched) console.log('  [' + u.bracket + '] mc=' + u.mc + ' | ' + u.title.substring(0, 50));