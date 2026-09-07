const palettes = [["#edb59b", "#734c3c"], ["#aec6ac", "#3c5747"], ["#c2b4dc", "#514768"], ["#ebcd80", "#6b5933"], ["#a6c7d6", "#385867"], ["#deb1bf", "#714858"], ["#a4cec3", "#365e54"], ["#c9c58e", "#595b34"]];
const bodies = [
  '<path d="M27 66c-3-21 9-36 31-35 23 0 38 18 35 38-2 23-19 34-38 30C37 96 29 85 27 66Z"/>',
  '<ellipse cx="60" cy="65" rx="35" ry="34"/>',
  '<rect x="26" y="32" width="68" height="65" rx="25"/>',
  '<path d="M28 56c-7-16 7-27 20-20 6-18 26-17 32 0 17-3 25 13 15 27 12 17 1 35-18 32-10 13-30 8-33-1-22 5-30-18-16-38Z"/>',
  '<path d="M40 44c2-19 31-22 37-3 3 11 18 18 18 34 0 18-17 26-35 26-22 0-38-11-35-28 2-14 12-18 15-29Z"/>',
  '<path d="M28 51c0-16 15-24 29-18 13-10 31-2 33 13 18 10 15 31 2 36-3 20-26 26-38 16-20 6-34-9-30-26-12-8-9-17 4-21Z"/>',
];
const extras = [
  '<path d="M39 40 35 22q-1-8 7-8t8 8l1 16M70 37l2-15q1-8 9-6t5 10l-5 16"/>',
  '<path d="M55 34q-5-14 1-22M57 27q15-17 22-5-7 13-22 5Z"/>',
  '<path d="m42 38-10-7q-10-4-12 4t12 17M79 37l11-7q10-4 12 5T88 53"/>',
  '<path d="M49 34q-5-17 9-17M61 31q4-18 15-12" fill="none"/>',
  '<path d="M44 33q16-22 32 0"/>',
];
function seedNumber(value) {
  let hash = 2166136261;
  for (const character of String(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/** Native vector characters with a stable appearance for each saved seed. */
export function mascot(seed) {
  const hash = seedNumber(seed);
  const [color, ink] = palettes[hash % palettes.length];
  const eyes = (hash >>> 12) % 4;
  const spacing = 12 + (hash >>> 20) % 5;
  const eye = (x, wink) => wink ? `<path d="m${x - 4} 64 7 2-7 3" fill="none" stroke-width="3"/>` : `<ellipse cx="${x}" cy="65" rx="4" ry="${eyes === 2 ? 6 : 5}"/><circle cx="${x + 1}" cy="63" r="1.25" fill="#fff" stroke="none"/>`;
  const smiles = ['<path d="M53 77q7 8 14 0" fill="none"/>', '<path d="M53 76q7 2 14 0c-1 11-13 11-14 0Z"/><path d="M57 83h6" stroke="#e69a9d"/>', '<path d="M51 76q4 7 9 1 5 6 9-1" fill="none"/>'];
  return `<svg class="mascot" data-mascot="${hash.toString(16)}" viewBox="0 0 120 120" fill="none" aria-hidden="true" style="--blink-delay:${-(hash % 7000) / 1000}s"><ellipse cx="60" cy="107" rx="27" ry="4" fill="${ink}" opacity=".09"/><g stroke="${ink}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M42 94v10M77 94v10M27 71q-9 1-10 8M94 71q9 1 10 8"/><g fill="${color}">${extras[(hash >>> 8) % extras.length]}${bodies[(hash >>> 4) % bodies.length]}</g><ellipse cx="40" cy="75" rx="6" ry="3" fill="#d27879" opacity=".27" stroke="none"/><ellipse cx="81" cy="75" rx="6" ry="3" fill="#d27879" opacity=".27" stroke="none"/><g class="mascot-eyes" fill="${ink}" stroke="${ink}">${eye(60 - spacing, false)}${eye(60 + spacing, eyes === 3)}</g><g fill="${ink}">${smiles[(hash >>> 16) % smiles.length]}</g></g></svg>`;
}
