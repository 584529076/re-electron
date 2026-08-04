// Analyze bracket code structure in markdown
const fs = require('fs');
const md = fs.readFileSync('D:\\nsfw-prompt-templates-asian解析文件\\01-完整分类树-ASCII.md', 'utf8');

function cleanTitle(s) {
    if (!s) return '';
    let t = String(s).replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, '').replace(/[\uFE0F]/g, '').trim();
    t = t.replace(/^undefined[wrs]+\s+/i, '').trim();
    return t;
}

function stripSuffix(code) {
    return String(code).replace(/[_][wrx]+$/, '');
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
    nodes.push({
        depth,
        title,
        fullBracket: bracketMatch[1],
        baseBracket: stripSuffix(bracketMatch[1])
    });
}

console.log('Total md nodes:', nodes.length);

// Count by segment count
const segCounts = {};
for (const n of nodes) {
    const c = n.baseBracket.split('.').length;
    segCounts[c] = (segCounts[c] || 0) + 1;
}
console.log('Bracket segments:', segCounts);

// Module roots (1-segment)
const roots = nodes.filter(n => n.baseBracket.split('.').length === 1);
console.log('\nModule roots:', roots.length);
for (const r of roots) console.log('  [' + r.fullBracket + '] | ' + r.title);

// Base bracket collisions (multiple md nodes with same base)
const baseCount = new Map();
for (const n of nodes) {
    baseCount.set(n.baseBracket, (baseCount.get(n.baseBracket) || 0) + 1);
}
const collisions = [...baseCount.entries()].filter(([k, v]) => v > 1);
console.log('\nBase bracket collisions:', collisions.length);
for (const [k, v] of collisions.slice(0, 20)) {
    const es = nodes.filter(n => n.baseBracket === k);
    console.log('  [' + k + '] x' + v);
    for (const e of es) console.log('    depth=' + e.depth + ' full=[' + e.fullBracket + '] | ' + e.title.substring(0,40));
}

// Suffix distribution
const suffixCounts = { _w: 0, _r: 0, _wr: 0, _rr: 0, _z: 0, none: 0 };
for (const n of nodes) {
    if (n.fullBracket === n.baseBracket) suffixCounts.none++;
    else if (/_w+$/.test(n.fullBracket)) suffixCounts._w++;
    else if (/_r+$/.test(n.fullBracket)) suffixCounts._rr++;
}
console.log('\nSuffix distribution:', suffixCounts);