package com.melarc.attestation.fixtures

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.MessageDigest
import java.time.Instant
import java.util.Date
import org.bouncycastle.asn1.ASN1Boolean
import org.bouncycastle.asn1.ASN1Encodable
import org.bouncycastle.asn1.ASN1Integer
import org.bouncycastle.asn1.ASN1ObjectIdentifier
import org.bouncycastle.asn1.DERBitString
import org.bouncycastle.asn1.DEROctetString
import org.bouncycastle.asn1.DERSequence
import org.bouncycastle.asn1.DERTaggedObject
import org.bouncycastle.asn1.sec.SECObjectIdentifiers
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x500.X500NameBuilder
import org.bouncycastle.asn1.x500.style.BCStyle
import org.bouncycastle.asn1.x509.AlgorithmIdentifier
import org.bouncycastle.asn1.x509.BasicConstraints
import org.bouncycastle.asn1.x509.KeyUsage
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.bouncycastle.asn1.x509.Time
import org.bouncycastle.asn1.x9.X9ObjectIdentifiers
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.ec.CustomNamedCurves
import org.bouncycastle.crypto.params.ECNamedDomainParameters
import org.bouncycastle.crypto.params.ECPrivateKeyParameters
import org.bouncycastle.crypto.params.ECPublicKeyParameters
import org.bouncycastle.crypto.signers.ECDSASigner
import org.bouncycastle.crypto.signers.HMacDSAKCalculator
import org.bouncycastle.crypto.util.SubjectPublicKeyInfoFactory

/**
 * A small public-key infrastructure for tests, **deterministic and independent of the code it tests**: keys come from their labels, signatures
 * are RFC 6979 (no randomness), and the certificates are assembled here, field by field, with BouncyCastle's ASN.1 types alone. It uses
 * neither the vendored library's builders nor the JDK's certificate machinery, so a misreading shared by the code under test and its own
 * fixtures cannot make a wrong chain look right. Every key is a test key and says so: nothing here is a secret.
 */
fun sha256(vararg parts: ByteArray): ByteArray {
  val digest = MessageDigest.getInstance("SHA-256")
  parts.forEach { digest.update(it) }
  return digest.digest()
}

fun sha256(text: String): ByteArray = sha256(text.toByteArray(Charsets.UTF_8))

fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

/** A P-256 key derived from its label alone: `SHA-256("melarc-attestation-fixture-key:" + label + ":" + counter)` as the private scalar. */
class TestKey(val label: String) {
  val privateParameters: ECPrivateKeyParameters
  val publicParameters: ECPublicKeyParameters

  init {
    var counter = 0
    var scalar: BigInteger
    do {
      scalar = BigInteger(1, sha256("melarc-attestation-fixture-key:$label:$counter"))
      counter += 1
    } while (scalar.signum() == 0 || scalar >= DOMAIN.n)
    privateParameters = ECPrivateKeyParameters(scalar, DOMAIN)
    publicParameters = ECPublicKeyParameters(DOMAIN.g.multiply(scalar).normalize(), DOMAIN)
  }

  val subjectPublicKeyInfo: SubjectPublicKeyInfo = SubjectPublicKeyInfoFactory.createSubjectPublicKeyInfo(publicParameters)

  /** The canonical DER SubjectPublicKeyInfo of the public key: 91 bytes, named curve, uncompressed point. */
  val spki: ByteArray = subjectPublicKeyInfo.getEncoded("DER")

  companion object {
    private val CURVE = CustomNamedCurves.getByName("secp256r1")
    val DOMAIN = ECNamedDomainParameters(SECObjectIdentifiers.secp256r1, CURVE.curve, CURVE.g, CURVE.n, CURVE.h, CURVE.seed)
  }
}

/** ECDSA with SHA-256, the nonce from RFC 6979: the same key and message give the same signature on every run. */
private fun sign(key: TestKey, message: ByteArray): ByteArray {
  val signer = ECDSASigner(HMacDSAKCalculator(SHA256Digest()))
  signer.init(true, key.privateParameters)
  val (r, s) = signer.generateSignature(sha256(message)).let { it[0] to it[1] }
  return DERSequence(arrayOf(ASN1Integer(r), ASN1Integer(s))).getEncoded("DER")
}

