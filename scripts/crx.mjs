import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

// Chromium signs CRX3 with RSA PKCS#1 v1.5 over
// "CRX3 SignedData\0" + uint32le(signed_header_size) + signed_header_data + zip.
// See components/crx_file/crx3.proto.
const SIGNED_DATA_CONTEXT = Buffer.from("CRX3 SignedData\0", "utf8");

export function extensionIdFromPublicKey(publicKey) {
  const digest = createHash("sha256").update(publicKey).digest();
  const alphabet = "abcdefghijklmnop";
  let id = "";
  for (const byte of digest.subarray(0, 16)) id += alphabet[byte >> 4] + alphabet[byte & 15];
  return id;
}

export function createCrx(archive, privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const digest = createHash("sha256").update(publicKey).digest();
  const signedHeaderData = bytesField(1, digest.subarray(0, 16));
  const signedHeaderSize = Buffer.alloc(4);
  signedHeaderSize.writeUInt32LE(signedHeaderData.length);
  const signature = sign(
    "sha256",
    Buffer.concat([SIGNED_DATA_CONTEXT, signedHeaderSize, signedHeaderData, archive]),
    privateKey,
  );
  const proof = Buffer.concat([bytesField(1, publicKey), bytesField(2, signature)]);
  const header = Buffer.concat([bytesField(2, proof), bytesField(10000, signedHeaderData)]);
  const headerSize = Buffer.alloc(4);
  headerSize.writeUInt32LE(header.length);
  return {
    crx: Buffer.concat([Buffer.from("Cr24"), Buffer.from([3, 0, 0, 0]), headerSize, header, archive]),
    id: extensionIdFromPublicKey(publicKey),
    publicKey: Buffer.from(publicKey).toString("base64"),
  };
}

function encodeVarint(value) {
  const bytes = [];
  let rest = value;
  while (rest > 127) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function bytesField(fieldNumber, data) {
  const body = Buffer.from(data);
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(body.length), body]);
}
