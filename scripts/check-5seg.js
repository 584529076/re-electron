// Check 5-segment brackets
const fs = require('fs');
const md = fs.readFileSync('D:\\nsfw-prompt-templates-asian解析文件\\01-完整分类树-ASCII.md', 'utf8');

function cleanTitle(s) {
    if (!s) return '';
    let t = String(s).replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, '').replace(/[\uFE0F]/g, '').trim();
    t = t.replace(/^undefined[wrs]+\s+/i, '').trim();
    return t;
}

const nodes = [];
for (const line of md.split('\n')) {
    let i = 0, depth = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === ' ' || ch === '\u2502') i++; else break;
        if (i % 4 === 0) depth++;
    }
    if (i >= line.length) continue;
    if (line[i] !== '\u251C' && line[i] !== '\u2514') continue;
    i++;
    if (line[i] !== '\u2500' || line[i+1] !== '\u2500') continue;
    i += 2;
    if (line[i] !== ' ') continue;
    i++;
    const rest = line.substring(i);
    const bracketMatch = rest.match(/\[([^\]]+)\]\s*$/);
    if (!bracketMatch) continue;
    const beforeBracket = rest.substring(0, rest.length - bracketMatch[0].length).trimEnd();
    const visualMatch = beforeBracket.match(/^(\d+(?:\.\d+)*)\s+(.+)$/);
    const title = cleanTitle(visualMatch ? visualMatch[2] : beforeBracket);
    if (!title) continue;
    nodes.push({ title, fullBracket: bracketMatch[1] });
}

const fives = nodes.filter(n => n.fullBracket.split('.').length === 5);
console.log('5-segment brackets:', fives.length);
for (const n of fives) console.log('  [' + n.fullBracket + '] | ' + n.title.substring(0, 60));

// Also show segment distribution
const segCounts = {};
for (const n of nodes) {
    const c = n.fullBracket.split('.').length;
    segCounts[c] = (segCounts[c] || 0) + 1;
}
console.log('\nFull bracket segment distribution:', segCounts);