/** One extension as it is written into a certificate: its object identifier, its critical flag, and the DER the OCTET STRING holds. */
class RawExtension(val oid: ASN1ObjectIdentifier, val critical: Boolean, val value: ByteArray) {
  fun toAsn1(): DERSequence {
    val members = mutableListOf<ASN1Encodable>(oid)
    if (critical) members += ASN1Boolean.TRUE
    members += DEROctetString(value)
    return DERSequence(members.toTypedArray())
  }
}

class Validity(val notBefore: Instant, val notAfter: Instant) {
  companion object {
    /** Valid at the fixtures' instant and at any real instant in the next twenty years. */
    val GOOD = Validity(Instant.parse("2026-01-01T00:00:00Z"), Instant.parse("2046-01-01T00:00:00Z"))

    /** Over before the fixtures' instant, and before any real instant the tests will run at. */
    val EXPIRED = Validity(Instant.parse("2025-01-01T00:00:00Z"), Instant.parse("2026-02-01T00:00:00Z"))

    /** Begins after the next twenty years' worth of tests. */
    val NOT_YET = Validity(Instant.parse("2045-01-01T00:00:00Z"), Instant.parse("2046-01-01T00:00:00Z"))
  }
}

fun name(vararg parts: Pair<ASN1ObjectIdentifier, String>): X500Name {
  val builder = X500NameBuilder(BCStyle.INSTANCE)
  parts.forEach { (oid, value) -> builder.addRDN(oid, value) }
  return builder.build()
}

/** A certificate, field by field. [extensions] is written as given, in order, **including a repeated one**. */
class CertificateSpec(
  val issuer: X500Name,
  val subject: X500Name,
  val serial: BigInteger,
  val validity: Validity,
  val subjectKey: TestKey,
  val signingKey: TestKey,
  val extensions: List<RawExtension> = emptyList(),
)

object Certificates {
  private val ECDSA_SHA256 = AlgorithmIdentifier(X9ObjectIdentifiers.ecdsa_with_SHA256)

  fun certificateAuthorityExtensions(): List<RawExtension> =
    listOf(
      RawExtension(org.bouncycastle.asn1.x509.Extension.basicConstraints, true, BasicConstraints(true).getEncoded("DER")),
      RawExtension(
        org.bouncycastle.asn1.x509.Extension.keyUsage,
        true,
        KeyUsage(KeyUsage.keyCertSign or KeyUsage.cRLSign).getEncoded("DER"),
      ),
    )

  /** The DER of the certificate, signed with [CertificateSpec.signingKey]. */
  fun build(spec: CertificateSpec): ByteArray {
    val tbs = tbs(spec)
    val signature = sign(spec.signingKey, tbs.getEncoded("DER"))
    return DERSequence(arrayOf(tbs, ECDSA_SHA256, DERBitString(signature))).getEncoded("DER")
  }

  private fun tbs(spec: CertificateSpec): DERSequence {
    val members =
      mutableListOf<ASN1Encodable>(
        DERTaggedObject(true, 0, ASN1Integer(2)),
        ASN1Integer(spec.serial),
        ECDSA_SHA256,
        spec.issuer,
        DERSequence(
          arrayOf(Time(Date.from(spec.validity.notBefore)), Time(Date.from(spec.validity.notAfter)))
        ),
        spec.subject,
        spec.subjectKey.subjectPublicKeyInfo,
      )
    if (spec.extensions.isNotEmpty()) {
      members += DERTaggedObject(true, 3, DERSequence(spec.extensions.map { it.toAsn1() }.toTypedArray()))
    }
    return DERSequence(members.toTypedArray())
  }

  /** A serial number of 16 bytes, derived from its label, positive. */
  fun serial(label: String): BigInteger = BigInteger(1, sha256("melarc-attestation-fixture-serial:$label").copyOf(16))
}

/** The bytes of a chain, leaf first, as a handset sends it. */
fun ByteArrayOutputStream.writeAll(vararg parts: ByteArray) = parts.forEach { write(it) }
