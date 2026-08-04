const items = JSON.parse(require('fs').readFileSync('parsed-nsfw-asian/items.json', 'utf8'));
const assocs = JSON.parse(require('fs').readFileSync('parsed-nsfw-asian/associations-preview.json', 'utf8'));
const allItemNames = new Set(items.map(i => String(i.phrase).trim()));
const resolvable = assocs.filter(a => allItemNames.has(String(a.a).trim()) && allItemNames.has(String(a.b).trim()));
console.log('total assocs:', assocs.length, 'resolvable:', resolvable.length);
if (resolvable.length) {
  console.log('first 3 resolvable:');
  for (const a of resolvable.slice(0, 3)) {
    console.log('  -', a.a.slice(0, 30), 'XOR', a.b.slice(0, 30));
  }
}

// Output first 5 of allItemNames to verify they're 英文 phrases
console.log('item sample phrases:');
for (const p of Array.from(allItemNames).slice(0, 8)) console.log('  -', p);
