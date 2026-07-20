import assert from "node:assert/strict";
import test from "node:test";

import { encodeQrCode, encodeQrSvg, qrToSvg } from "../src/pairing/qr-code.mjs";

function assertFinder(matrix, top, left) {
  for (let row = 0; row < 7; row += 1) {
    for (let column = 0; column < 7; column += 1) {
      const expected = row === 0 || row === 6 || column === 0 || column === 6
        || (row >= 2 && row <= 4 && column >= 2 && column <= 4);
      assert.equal(matrix[top + row][left + column], expected);
    }
  }
}

function readFormatBits(matrix) {
  const bits = [];
  for (let index = 0; index < 15; index += 1) {
    let value;
    if (index < 6) value = matrix[index][8];
    else if (index < 8) value = matrix[index + 1][8];
    else value = matrix[matrix.length - 15 + index][8];
    if (value) bits.push(1 << index);
  }
  return bits.reduce((sum, value) => sum | value, 0);
}

function bchRemainder(value, generator) {
  let result = value;
  const degree = 31 - Math.clz32(generator);
  while (result !== 0 && 31 - Math.clz32(result) >= degree) {
    result ^= generator << (31 - Math.clz32(result) - degree);
  }
  return result;
}

test("encodes UTF-8 Byte mode and selects the smallest fitting version at ECC M", () => {
  assert.equal(encodeQrCode("a".repeat(14)).version, 1);
  assert.equal(encodeQrCode("a".repeat(15)).version, 2);
  assert.equal(encodeQrCode("日本語").version, 1);
  const pairingUrl = "https://taskliner.example/#taskliner-pair=AbCdEf0123456789._-AbCdEf0123456789abcd";
  const qr = encodeQrCode(pairingUrl);
  assert.ok(qr.version <= 5);
  assert.equal(qr.size, qr.version * 4 + 17);
});

test("creates Model 2 finder, timing, alignment, dark, and valid M format patterns", () => {
  const qr = encodeQrCode("x".repeat(60));
  const { matrix, size, mask } = qr;
  assertFinder(matrix, 0, 0);
  assertFinder(matrix, size - 7, 0);
  assertFinder(matrix, 0, size - 7);
  assert.equal(matrix[size - 8][8], true);
  assert.equal(matrix[6][8], true);
  assert.equal(matrix[6][9], false);
  assert.equal(matrix[8][6], true);
  assert.equal(matrix[9][6], false);

  const format = readFormatBits(matrix);
  assert.equal(format ^ 0x5412, (mask << 10) | bchRemainder(mask << 10, 0x537));
  assert.equal(bchRemainder(format ^ 0x5412, 0x537), 0);
  assert.equal(matrix.every((row) => row.every((value) => typeof value === "boolean")), true);
});

test("writes alignment and version information for larger symbols", () => {
  const { matrix } = encodeQrCode("version seven", { minVersion: 7, maxVersion: 7 });
  assert.equal(matrix.length, 45);
  for (let offset = -2; offset <= 2; offset += 1) {
    assert.equal(matrix[38][38 + offset], Math.abs(offset) !== 1);
    assert.equal(matrix[38 + offset][38], Math.abs(offset) !== 1);
  }
  let versionBits = 0;
  for (let index = 0; index < 18; index += 1) {
    if (matrix[Math.floor(index / 3)][index % 3 + matrix.length - 11]) versionBits |= 1 << index;
  }
  assert.equal(versionBits >>> 12, 7);
  assert.equal(bchRemainder(versionBits, 0x1f25), 0);
});

test("is deterministic and reports capacity and option errors", () => {
  const first = encodeQrCode("same pairing fragment");
  const second = encodeQrCode("same pairing fragment");
  assert.deepEqual(second, first);
  assert.throws(() => encodeQrCode("a".repeat(214)), /too long/);
  assert.throws(() => encodeQrCode("value", { minVersion: 4, maxVersion: 3 }), /must not exceed/);
  assert.throws(() => encodeQrCode(new String("value")), /must be a string/);
});

test("renders a quiet-zone SVG without embedding or interpreting the input", () => {
  const hostile = `#taskliner-pair=\"><script>alert(1)</script>`;
  const result = encodeQrSvg(hostile, { scale: 3, margin: 4 });
  assert.equal(result.svg.startsWith("<svg "), true);
  assert.match(result.svg, /viewBox="0 0 \d+ \d+"/);
  assert.match(result.svg, /<path d="M\d+ \d+h\d+v1h-\d+z/);
  assert.equal(result.svg.includes(hostile), false);
  assert.equal(result.svg.includes("<script>"), false);
  assert.equal(qrToSvg(result.matrix).includes("aria-label=\"QR code\""), true);
  assert.throws(() => qrToSvg(result.matrix, { margin: -1 }), /margin/);
});
