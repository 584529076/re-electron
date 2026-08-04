// Debug synth module root addition
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

const MODULE_NAMES = { '01': '01-场景主题', '02': '02-景别构图', '03': '03-裸露液体', '04': '04-服装专项' };
const existingMod = new Set(mdNodes.map(n => n.baseBracket.split('.')[0]).filter(b => /^\d{2}$/.test(b)));
console.log('Existing modules:', [...existingMod].sort());

for (let m = 1; m <= 14; m++) {
    const mc = String(m).padStart(2, '0');
    if (!existingMod.has(mc)) {
        console.log('Adding synth for mc=' + mc);
        mdNodes.push({ depth: 0, title: MODULE_NAMES[mc] || (mc + '-模块'), fullBracket: mc, baseBracket: mc, isSynth: true });
    }
}

console.log('Total mdNodes after synth:', mdNodes.length);
const synths = mdNodes.filter(n => n.isSynth);
console.log('Synth entries:', synths.length);
for (const s of synths) console.log('  [' + s.baseBracket + '] ' + s.title);