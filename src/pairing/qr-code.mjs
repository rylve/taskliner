const BYTE_MODE = 0b0100;
const FORMAT_MASK = 0x5412;
const FORMAT_GENERATOR = 0x537;
const VERSION_GENERATOR = 0x1f25;

// QR Code Model 2, error-correction level M. The supported range comfortably
// contains a Taskliner pairing URL while keeping this browser module compact.
const RS_BLOCKS_M = Object.freeze({
  1: [[1, 26, 16]],
  2: [[1, 44, 28]],
  3: [[1, 70, 44]],
  4: [[2, 50, 32]],
  5: [[2, 67, 43]],
  6: [[4, 43, 27]],
  7: [[4, 49, 31]],
  8: [[2, 60, 38], [2, 61, 39]],
  9: [[3, 58, 36], [2, 59, 37]],
  10: [[4, 69, 43], [1, 70, 44]],
});

const ALIGNMENT_POSITIONS = Object.freeze({
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
});

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
let gfValue = 1;
for (let index = 0; index < 255; index += 1) {
  GF_EXP[index] = gfValue;
  GF_LOG[gfValue] = index;
  gfValue <<= 1;
  if (gfValue & 0x100) gfValue ^= 0x11d;
}
for (let index = 255; index < GF_EXP.length; index += 1) GF_EXP[index] = GF_EXP[index - 255];

function gfMultiply(left, right) {
  if (left === 0 || right === 0) return 0;
  return GF_EXP[GF_LOG[left] + GF_LOG[right]];
}

function multiplyPolynomials(left, right) {
  const result = new Uint8Array(left.length + right.length - 1);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      result[leftIndex + rightIndex] ^= gfMultiply(left[leftIndex], right[rightIndex]);
    }
  }
  return result;
}

function reedSolomonRemainder(data, degree) {
  let generator = Uint8Array.of(1);
  for (let index = 0; index < degree; index += 1) {
    generator = multiplyPolynomials(generator, Uint8Array.of(1, GF_EXP[index]));
  }
  const message = new Uint8Array(data.length + degree);
  message.set(data);
  for (let index = 0; index < data.length; index += 1) {
    const factor = message[index];
    if (factor === 0) continue;
    for (let offset = 0; offset < generator.length; offset += 1) {
      message[index + offset] ^= gfMultiply(generator[offset], factor);
    }
  }
  return message.slice(data.length);
}

class BitBuffer {
  constructor() {
    this.bytes = [];
    this.length = 0;
  }

  append(value, bitLength) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(bitLength) || bitLength < 0) {
      throw new TypeError("Invalid QR bit value");
    }
    for (let bit = bitLength - 1; bit >= 0; bit -= 1) {
      const byteIndex = Math.floor(this.length / 8);
      if (this.bytes[byteIndex] == null) this.bytes[byteIndex] = 0;
      if (((value >>> bit) & 1) !== 0) this.bytes[byteIndex] |= 0x80 >>> (this.length % 8);
      this.length += 1;
    }
  }
}

function blocksForVersion(version) {
  const groups = RS_BLOCKS_M[version];
  if (!groups) throw new RangeError("QR version must be between 1 and 10");
  return groups.flatMap(([count, total, data]) => Array.from({ length: count }, () => ({ total, data })));
}

function dataCapacity(version) {
  return blocksForVersion(version).reduce((sum, block) => sum + block.data, 0);
}

function characterCountBits(version) {
  return version <= 9 ? 8 : 16;
}

function selectVersion(byteLength, minVersion, maxVersion) {
  for (let version = minVersion; version <= maxVersion; version += 1) {
    const countBits = characterCountBits(version);
    if (byteLength >= 2 ** countBits) continue;
    if (4 + countBits + byteLength * 8 <= dataCapacity(version) * 8) return version;
  }
  throw new RangeError(`Input is too long for QR versions ${minVersion}-${maxVersion} at error correction M`);
}

function makeDataCodewords(bytes, version) {
  const capacityBits = dataCapacity(version) * 8;
  const bits = new BitBuffer();
  bits.append(BYTE_MODE, 4);
  bits.append(bytes.length, characterCountBits(version));
  for (const byte of bytes) bits.append(byte, 8);
  bits.append(0, Math.min(4, capacityBits - bits.length));
  if (bits.length % 8 !== 0) bits.append(0, 8 - (bits.length % 8));
  let pad = 0;
  while (bits.length < capacityBits) {
    bits.append(pad % 2 === 0 ? 0xec : 0x11, 8);
    pad += 1;
  }
  return Uint8Array.from(bits.bytes);
}

