import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECFieldFp;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.EllipticCurve;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;

/**
 * Generates `device-key.v1.json`, the published vectors of the rider device-key protocol (SECURITY_DESIGN.md section 13.6): the encodings of
 * `public_key` and `device_signature` and the signed message of a sign-in. It is run on the JDK the verifier service is pinned to, an
 * implementation independent of the Node tests that consume the file, and a close proxy for the Java security API the Rider app signs with:
 *
 *   java GenerateDeviceKeyVectors.java > device-key.v1.json
 *
 * It is deterministic (every key and every nonce comes from a seeded SHA1PRNG), so a second run gives the same bytes. It checks every
 * vector against its own intent before writing it: a vector the Java security API disagrees with stops the run. It holds no private key.
 */
public final class GenerateDeviceKeyVectors {
  private static final String PREFIX = "MELARC-RIDER-SIGNIN-V1";
  private static final BigInteger N =
      new BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16);
  private static final byte[] P256_SPKI_PREFIX = hex("3059301306072a8648ce3d020106082a8648ce3d030107034200");
  private static final byte[] P256_COMPRESSED_SPKI_PREFIX =
      hex("3039301306072a8648ce3d020106082a8648ce3d030107032200");

  private GenerateDeviceKeyVectors() {}

  // ---- deterministic randomness -------------------------------------------------------------------------------------------------

  private static SecureRandom rng(String label) throws Exception {
    SecureRandom random = SecureRandom.getInstance("SHA1PRNG");
    random.setSeed(("melarc-device-key-vectors-v1:" + label).getBytes(StandardCharsets.UTF_8));
    return random;
  }

  private static KeyPair ec(String curve, String label) throws Exception {
    KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
    generator.initialize(new ECGenParameterSpec(curve), rng(label));
    return generator.generateKeyPair();
  }

  // ---- helpers ------------------------------------------------------------------------------------------------------------------

  private static byte[] hex(String text) {
    byte[] out = new byte[text.length() / 2];
    for (int at = 0; at < out.length; at += 1) {
      out[at] = (byte) Integer.parseInt(text.substring(2 * at, 2 * at + 2), 16);
    }
    return out;
  }

  private static String b64(byte[] bytes) {
    return Base64.getEncoder().encodeToString(bytes);
  }

  private static String b64url(byte[] bytes) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  private static byte[] sha256(byte[] bytes) throws Exception {
    return MessageDigest.getInstance("SHA-256").digest(bytes);
  }

  private static byte[] concat(byte[]... parts) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (byte[] part : parts) out.write(part, 0, part.length);
    return out.toByteArray();
  }

  private static byte[] utf8(String text) {
    return text.getBytes(StandardCharsets.UTF_8);
  }

  private static String challenge(String label) throws Exception {
    return b64url(sha256(utf8("challenge:" + label)));
  }

  /** The signed message of a sign-in: the prefix, one 0x0A byte and the canonical challenge text. */
  private static byte[] message(String prefix, String challenge, String separator) {
    return utf8(prefix + separator + challenge);
  }

  private static byte[] spki(KeyPair pair) {
    return pair.getPublic().getEncoded();
  }

  // ---- DER ----------------------------------------------------------------------------------------------------------------------

  private static byte[] derLength(int length) {
    if (length < 0x80) return new byte[] {(byte) length};
    if (length < 0x100) return new byte[] {(byte) 0x81, (byte) length};
    return new byte[] {(byte) 0x82, (byte) (length >> 8), (byte) length};
  }

  private static byte[] derTlv(int tag, byte[] content) {
    return concat(new byte[] {(byte) tag}, derLength(content.length), content);
  }

  /** The minimal two's complement encoding of a non-negative integer. */
  private static byte[] derInteger(BigInteger value) {
    return derTlv(0x02, value.toByteArray());
  }

  private static byte[] derSequence(byte[]... parts) {
    return derTlv(0x30, concat(parts));
  }

  private static byte[] derSignature(BigInteger r, BigInteger s) {
    return derSequence(derInteger(r), derInteger(s));
  }

  private static BigInteger[] parseDerSignature(byte[] der) {
    int at = 2;
    if ((der[1] & 0x80) != 0) at = 2 + (der[1] & 0x7f);
    int rLength = der[at + 1] & 0xff;
    BigInteger r = new BigInteger(Arrays.copyOfRange(der, at + 2, at + 2 + rLength));
    int sAt = at + 2 + rLength;
    int sLength = der[sAt + 1] & 0xff;
    BigInteger s = new BigInteger(Arrays.copyOfRange(der, sAt + 2, sAt + 2 + sLength));
    return new BigInteger[] {r, s};
  }

  private static byte[] fixedWidth(BigInteger value) {
    byte[] raw = value.toByteArray();
    byte[] out = new byte[32];
    int copy = Math.min(raw.length, 32);
    System.arraycopy(raw, raw.length - copy, out, 32 - copy, copy);
    return out;
  }

  // ---- signing ------------------------------------------------------------------------------------------------------------------

  private static byte[] sign(KeyPair pair, byte[] message, String label) throws Exception {
    Signature signature = Signature.getInstance("SHA256withECDSA");
    signature.initSign(pair.getPrivate(), rng("sign:" + label));
    signature.update(message);
    return signature.sign();
  }

  // ---- the checks of the protocol, in Java --------------------------------------------------------------------------------------

  /** Whether `text` is a public key the protocol accepts: exactly the canonical base64 of a 91-byte P-256 SPKI, parsed and re-encoded alike. */
  private static boolean acceptsKey(String text) {
    try {
      if (text.length() != 124 || !text.matches("^[A-Za-z0-9+/]{121}[AQgw]==$")) return false;
      byte[] der = Base64.getDecoder().decode(text);
      if (der.length != 91 || !b64(der).equals(text)) return false;
      PublicKey key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(der));
      if (!(key instanceof ECPublicKey ec)) return false;
      if (ec.getParams().getOrder().bitLength() != 256 || !ec.getParams().toString().contains("secp256r1")) return false;
      if (!Arrays.equals(key.getEncoded(), der)) return false;
      // The point is on the curve (the parse above is not asked to check it).
      ECPoint w = ec.getW();
      EllipticCurve curve = ec.getParams().getCurve();
      BigInteger p = ((ECFieldFp) curve.getField()).getP();
      BigInteger x = w.getAffineX();
      BigInteger y = w.getAffineY();
      if (x.signum() < 0 || y.signum() < 0 || x.compareTo(p) >= 0 || y.compareTo(p) >= 0) return false;
      BigInteger left = y.pow(2).mod(p);
      BigInteger right = x.pow(3).add(curve.getA().multiply(x)).add(curve.getB()).mod(p);
      return left.equals(right);
    } catch (Exception failure) {
      return false;
    }
  }

  /**
   * The strict reader of a DER ECDSA signature the protocol requires: a short-form sequence of exactly two positive, minimally encoded
   * integers in 1 to n-1 and nothing after them. (The JDK's own reader is lenient: it reads an integer whose high bit is set as an unsigned
   * number, which DER forbids and OpenSSL and BoringSSL refuse. The protocol is DER, so this is the reference.)
   */
  private static boolean strictDerSignature(byte[] der) {
    int at = 0;
    if (der.length < 8 || der[at++] != 0x30) return false;
    int length = der[at++] & 0xff;
    if (length >= 0x80 || length != der.length - 2) return false;
    for (int integer = 0; integer < 2; integer += 1) {
      if (at + 2 > der.length || der[at++] != 0x02) return false;
      int size = der[at++] & 0xff;
      if (size == 0 || size >= 0x80 || at + size > der.length) return false;
      if ((der[at] & 0x80) != 0) return false;
      if (size > 1 && der[at] == 0 && (der[at + 1] & 0x80) == 0) return false;
      BigInteger value = new BigInteger(Arrays.copyOfRange(der, at, at + size));
      if (value.signum() <= 0 || value.compareTo(N) >= 0) return false;
      at += size;
    }
    return at == der.length;
  }

  /** Whether `signature` is accepted for `publicKey` over `challenge` by the protocol, as the Java security API decides it. */
  private static boolean acceptsSignature(String publicKey, String challenge, String signature) {
    try {
      if (!acceptsKey(publicKey)) return false;
      if (!signature.matches("^[A-Za-z0-9+/]+={0,2}$") || signature.length() < 12 || signature.length() > 96) return false;
      byte[] der = Base64.getDecoder().decode(signature);
      if (der.length < 8 || der.length > 72 || !b64(der).equals(signature) || !strictDerSignature(der)) return false;
      PublicKey key =
          KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(publicKey)));
      Signature verifier = Signature.getInstance("SHA256withECDSA");
      verifier.initVerify(key);
      verifier.update(message(PREFIX, challenge, "\n"));
      return verifier.verify(der);
    } catch (Exception failure) {
      return false;
    }
  }

  // ---- the vectors --------------------------------------------------------------------------------------------------------------

  private static final List<String> keyVectors = new ArrayList<>();
  private static final List<String> signatureVectors = new ArrayList<>();

  private static String quote(String text) {
    StringBuilder out = new StringBuilder("\"");
    for (char c : text.toCharArray()) {
      if (c == '"' || c == '\\') out.append('\\').append(c);
      else if (c == '\n') out.append("\\n");
      else if (c < 0x20 || c > 0x7e) out.append(String.format("\\u%04x", (int) c));
      else out.append(c);
    }
    return out.append('"').toString();
  }

  private static void keyVector(String name, String publicKey, boolean valid, String why) {
    if (acceptsKey(publicKey) != valid) {
      throw new IllegalStateException("The Java security API disagrees with the key vector: " + name);
    }
    keyVectors.add(
        "    { \"name\": " + quote(name) + ", \"public_key\": " + quote(publicKey) + ", \"valid\": " + valid
            + (why == null ? "" : ", \"why\": " + quote(why)) + " }");
  }

  private static void signatureVector(
      String name, String publicKey, String challenge, String signature, boolean valid, String why) {
    if (acceptsSignature(publicKey, challenge, signature) != valid) {
      throw new IllegalStateException("The Java security API disagrees with the signature vector: " + name);
    }
    signatureVectors.add(
        "    { \"name\": " + quote(name) + ", \"public_key\": " + quote(publicKey) + ", \"challenge\": " + quote(challenge)
            + ", \"signature\": " + quote(signature) + ", \"valid\": " + valid
            + (why == null ? "" : ", \"why\": " + quote(why)) + " }");
  }

  private static String flipLastBase64Bits(String key) {
    // The last character before the padding of a 91-byte value carries four bits that must be zero: raise one of them.
    String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    char last = key.charAt(key.length() - 3);
    char changed = alphabet.charAt(alphabet.indexOf(last) + 1);
    return key.substring(0, key.length() - 3) + changed + "==";
  }

  public static void main(String[] arguments) throws Exception {
    KeyPair a = ec("secp256r1", "key-a");
    KeyPair b = ec("secp256r1", "key-b");
    KeyPair p384 = ec("secp384r1", "key-p384");
    KeyPairGenerator rsaGenerator = KeyPairGenerator.getInstance("RSA");
    rsaGenerator.initialize(2048, rng("key-rsa"));
    KeyPair rsa = rsaGenerator.generateKeyPair();

    String keyA = b64(spki(a));
    String keyB = b64(spki(b));
    ECPublicKey ecA = (ECPublicKey) a.getPublic();

    // ---- public keys ----
    keyVector("a P-256 key", keyA, true, null);
    keyVector("another P-256 key", keyB, true, null);
    keyVector("an empty text", "", false, "nothing is a key");
    keyVector("the same key with a trailing newline", keyA + "\n", false, "whitespace is not part of the canonical form");
    keyVector("the same key with a space inside", keyA.substring(0, 60) + " " + keyA.substring(60), false, "whitespace is not part of the canonical form");
    keyVector("the same key without its padding", keyA.substring(0, keyA.length() - 2), false, "the canonical form is padded: 124 characters");
    keyVector("the same key with a non-zero spare bit in the last character", flipLastBase64Bits(keyA), false, "another spelling of the same bytes: one value, one representation");
    String urlSafe = keyA.replace('+', '-').replace('/', '_');
    if (!urlSafe.equals(keyA)) {
      keyVector("the same key in the URL-safe alphabet", urlSafe, false, "standard base64 only");
    }
    keyVector("a key with trailing DER data", b64(concat(spki(a), new byte[] {0})), false, "92 bytes: trailing data is rejected");
    keyVector("a key one byte short", b64(Arrays.copyOf(spki(a), 90)), false, "90 bytes");
    keyVector("a key on the P-384 curve", b64(spki(p384)), false, "another curve");
    // The JDK has no secp256k1, so the SubjectPublicKeyInfo of that curve's identifier is built by hand around a point of the P-256 key.
    byte[] k1Header = hex("3056301006072a8648ce3d020106052b8104000a034200");
    keyVector("a key naming the secp256k1 curve", b64(concat(k1Header, Arrays.copyOfRange(spki(a), 26, 91))), false, "another curve: 88 bytes");
    keyVector("an RSA key", b64(spki(rsa)), false, "not an elliptic-curve key");
    byte[] compressed =
        concat(
            P256_COMPRESSED_SPKI_PREFIX,
            new byte[] {(byte) (ecA.getW().getAffineY().testBit(0) ? 0x03 : 0x02)},
            fixedWidth(ecA.getW().getAffineX()));
    keyVector("a P-256 key with a compressed point", b64(compressed), false, "an uncompressed point is required: 59 bytes");
    byte[] offCurve = spki(a).clone();
    offCurve[offCurve.length - 1] ^= 0x01;
    keyVector("a P-256 key whose point is not on the curve", b64(offCurve), false, "the point must be on the curve");
    keyVector("91 zero bytes", b64(new byte[91]), false, "not a SubjectPublicKeyInfo");
    keyVector("a SubjectPublicKeyInfo header and a zero point", b64(concat(P256_SPKI_PREFIX, new byte[65])), false, "an uncompressed point marker is required");

    // ---- signatures ----
    String c1 = challenge("one");
    String c2 = challenge("two");
    byte[] good1 = sign(a, message(PREFIX, c1, "\n"), "a-c1");
    byte[] good2 = sign(a, message(PREFIX, c2, "\n"), "a-c2");
    signatureVector("a valid signature over the first challenge", keyA, c1, b64(good1), true, null);
    signatureVector("a valid signature over the second challenge", keyA, c2, b64(good2), true, null);

    signatureVector("a signature over a different challenge", keyA, c2, b64(good1), false, "the challenge is part of the message");
    signatureVector("a signature for the same challenge by another key", keyA, c1, b64(sign(b, message(PREFIX, c1, "\n"), "b-c1")), false, "another key's signature");
    signatureVector("a valid signature checked against another key", keyB, c1, b64(good1), false, "the registered key is the binding");
    signatureVector("a changed prefix (version 2)", keyA, c1, b64(sign(a, message("MELARC-RIDER-SIGNIN-V2", c1, "\n"), "a-v2")), false, "the prefix names the protocol and its version");
    signatureVector("the prefix of another purpose (an enrolment)", keyA, c1, b64(sign(a, message("MELARC-RIDER-ENROL-V1", c1, "\n"), "a-enrol")), false, "cross-purpose replay: a signature made for another purpose is no sign-in");
    signatureVector("no separator byte", keyA, c1, b64(sign(a, message(PREFIX, c1, ""), "a-nosep")), false, "one 0x0A byte separates the prefix from the challenge");
    signatureVector("a carriage return and line feed as the separator", keyA, c1, b64(sign(a, message(PREFIX, c1, "\r\n"), "a-crlf")), false, "exactly one 0x0A byte");
    signatureVector("a trailing newline in the signed message", keyA, c1, b64(sign(a, concat(message(PREFIX, c1, "\n"), new byte[] {0x0a}), "a-trail")), false, "no trailing newline");
    signatureVector("a message hashed before signing (a double hash)", keyA, c1, b64(sign(a, sha256(message(PREFIX, c1, "\n")), "a-double")), false, "the verifier supplies SHA-256 once and never pre-hashes");

    BigInteger[] rs = parseDerSignature(good1);
    BigInteger r = rs[0];
    BigInteger s = rs[1];
    signatureVector("a high-S twin of a valid signature", keyA, c1, b64(derSignature(r, N.subtract(s))), true, "the same signature to ECDSA: replay protection is the challenge's state and never the uniqueness of signature bytes");
    byte[] p1363 = concat(fixedWidth(r), fixedWidth(s));
    signatureVector("the same signature in the IEEE P1363 form (r then s, 64 bytes)", keyA, c1, b64(p1363), false, "DER is required");
    signatureVector("a signature with a non-minimal length (long form for a short sequence)", keyA, c1,
        b64(concat(new byte[] {0x30, (byte) 0x81, (byte) (derSequence(derInteger(r), derInteger(s)).length - 2)}, Arrays.copyOfRange(derSignature(r, s), 2, derSignature(r, s).length))), false, "not DER");
    byte[] padded = derSequence(derTlv(0x02, concat(new byte[] {0x00}, r.toByteArray())), derInteger(s));
    signatureVector("an integer with an unnecessary leading zero", keyA, c1, b64(padded), false, "not minimal DER");
    signatureVector("trailing bytes after the sequence", keyA, c1, b64(concat(good1, new byte[] {0})), false, "no trailing data");
    signatureVector("a truncated signature", keyA, c1, b64(Arrays.copyOf(good1, good1.length - 1)), false, "the length does not match");
    signatureVector("an integer that is negative", keyA, c1, b64(derSequence(derTlv(0x02, fixedWidth(r.setBit(255))), derInteger(s))), false, "r must be a positive integer: DER forbids a set high bit without a leading zero, though the JDK reads one as unsigned");
    signatureVector("a zero r", keyA, c1, b64(derSignature(BigInteger.ZERO, s)), false, "r must be in 1 to n-1");
    signatureVector("a zero s", keyA, c1, b64(derSignature(r, BigInteger.ZERO)), false, "s must be in 1 to n-1");
    signatureVector("an r equal to the order of the curve", keyA, c1, b64(derSignature(N, s)), false, "r must be in 1 to n-1");
    signatureVector("an empty integer", keyA, c1, b64(derSequence(derTlv(0x02, new byte[0]), derInteger(s))), false, "an integer has content");
    signatureVector("an indefinite length (BER)", keyA, c1,
        b64(concat(new byte[] {0x30, (byte) 0x80}, derInteger(r), derInteger(s), new byte[] {0x00, 0x00})), false, "not DER");
    signatureVector("seven bytes", keyA, c1, b64(Arrays.copyOf(good1, 7)), false, "shorter than the 8 bytes a signature has at least");
    signatureVector("seventy-three bytes", keyA, c1, b64(Arrays.copyOf(concat(good1, new byte[40]), 73)), false, "longer than the 72 bytes a signature has at most");
    // Spellings of a valid signature that are not the canonical one, for whichever of the valid signatures has the character to change.
    for (String[] candidate : new String[][] {{c1, b64(good1)}, {c2, b64(good2)}}) {
      String url = candidate[1].replace('+', '-').replace('/', '_');
      if (!url.equals(candidate[1])) {
        signatureVector("a valid signature in the URL-safe alphabet", keyA, candidate[0], url, false, "standard base64 only");
        break;
      }
    }
    for (String[] candidate : new String[][] {{c1, b64(good1)}, {c2, b64(good2)}}) {
      if (candidate[1].endsWith("=")) {
        signatureVector("a valid signature without its padding", keyA, candidate[0], candidate[1].replaceAll("=+$", ""), false, "the canonical form is padded");
        break;
      }
    }
    signatureVector("a valid signature with whitespace inside", keyA, c1, b64(good1).substring(0, 10) + " " + b64(good1).substring(10), false, "whitespace is not part of the canonical form");
    signatureVector("a valid signature with a trailing newline", keyA, c1, b64(good1) + "\n", false, "whitespace is not part of the canonical form");
    signatureVector("an empty signature", keyA, c1, "", false, "nothing is a signature");
    signatureVector("a signature that is not base64", keyA, c1, "not*base64*at*all!", false, "invalid base64");

    StringBuilder out = new StringBuilder();
    out.append("{\n");
    out.append("  \"format\": \"melarc.device-key-vectors.v1\",\n");
    out.append("  \"source\": \"GenerateDeviceKeyVectors.java on the pinned JDK; deterministic, see the README\",\n");
    out.append("  \"protocol\": {\n");
    out.append("    \"signed_message\": \"UTF-8 bytes of MELARC-RIDER-SIGNIN-V1, one 0x0A byte, then the canonical challenge text\",\n");
    out.append("    \"signature\": \"ECDSA P-256 with SHA-256 over those bytes, as the canonical standard base64 of an ASN.1 DER signature of 8 to 72 bytes\",\n");
    out.append("    \"public_key\": \"the canonical standard base64 of the 91-byte DER SubjectPublicKeyInfo of an uncompressed P-256 key: 124 characters\"\n");
    out.append("  },\n");
    out.append("  \"public_keys\": [\n").append(String.join(",\n", keyVectors)).append("\n  ],\n");
    out.append("  \"signatures\": [\n").append(String.join(",\n", signatureVectors)).append("\n  ]\n");
    out.append("}\n");
    System.out.print(out);
  }
}
