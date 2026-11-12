import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { createCrx, extensionIdFromPublicKey } from "../scripts/crx.mjs";

test("crx3 signature matches the Chromium signed-data prefix", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const archive = Buffer.from("not-a-real-zip-but-signed-as-the-archive");
  const packed = createCrx(archive, privateKey);
  assert.equal(packed.crx.subarray(0, 4).toString(), "Cr24");
  assert.equal(packed.crx.readUInt32LE(4), 3);
  const headerLength = packed.crx.readUInt32LE(8);
  const header = packed.crx.subarray(12, 12 + headerLength);
  const signed = packed.crx.subarray(12 + headerLength);
  assert.equal(signed.equals(archive), true);

  const publicKey = createPublicKey(createPrivateKey(privateKey)).export({ type: "spki", format: "der" });
  assert.equal(packed.publicKey, Buffer.from(publicKey).toString("base64"));
  assert.equal(packed.id, extensionIdFromPublicKey(publicKey));
  assert.equal(header[0], 0x12);
  const proofLength = readVarint(header, 1);
  const proof = header.subarray(proofLength.next, proofLength.next + proofLength.value);
  const proofKeyLength = readVarint(proof, 1);
  const proofKey = proof.subarray(proofKeyLength.next, proofKeyLength.next + proofKeyLength.value);
  assert.equal(proofKey.equals(publicKey), true);
  const signatureLength = readVarint(proof, proofKeyLength.next + proofKeyLength.value + 1);
  const signature = proof.subarray(signatureLength.next, signatureLength.next + signatureLength.value);
  const signedHeader = header.subarray(header.length - 18);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedHeader.length);
  const ok = verify(
    "sha256",
    Buffer.concat([Buffer.from("CRX3 SignedData\0", "utf8"), size, signedHeader, archive]),
    { key: publicKey, format: "der", type: "spki" },
    signature,
  );
  assert.equal(ok, true);
  const digest = createHash("sha256").update(publicKey).digest();
  assert.equal(signedHeader.subarray(2).equals(digest.subarray(0, 16)), true);
});

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let index = offset;
  while (index < buffer.length) {
    const byte = buffer[index];
    index += 1;
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) return { value, next: index };
    shift += 7;
  }
  throw new Error("truncated varint");
}