function makeCodewords(dataCodewords, version) {
  const blocks = blocksForVersion(version);
  const dataBlocks = [];
  const errorBlocks = [];
  let offset = 0;
  for (const block of blocks) {
    const data = dataCodewords.slice(offset, offset + block.data);
    offset += block.data;
    dataBlocks.push(data);
    errorBlocks.push(reedSolomonRemainder(data, block.total - block.data));
  }
  const result = [];
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  const maxError = Math.max(...errorBlocks.map((block) => block.length));
  for (let index = 0; index < maxData; index += 1) {
    for (const block of dataBlocks) if (index < block.length) result.push(block[index]);
  }
  for (let index = 0; index < maxError; index += 1) {
    for (const block of errorBlocks) if (index < block.length) result.push(block[index]);
  }
  return Uint8Array.from(result);
}

function bchRemainder(value, generator) {
  let result = value;
  const generatorDegree = 31 - Math.clz32(generator);
  while (result !== 0 && 31 - Math.clz32(result) >= generatorDegree) {
    result ^= generator << (31 - Math.clz32(result) - generatorDegree);
  }
  return result;
}

function setupFinder(matrix, top, left) {
  const size = matrix.length;
  for (let row = -1; row <= 7; row += 1) {
    for (let column = -1; column <= 7; column += 1) {
      const y = top + row;
      const x = left + column;
      if (y < 0 || y >= size || x < 0 || x >= size) continue;
      matrix[y][x] = (row >= 0 && row <= 6 && (column === 0 || column === 6))
        || (column >= 0 && column <= 6 && (row === 0 || row === 6))
        || (row >= 2 && row <= 4 && column >= 2 && column <= 4);
    }
  }
}

function setupAlignment(matrix, version) {
  const positions = ALIGNMENT_POSITIONS[version];
  for (const row of positions) {
    for (const column of positions) {
      if (matrix[row][column] != null) continue;
      for (let y = -2; y <= 2; y += 1) {
        for (let x = -2; x <= 2; x += 1) {
          matrix[row + y][column + x] = Math.max(Math.abs(x), Math.abs(y)) !== 1;
        }
      }
    }
  }
}

function setupTiming(matrix) {
  const size = matrix.length;
  for (let index = 8; index < size - 8; index += 1) {
    if (matrix[index][6] == null) matrix[index][6] = index % 2 === 0;
    if (matrix[6][index] == null) matrix[6][index] = index % 2 === 0;
  }
}

function setupFormat(matrix, mask) {
  const size = matrix.length;
  const format = (((mask << 10) | bchRemainder(mask << 10, FORMAT_GENERATOR)) ^ FORMAT_MASK);
  for (let index = 0; index < 15; index += 1) {
    const dark = ((format >>> index) & 1) !== 0;
    if (index < 6) matrix[index][8] = dark;
    else if (index < 8) matrix[index + 1][8] = dark;
    else matrix[size - 15 + index][8] = dark;

    if (index < 8) matrix[8][size - index - 1] = dark;
    else if (index === 8) matrix[8][7] = dark;
    else matrix[8][15 - index - 1] = dark;
  }
  matrix[size - 8][8] = true;
}

function setupVersion(matrix, version) {
  if (version < 7) return;
  const size = matrix.length;
  const versionBits = (version << 12) | bchRemainder(version << 12, VERSION_GENERATOR);
  for (let index = 0; index < 18; index += 1) {
    const dark = ((versionBits >>> index) & 1) !== 0;
    matrix[Math.floor(index / 3)][index % 3 + size - 11] = dark;
    matrix[index % 3 + size - 11][Math.floor(index / 3)] = dark;
  }
}

function maskAt(mask, row, column) {
  switch (mask) {
    case 0: return (row + column) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return column % 3 === 0;
    case 3: return (row + column) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5: return (row * column) % 2 + (row * column) % 3 === 0;
    case 6: return ((row * column) % 2 + (row * column) % 3) % 2 === 0;
    case 7: return ((row + column) % 2 + (row * column) % 3) % 2 === 0;
    default: throw new RangeError("QR mask must be between 0 and 7");
  }
}

function mapData(matrix, codewords, mask) {
  const size = matrix.length;
  let row = size - 1;
  let direction = -1;
  let bitIndex = 0;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    while (true) {
      for (let offset = 0; offset < 2; offset += 1) {
        const column = right - offset;
        if (matrix[row][column] != null) continue;
        const byte = codewords[Math.floor(bitIndex / 8)];
        let dark = byte == null ? false : ((byte >>> (7 - (bitIndex % 8))) & 1) !== 0;
        if (maskAt(mask, row, column)) dark = !dark;
        matrix[row][column] = dark;
        bitIndex += 1;
      }
      row += direction;
      if (row >= 0 && row < size) continue;
      row -= direction;
      direction = -direction;
      break;
    }
  }
}

function makeMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  const matrix = Array.from({ length: size }, () => Array(size).fill(null));
  setupFinder(matrix, 0, 0);
  setupFinder(matrix, size - 7, 0);
  setupFinder(matrix, 0, size - 7);
  setupAlignment(matrix, version);
  setupTiming(matrix);
  setupFormat(matrix, mask);
  setupVersion(matrix, version);
  mapData(matrix, codewords, mask);
  return matrix;
}

function linePenalty(line) {
  let penalty = 0;
  let runLength = 1;
  for (let index = 1; index <= line.length; index += 1) {
    if (index < line.length && line[index] === line[index - 1]) {
      runLength += 1;
    } else {
      if (runLength >= 5) penalty += runLength - 2;
      runLength = 1;
    }
  }
  const patterns = [
    [true, false, true, true, true, false, true, false, false, false, false],
    [false, false, false, false, true, false, true, true, true, false, true],
  ];
  for (let index = 0; index <= line.length - 11; index += 1) {
    if (patterns.some((pattern) => pattern.every((value, offset) => line[index + offset] === value))) penalty += 40;
  }
  return penalty;
}

function matrixPenalty(matrix) {
  const size = matrix.length;
  let penalty = 0;
  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    penalty += linePenalty(matrix[row]);
    penalty += linePenalty(matrix.map((line) => line[row]));
    for (let column = 0; column < size; column += 1) {
      if (matrix[row][column]) dark += 1;
      if (row + 1 < size && column + 1 < size
        && matrix[row][column] === matrix[row + 1][column]
        && matrix[row][column] === matrix[row][column + 1]
        && matrix[row][column] === matrix[row + 1][column + 1]) penalty += 3;
    }
  }
  penalty += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return penalty;
}

function readVersionOption(value, fallback, name) {
  const version = value == null ? fallback : value;
  if (!Number.isSafeInteger(version) || version < 1 || version > 10) {
    throw new RangeError(`${name} must be an integer between 1 and 10`);
  }
  return version;
}

export function encodeQrCode(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("QR input must be a string");
  const minVersion = readVersionOption(options.minVersion, 1, "minVersion");
  const maxVersion = readVersionOption(options.maxVersion, 10, "maxVersion");
  if (minVersion > maxVersion) throw new RangeError("minVersion must not exceed maxVersion");
  const bytes = new TextEncoder().encode(text);
  const version = selectVersion(bytes.length, minVersion, maxVersion);
  const codewords = makeCodewords(makeDataCodewords(bytes, version), version);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = makeMatrix(version, codewords, mask);
    const penalty = matrixPenalty(matrix);
    if (best == null || penalty < best.penalty) best = { matrix, mask, penalty };
  }
  return {
    version,
    size: best.matrix.length,
    mask: best.mask,
    matrix: best.matrix,
  };
}

function validateMatrix(matrix) {
  if (!Array.isArray(matrix) || matrix.length < 21 || matrix.length % 4 !== 1
    || matrix.some((row) => !Array.isArray(row) || row.length !== matrix.length
      || row.some((value) => typeof value !== "boolean"))) {
    throw new TypeError("QR matrix must be a square boolean matrix");
  }
}

export function qrToSvg(matrix, options = {}) {
  validateMatrix(matrix);
  const margin = options.margin == null ? 4 : options.margin;
  const scale = options.scale == null ? 4 : options.scale;
  if (!Number.isSafeInteger(margin) || margin < 0) throw new RangeError("QR SVG margin must be a non-negative integer");
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError("QR SVG scale must be positive");
  const viewSize = matrix.length + margin * 2;
  const path = [];
  for (let row = 0; row < matrix.length; row += 1) {
    let column = 0;
    while (column < matrix.length) {
      if (!matrix[row][column]) {
        column += 1;
        continue;
      }
      const start = column;
      while (column < matrix.length && matrix[row][column]) column += 1;
      const length = column - start;
      path.push(`M${start + margin} ${row + margin}h${length}v1h-${length}z`);
    }
  }
  const pixelSize = viewSize * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${path.join("")}" fill="#000"/></svg>`;
}

export function encodeQrSvg(text, options = {}) {
  const qr = encodeQrCode(text, options);
  return { ...qr, svg: qrToSvg(qr.matrix, options) };
}
