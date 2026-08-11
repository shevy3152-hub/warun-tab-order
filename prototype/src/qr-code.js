const SIZE = 29;
const DATA_CODEWORDS = 55;
const ECC_CODEWORDS = 15;

function gfMultiply(a, b) {
  let result = 0;
  for (let i = 0; i < 8; i += 1) {
    if (b & 1) result ^= a;
    const high = a & 0x80;
    a = (a << 1) & 0xff;
    if (high) a ^= 0x1d;
    b >>>= 1;
  }
  return result;
}

function generatorPolynomial(length) {
  const polynomial = [1];
  let root = 1;
  for (let i = 0; i < length; i += 1) {
    const next = Array(polynomial.length + 1).fill(0);
    for (let j = 0; j < polynomial.length; j += 1) {
      next[j] ^= polynomial[j];
      next[j + 1] ^= gfMultiply(polynomial[j], root);
    }
    polynomial.splice(0, polynomial.length, ...next);
    root = gfMultiply(root, 2);
  }
  return polynomial;
}

function errorCorrection(data) {
  const generator = generatorPolynomial(ECC_CODEWORDS);
  const ecc = Array(ECC_CODEWORDS).fill(0);
  for (const value of data) {
    const factor = value ^ ecc[0];
    ecc.shift();
    ecc.push(0);
    for (let i = 0; i < ECC_CODEWORDS; i += 1) ecc[i] ^= gfMultiply(generator[i + 1], factor);
  }
  return ecc;
}

function codewords(value) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > 55) throw new Error("Pairing code is too long for QR.");
  const bits = [0, 1, 0, 0, ...Array.from({ length: 8 }, (_, i) => (bytes.length >>> (7 - i)) & 1)];
  for (const byte of bytes) for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  while (bits.length < DATA_CODEWORDS * 8 && bits.length < DATA_CODEWORDS * 8 - 4) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const result = [];
  for (let i = 0; i < bits.length; i += 8) result.push(bits.slice(i, i + 8).reduce((n, bit) => (n << 1) | bit, 0));
  let pad = 0;
  while (result.length < DATA_CODEWORDS) result.push((pad++ % 2) ? 0x11 : 0xec);
  return [...result, ...errorCorrection(result)];
}

function bch(value, polynomial) {
  const degree = Math.floor(Math.log2(polynomial));
  while (value && Math.floor(Math.log2(value)) >= degree) value ^= polynomial << (Math.floor(Math.log2(value)) - degree);
  return value;
}

function matrix(value) {
  const cells = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  const set = (x, y, bit) => { if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) cells[y][x] = Boolean(bit); };
  const finder = (x, y) => {
    for (let dy = -1; dy <= 7; dy += 1) for (let dx = -1; dx <= 7; dx += 1) {
      const on = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      set(x + dx, y + dy, on);
    }
  };
  finder(0, 0); finder(SIZE - 7, 0); finder(0, SIZE - 7);
  for (let i = 8; i < SIZE - 8; i += 1) { if (cells[6][i] === null) set(i, 6, i % 2 === 0); if (cells[i][6] === null) set(6, i, i % 2 === 0); }
  for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(22 + dx, 22 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  const format = (1 << 3) | 0;
  const formatBits = ((format << 10) | bch(format << 10, 0x537)) ^ 0x5412;
  for (let i = 0; i < 15; i += 1) {
    const bit = (formatBits >>> i) & 1;
    if (i < 6) set(8, i, bit); else if (i < 8) set(8, i + 1, bit); else set(8, SIZE - 15 + i, bit);
    if (i < 8) set(SIZE - i - 1, 8, bit); else if (i < 9) set(15 - i, 8, bit); else set(15 - i - 1, 8, bit);
  }
  set(8, SIZE - 8, true);
  const bits = codewords(value).flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1));
  let bitIndex = 0; let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let offset = 0; offset < SIZE; offset += 1) {
      const y = upward ? SIZE - 1 - offset : offset;
      for (const x of [right, right - 1]) if (cells[y][x] === null) { const bit = bits[bitIndex++] ?? 0; set(x, y, bit ^ ((x + y) % 2 === 0 ? 1 : 0)); }
    }
    upward = !upward;
  }
  return cells;
}

export function pairingCodeQrSvg(code, { cellSize = 6, margin = 4 } = {}) {
  const cells = matrix(code);
  const pixels = (SIZE + margin * 2) * cellSize;
  const modules = [];
  for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < SIZE; x += 1) if (cells[y][x]) modules.push(`<rect x="${(x + margin) * cellSize}" y="${(y + margin) * cellSize}" width="${cellSize}" height="${cellSize}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pixels} ${pixels}" role="img" aria-label="pairing QR code"><rect width="100%" height="100%" fill="white"/><g fill="black">${modules.join("")}</g></svg>`;
}
