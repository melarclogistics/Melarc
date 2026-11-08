package com.melarc.attestation.fixtures

import com.melarc.attestation.IntegrityCause
import com.melarc.attestation.Metrics
import com.melarc.attestation.PolicyVerifier
import com.melarc.attestation.StructuredLog
import com.melarc.attestation.TrustState
import com.melarc.attestation.VerifyRequest
import com.melarc.attestation.fixtures.KeyDescriptionEncoder.ApplicationIdSpec
import com.melarc.attestation.fixtures.KeyDescriptionEncoder.AuthorizationSpec
import com.melarc.attestation.fixtures.KeyDescriptionEncoder.KeyDescriptionSpec
import com.melarc.attestation.fixtures.KeyDescriptionEncoder.RootOfTrustSpec
import java.io.ByteArrayInputStream
import java.io.OutputStream
import java.io.PrintStream
import java.math.BigInteger
import java.security.cert.CertificateFactory
import java.security.cert.TrustAnchor
import java.security.cert.X509Certificate
import java.time.Instant
import java.time.InstantSource
import org.bouncycastle.asn1.ASN1Encodable
import org.bouncycastle.asn1.ASN1Enumerated
import org.bouncycastle.asn1.ASN1Integer
import org.bouncycastle.asn1.DEROctetString
import org.bouncycastle.asn1.DERSequence
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x500.style.BCStyle

/** What a fixture is held to. */
sealed interface Expected {
  /** Accepted: the level the library reports, and the signing digests the answer carries. */
  data class Verified(val securityLevel: String, val signers: List<ByteArray>) : Expected

  data class IntegrityFailed(val cause: IntegrityCause) : Expected

  data object SecurityUnsupported : Expected
}

/** One chain, the request it is sent in, and the verdict it must get. */
class FixtureCase(
  val name: String,
  val description: String,
  val chain: List<ByteArray>,
  /** The 32 bytes issued with the grant. */
  val issuedChallenge: ByteArray,
  /** The submitted key: the canonical DER SubjectPublicKeyInfo. */
  val devicePublicKey: ByteArray,
  /** The serials (lower-case hexadecimal) the revocation list holds for this case, besides the decoy every list has. */
  val revokedSerials: Set<String>,
  val expected: Expected,
) {
  fun request(): VerifyRequest = VerifyRequest(chain, sha256(issuedChallenge), devicePublicKey)
}

enum class Root(val subject: X500Name, val key: TestKey) {
  A(name(BCStyle.CN to "Melarc Test Attestation Root A", BCStyle.O to "Melarc Test"), TestKey("root-a")),
  B(name(BCStyle.CN to "Melarc Test Attestation Root B", BCStyle.O to "Melarc Test"), TestKey("root-b")),
  UNKNOWN(name(BCStyle.CN to "Melarc Test Unknown Root", BCStyle.O to "Somebody Else"), TestKey("root-unknown")),

  /** Bears the name of [A] and holds another key. */
  IMPOSTOR_OF_A(name(BCStyle.CN to "Melarc Test Attestation Root A", BCStyle.O to "Melarc Test"), TestKey("root-impostor"));

  val certificate: ByteArray by lazy {
    Certificates.build(
      CertificateSpec(
        issuer = subject,
        subject = subject,
        serial = Certificates.serial("root:$name"),
        validity = Validity.GOOD,
        subjectKey = key,
        signingKey = key,
        extensions = Certificates.certificateAuthorityExtensions(),
      )
    )
  }
}

enum class Provisioning {
  /** root, an intermediate whose name carries a serial number, the attestation certificate, the leaf. */
  FACTORY,

  /** root, `Droid CA2` of Google LLC, a server certificate, the attestation certificate, the leaf. */
  REMOTELY,
}

enum class LeafExtension {
  NORMAL,
  NONE,
  CRITICAL,
  DUPLICATED,
}

/** How a chain differs from a well-formed one. */
class ChainPlan(
  val provisioning: Provisioning = Provisioning.FACTORY,
  val root: Root = Root.A,
  val intermediateValidity: Validity = Validity.GOOD,
  val serverValidity: Validity = Validity.GOOD,
  val attestationValidity: Validity = Validity.GOOD,
  val leafValidity: Validity = Validity.GOOD,
  /** The issuer the attestation certificate names, when it is not the certificate above it. */
  val attestationIssuer: X500Name? = null,
  /** Extensions the attestation certificate carries besides the CA ones. */
  val attestationExtensions: List<RawExtension> = emptyList(),
)

class BuiltChain(val certificates: List<ByteArray>, val serials: Map<String, BigInteger>)

object Chains {
  val LEAF_SUBJECT: X500Name = name(BCStyle.CN to "Android Keystore Key")

  /** A chain, leaf first and the root last, every certificate signed by the one above it. */
  fun build(label: String, plan: ChainPlan, leafKey: TestKey, leafExtensions: List<RawExtension>): BuiltChain {
    val root = plan.root
    val serials = linkedMapOf<String, BigInteger>()
    fun serial(role: String): BigInteger = Certificates.serial("$label:$role").also { serials[role] = it }

    val intermediateKey = TestKey("$label:intermediate")
    val serverKey = TestKey("$label:server")
    val attestationKey = TestKey("$label:attestation")
    val ca = Certificates.certificateAuthorityExtensions()

    val intermediateSubject =
      when (plan.provisioning) {
        Provisioning.FACTORY ->
          name(BCStyle.SERIALNUMBER to sha256(label).hex().take(16), BCStyle.CN to "Melarc Test Factory Intermediate")
        Provisioning.REMOTELY -> name(BCStyle.CN to "Droid CA2", BCStyle.O to "Google LLC")
      }
    val intermediate =
      Certificates.build(
        CertificateSpec(root.subject, intermediateSubject, serial("intermediate"), plan.intermediateValidity, intermediateKey, root.key, ca)
      )

    val certificates = mutableListOf<ByteArray>()
    val attestationSigner: TestKey
    val attestationParent: X500Name
    when (plan.provisioning) {
      Provisioning.FACTORY -> {
        attestationSigner = intermediateKey
        attestationParent = intermediateSubject
      }
      Provisioning.REMOTELY -> {
        val serverSubject = name(BCStyle.CN to "Melarc Test RKP Server", BCStyle.O to "Google LLC")
        certificates +=
          Certificates.build(
            CertificateSpec(intermediateSubject, serverSubject, serial("server"), plan.serverValidity, serverKey, intermediateKey, ca)
          )
        attestationSigner = serverKey
        attestationParent = serverSubject
      }
    }
    val attestationSubject = name(BCStyle.CN to "Melarc Test Attestation", BCStyle.O to "TEE")
    val attestation =
      Certificates.build(
        CertificateSpec(
          plan.attestationIssuer ?: attestationParent,
          attestationSubject,
          serial("attestation"),
          plan.attestationValidity,
          attestationKey,
          attestationSigner,
          ca + plan.attestationExtensions,
        )
      )
    val leaf =
      Certificates.build(
        CertificateSpec(attestationSubject, LEAF_SUBJECT, serial("leaf"), plan.leafValidity, leafKey, attestationKey, leafExtensions)
      )

    // Leaf first, the root last: the order a handset sends.
    val chain = mutableListOf(leaf, attestation)
    chain += certificates.reversed()
    chain += intermediate
    chain += root.certificate
    return BuiltChain(chain, serials)
  }
}

/** The state of one fixture while it is being altered. */
class CaseContext(val name: String, val deviceKey: TestKey, val built: BuiltChain, val chain: MutableList<ByteArray>) {
  var submittedKey: ByteArray = deviceKey.spki
}

object FixtureWorld {
  const val PACKAGE = "com.melarc.rider"
  val INSTANT: Instant = Instant.parse("2026-10-20T12:00:00Z")

  val SIGNER_1: ByteArray = sha256("melarc-test-signer-1")
  val SIGNER_2: ByteArray = sha256("melarc-test-signer-2")
  val SIGNER_OTHER: ByteArray = sha256("melarc-test-signer-other")
  val APPROVED_DIGESTS: Set<String> = setOf(SIGNER_1.hex(), SIGNER_2.hex())

  val BOOT_KEY: ByteArray = sha256("melarc-test-boot-key")
  val BOOT_HASH: ByteArray = sha256("melarc-test-boot-hash")

  /** A serial every revocation list holds, so that a list is never empty and a chain is judged against a list that has entries. */
  const val DECOY_SERIAL = "1d3c5a7e9f"

  val ACCEPTED_ROOTS: List<Root> = listOf(Root.A, Root.B)

  fun x509(der: ByteArray): X509Certificate =
    CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate

  fun anchors(roots: List<Root> = ACCEPTED_ROOTS): Set<TrustAnchor> =
    roots.map { TrustAnchor(x509(it.certificate), null) }.toCollection(linkedSetOf())

  fun trust(revoked: Set<String> = emptySet(), at: Instant = INSTANT): TrustState.Fresh =
    TrustState.Fresh(roots = anchors(), revoked = revoked + DECOY_SERIAL, fetchedAt = at)

  fun silentLog(): StructuredLog = StructuredLog(PrintStream(OutputStream.nullOutputStream()))

  fun policy(
    metrics: Metrics = Metrics(),
    now: Instant = INSTANT,
    packageName: String = PACKAGE,
    digests: Set<String> = APPROVED_DIGESTS,
  ): PolicyVerifier = PolicyVerifier(PolicyVerifier.Policy(packageName, digests), InstantSource.fixed(now), metrics, silentLog())

  /** The accepted roots as the file the service reads: a JSON array of PEM texts. */
  fun acceptedRootsJson(roots: List<Root> = ACCEPTED_ROOTS): String =
    roots.joinToString(prefix = "[", postfix = "]", separator = ",") { "\"" + pem(it.certificate).replace("\n", "\\n") + "\"" }

  fun pem(der: ByteArray): String =
    "-----BEGIN CERTIFICATE-----\n" +
      java.util.Base64.getMimeEncoder(64, "\n".toByteArray()).encodeToString(der) +
      "\n-----END CERTIFICATE-----\n"
}

/**
 * The adversarial chains of the verifier's policy (SECURITY_DESIGN.md 15.2.1): a well-formed chain for each way the policy accepts one, and
 * one chain for each way it must refuse, each built from nothing but this file and [DeterministicPki]. A chain differs from the accepted
 * one in **one thing**, except where a case says it is testing the order of the steps (then the earlier step is the one that must answer).
 */
object AttestationFixtures {
  val cases: List<FixtureCase> by lazy { Maker().apply { define() }.cases.toList() }

  fun named(name: String): FixtureCase = cases.single { it.name == name }

  private const val CREATED_MS = 1_790_000_000_000L

  private fun hardwareList() =
    AuthorizationSpec(
      purposes = listOf(2),
      algorithm = 3,
      keySize = 256,
      digests = listOf(4),
      ecCurve = 1,
      noAuthRequired = true,
      origin = 0,
      rootOfTrust = RootOfTrustSpec(FixtureWorld.BOOT_KEY, true, 0, FixtureWorld.BOOT_HASH),
      osVersion = 150000,
      osPatchLevel = 202609,
    )

  private fun validDescription(challenge: ByteArray): KeyDescriptionSpec =
    KeyDescriptionSpec(
      challenge = challenge,
      software =
        AuthorizationSpec(
          creationDateTime = CREATED_MS,
          applicationId = ApplicationIdSpec(listOf(FixtureWorld.PACKAGE to 1L), listOf(FixtureWorld.SIGNER_1)),
        ),
      hardware = hardwareList(),
    )

  private fun verified(level: String = "TRUSTED_ENVIRONMENT", signers: List<ByteArray> = listOf(FixtureWorld.SIGNER_1)) =
    Expected.Verified(level, signers)

  private fun failed(cause: IntegrityCause) = Expected.IntegrityFailed(cause)

  private fun withApplication(spec: KeyDescriptionSpec, packages: List<Pair<String, Long>>, signers: List<ByteArray>) =
    spec.copy(software = spec.software.copy(applicationId = ApplicationIdSpec(packages, signers)))

  private fun withRootOfTrust(spec: KeyDescriptionSpec, rootOfTrust: RootOfTrustSpec?) =
    spec.copy(hardware = spec.hardware.copy(rootOfTrust = rootOfTrust))

  private fun withHardware(spec: KeyDescriptionSpec, change: (AuthorizationSpec) -> AuthorizationSpec) =
    spec.copy(hardware = change(spec.hardware))

  private fun locked(state: Int, locked: Boolean = true) =
    RootOfTrustSpec(FixtureWorld.BOOT_KEY, locked, state, FixtureWorld.BOOT_HASH)

  /** A DER SEQUENCE around [content], written by hand so that thousands of levels cost nothing. */
  private fun wrapSequence(content: ByteArray): ByteArray {
    val length = content.size
    val header =
      when {
        length < 0x80 -> byteArrayOf(0x30, length.toByte())
        length < 0x100 -> byteArrayOf(0x30, 0x81.toByte(), length.toByte())
        length < 0x10000 -> byteArrayOf(0x30, 0x82.toByte(), (length shr 8).toByte(), length.toByte())
        else -> byteArrayOf(0x30, 0x83.toByte(), (length shr 16).toByte(), (length shr 8).toByte(), length.toByte())
      }
    return header + content
  }

  private fun tamperSignature(der: ByteArray): ByteArray =
    der.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 0x01).toByte() }

  private class Maker {
    val cases = mutableListOf<FixtureCase>()

    fun case(
      name: String,
      description: String,
      expected: Expected,
      plan: ChainPlan = ChainPlan(),
      /** The challenge the key description carries, when it is not the one issued with the grant. */
      attestedChallenge: ByteArray? = null,
      description_: (KeyDescriptionSpec) -> KeyDescriptionSpec = { it },
      /** Replaces the DER of the key description, as written, before it goes into the leaf. */
      extensionBytes: ((ByteArray) -> ByteArray)? = null,
      leaf: LeafExtension = LeafExtension.NORMAL,
      /** The roles whose certificates the revocation list holds. */
      revoke: List<String> = emptyList(),
      alter: CaseContext.() -> Unit = {},
    ) {
      val issued = sha256("melarc-attestation-fixture-challenge:$name")
      val deviceKey = TestKey("device-key:$name")
      var spec = description_(validDescription(issued))
      if (attestedChallenge != null) spec = spec.copy(challenge = attestedChallenge)
      val encoded = KeyDescriptionEncoder.keyDescription(spec).getEncoded("DER")
      val written = extensionBytes?.invoke(encoded) ?: encoded
      val extension = RawExtension(KeyDescriptionEncoder.OID, leaf == LeafExtension.CRITICAL, written)
      val extensions =
        when (leaf) {
          LeafExtension.NORMAL,
          LeafExtension.CRITICAL -> listOf(extension)
          LeafExtension.NONE -> emptyList()
          LeafExtension.DUPLICATED -> listOf(extension, extension)
        }
      val built = Chains.build(name, plan, deviceKey, extensions)
      val context = CaseContext(name, deviceKey, built, built.certificates.toMutableList())
      context.alter()
      cases +=
        FixtureCase(
          name = name,
          description = description,
          chain = context.chain.toList(),
          issuedChallenge = issued,
          devicePublicKey = context.submittedKey,
          revokedSerials = revoke.map { built.serials.getValue(it).toString(16) }.toSet(),
          expected = expected,
        )
    }

    fun define() {
      accepted()
      structure()
      chainValidity()
      trust()
      securityLevel()
      challenge()
      application()
      deviceState()
      keyProperties()
      keyBinding()
      order()
    }

    // ---- accepted: each way the policy says yes --------------------------------------------------------------------------------

    private fun accepted() {
      case("valid_trusted_environment", "A factory-provisioned chain, a hardware-backed key on a locked, verified device.", verified())
      case(
        "valid_strongbox",
        "The same, attested by StrongBox: the level reported is the lower of the two levels in the description.",
        verified("STRONG_BOX"),
        description_ = { it.copy(attestationSecurityLevel = 2, keyMintSecurityLevel = 2) },
      )
      case(
        "valid_lower_of_two_levels",
        "Attestation by StrongBox of a key held in the trusted environment: the lower level is reported.",
        verified("TRUSTED_ENVIRONMENT"),
        description_ = { it.copy(attestationSecurityLevel = 2, keyMintSecurityLevel = 1) },
      )
      case(
        "valid_remotely_provisioned",
        "A chain of the remotely provisioned shape: five certificates, the intermediate `Droid CA2` of Google LLC.",
        verified(),
        plan = ChainPlan(provisioning = Provisioning.REMOTELY),
      )
      case(
        "valid_second_accepted_root",
        "A chain that ends at the second of the accepted roots.",
        verified(),
        plan = ChainPlan(root = Root.B),
      )
      case(
        "valid_rotated_signer",
        "The app signed with the rotated certificate: the second approved digest.",
        verified(signers = listOf(FixtureWorld.SIGNER_2)),
        description_ = { withApplication(it, listOf(FixtureWorld.PACKAGE to 1L), listOf(FixtureWorld.SIGNER_2)) },
      )
      case(
        "valid_both_approved_signers",
        "A key that reports both approved signing certificates (an app signed with a rotation lineage).",
        verified(signers = listOf(FixtureWorld.SIGNER_1, FixtureWorld.SIGNER_2)),
        description_ = {
          withApplication(it, listOf(FixtureWorld.PACKAGE to 1L), listOf(FixtureWorld.SIGNER_1, FixtureWorld.SIGNER_2))
        },
      )
      case(
        "valid_expired_factory_certificates",
        "The factory intermediate and attestation certificate are past their validity: the design's one exception (15.2.1 step 3).",
        verified(),
        plan = ChainPlan(intermediateValidity = Validity.EXPIRED, attestationValidity = Validity.EXPIRED),
      )
      case(
        "valid_expired_leaf",
        "The leaf's own validity is never judged: it is set on the device.",
        verified(),
        plan = ChainPlan(leafValidity = Validity.EXPIRED),
      )
      case(
        "valid_purposes_include_verify",
        "A key that may also verify: the signing purpose is among its purposes.",
        verified(),
        description_ = { withHardware(it) { list -> list.copy(purposes = listOf(2, 3)) } },
      )
      case(
        "valid_more_digests_than_sha256",
        "A key that allows several digests, SHA-256 among them.",
        verified(),
        description_ = { withHardware(it) { list -> list.copy(digests = listOf(4, 5, 6)) } },
      )
      case(
        "valid_no_boot_hash",
        "A root of trust of three members, the form older devices send.",
        verified(),
        description_ = { withRootOfTrust(it, RootOfTrustSpec(FixtureWorld.BOOT_KEY, true, 0, null)) },
      )
    }

    // ---- structure: step 1 ----------------------------------------------------------------------------------------------------

    private fun structure() {
      val malformed = failed(IntegrityCause.EVIDENCE_MALFORMED)
      case("chain_of_two", "Leaf and root alone: three certificates are the least.", malformed) {
        chain.removeAt(1)
        chain.removeAt(1)
      }
      case("chain_without_root", "The root is not the last certificate.", malformed) { chain.removeAt(chain.size - 1) }
      case("chain_in_reverse", "The root first and the leaf last.", malformed) { chain.reverse() }
      case("leaf_without_extension", "The first certificate has no attestation extension.", malformed, leaf = LeafExtension.NONE)
      case("leaf_extension_critical", "The extension is marked critical: the library reads only a non-critical one.", malformed, leaf = LeafExtension.CRITICAL)
      case("leaf_extension_duplicated", "Two attestation extensions in one certificate (not valid X.509).", malformed, leaf = LeafExtension.DUPLICATED)
      case(
        "extension_on_attestation_certificate",
        "The certificate above the leaf carries an attestation extension too.",
        malformed,
        plan =
          ChainPlan(
            attestationExtensions =
              listOf(
                RawExtension(
                  KeyDescriptionEncoder.OID,
                  false,
                  KeyDescriptionEncoder.keyDescription(validDescription(ByteArray(32))).getEncoded("DER"),
                )
              )
          ),
      )
      case("chain_extended_with_fake_leaf", "A new first certificate, signed by the real leaf's key, with a forged description.", malformed) {
        val attacker = TestKey("attacker:$name")
        val forged = KeyDescriptionEncoder.keyDescription(validDescription(sha256("melarc-attestation-fixture-challenge:$name"))).getEncoded("DER")
        chain.add(
          0,
          Certificates.build(
            CertificateSpec(
              Chains.LEAF_SUBJECT,
              name(BCStyle.CN to "Forged Leaf"),
              Certificates.serial("forged:$name"),
              Validity.GOOD,
              attacker,
              deviceKey,
              listOf(RawExtension(KeyDescriptionEncoder.OID, false, forged)),
            )
          ),
        )
        submittedKey = attacker.spki
      }
      case("chain_extended_without_extension", "A new first certificate with no extension: the leaf must be the one that carries it.", malformed) {
        chain.add(
          0,
          Certificates.build(
            CertificateSpec(
              Chains.LEAF_SUBJECT,
              name(BCStyle.CN to "Extra"),
              Certificates.serial("extra:$name"),
              Validity.GOOD,
              TestKey("extra:$name"),
              deviceKey,
            )
          ),
        )
      }
      case("certificate_with_trailing_bytes", "The leaf followed by a byte: the bytes parsed must be the bytes sent.", malformed) {
        chain[0] = chain[0] + byteArrayOf(0)
      }
      case("certificate_is_not_a_certificate", "The leaf replaced by bytes that are not DER.", malformed) {
        chain[0] = ByteArray(64) { (it * 7 + 1).toByte() }
      }
      case("extension_truncated", "The key description cut short.", malformed, extensionBytes = { it.copyOf(it.size - 9) })
      case("extension_trailing_data", "The key description followed by a byte.", malformed, extensionBytes = { it + byteArrayOf(0) })
      case(
        "extension_not_a_sequence",
        "The key description is an INTEGER.",
        malformed,
        extensionBytes = { ASN1Integer(5).getEncoded("DER") },
      )
      case(
        "extension_of_seven_members",
        "The key description lacks a member.",
        malformed,
        extensionBytes = {
          val members = org.bouncycastle.asn1.ASN1Sequence.getInstance(it).toArray()
          DERSequence(members.copyOf(7).requireNoNulls()).getEncoded("DER")
        },
      )
      case(
        "extension_nested_to_the_limit_of_a_certificate",
        "Sequences inside sequences, thousands deep: the ASN.1 parser's guard (BouncyCastle before 1.85 lost it) must hold, before any signature is checked.",
        malformed,
        extensionBytes = {
          var nested: ByteArray = ASN1Integer(1).getEncoded("DER")
          // Each level adds a header of two to four bytes; the certificate stays within the sixteen kibibytes the service reads.
          repeat(3_000) { nested = wrapSequence(nested) }
          nested
        },
      )
      case(
        "tag_unknown_to_the_library",
        "A tag the pinned library does not know: refused, and the reason to keep the library current.",
        malformed,
        description_ = { withHardware(it) { list -> list.copy(raw = mapOf<Int, ASN1Encodable>(999 to ASN1Integer(1))) } },
      )
    }

    // ---- chain validity and roots: steps 3 and 4 ----------------------------------------------------------------------------------

    private fun chainValidity() {
      val invalid = failed(IntegrityCause.CHAIN_INVALID)
      case(
        "remotely_provisioned_intermediate_expired",
        "On a remotely provisioned chain expiry is judged.",
        invalid,
        plan = ChainPlan(provisioning = Provisioning.REMOTELY, intermediateValidity = Validity.EXPIRED),
      )
      case(
        "remotely_provisioned_attestation_expired",
        "The attestation certificate of a remotely provisioned chain is past its validity.",
        invalid,
        plan = ChainPlan(provisioning = Provisioning.REMOTELY, attestationValidity = Validity.EXPIRED),
      )
      case(
        "factory_intermediate_not_yet_valid",
        "A certificate that has not begun is never accepted, whatever the provisioning.",
        invalid,
        plan = ChainPlan(intermediateValidity = Validity.NOT_YET),
      )
      case("signature_of_attestation_certificate_broken", "One bit of the attestation certificate's signature flipped.", invalid) {
        chain[1] = tamperSignature(chain[1])
      }
      case("signature_of_intermediate_broken", "One bit of the intermediate's signature flipped.", invalid) {
        chain[chain.size - 2] = tamperSignature(chain[chain.size - 2])
      }
      case("signature_of_leaf_broken", "One bit of the leaf's signature flipped.", invalid) { chain[0] = tamperSignature(chain[0]) }
      case(
        "names_do_not_chain",
        "The attestation certificate names an issuer that no certificate bears.",
        invalid,
        plan = ChainPlan(attestationIssuer = name(BCStyle.CN to "Nobody")),
      )
      case("certificate_repeated", "The attestation certificate twice.", invalid) { chain.add(1, chain[1]) }
      case(
        "root_with_an_accepted_name_and_another_key",
        "A root that bears an accepted root's name but not its key.",
        invalid,
        plan = ChainPlan(root = Root.IMPOSTOR_OF_A),
      )
    }

    private fun trust() {
      case(
        "unknown_root",
        "A chain that ends at a root nobody accepted.",
        failed(IntegrityCause.ROOT_NOT_TRUSTED),
        plan = ChainPlan(root = Root.UNKNOWN),
      )
      val revoked = failed(IntegrityCause.CERTIFICATE_REVOKED)
      case("intermediate_revoked", "The intermediate's serial is on the revocation list.", revoked, revoke = listOf("intermediate"))
      case("attestation_certificate_revoked", "The attestation certificate's serial is on the list.", revoked, revoke = listOf("attestation"))
      case("leaf_revoked", "The leaf's serial is on the list.", revoked, revoke = listOf("leaf"))
      case(
        "server_certificate_revoked",
        "The server certificate of a remotely provisioned chain is on the list.",
        revoked,
        plan = ChainPlan(provisioning = Provisioning.REMOTELY),
        revoke = listOf("server"),
      )
    }

    // ---- step 2 ------------------------------------------------------------------------------------------------------------------

    private fun securityLevel() {
      val unsupported = Expected.SecurityUnsupported
      case(
        "software_attestation",
        "The attestation security level is software.",
        unsupported,
        description_ = { it.copy(attestationSecurityLevel = 0) },
      )
      case(
        "software_key_mint",
        "The key is held in software.",
        unsupported,
        description_ = { it.copy(keyMintSecurityLevel = 0) },
      )
      case(
        "software_both",
        "Both levels are software.",
        unsupported,
        description_ = { it.copy(attestationSecurityLevel = 0, keyMintSecurityLevel = 0) },
      )
      case(
        "software_and_unknown_root",
        "A software chain from a root nobody accepted: the missing capability is the cause, not the root.",
        unsupported,
        plan = ChainPlan(root = Root.UNKNOWN),
        description_ = { it.copy(attestationSecurityLevel = 0, keyMintSecurityLevel = 0) },
      )
    }

    // ---- step 6 ------------------------------------------------------------------------------------------------------------------

    private fun challenge() {
      val mismatch = failed(IntegrityCause.CHALLENGE_MISMATCH)
      case("challenge_other", "A different 32 bytes.", mismatch, attestedChallenge = sha256("another challenge"))
      case("challenge_short", "The first sixteen bytes of the challenge.", mismatch, attestedChallenge = ByteArray(16))
      case("challenge_long", "The challenge and a byte more.", mismatch, attestedChallenge = ByteArray(33))
      case("challenge_empty", "No challenge.", mismatch, attestedChallenge = ByteArray(0))
    }

    // ---- step 7 ------------------------------------------------------------------------------------------------------------------

    private fun application() {
      val package_ = failed(IntegrityCause.PACKAGE_NOT_APPROVED)
      val signer = failed(IntegrityCause.SIGNER_NOT_APPROVED)
      case(
        "package_other",
        "Another app.",
        package_,
        description_ = { withApplication(it, listOf("com.example.other" to 1L), listOf(FixtureWorld.SIGNER_1)) },
      )
      case(
        "package_with_the_approved_name_as_a_prefix",
        "A name that begins with the approved one.",
        package_,
        description_ = { withApplication(it, listOf((FixtureWorld.PACKAGE + ".debug") to 1L), listOf(FixtureWorld.SIGNER_1)) },
      )
      case(
        "package_and_another",
        "The approved package and a second one: the shared user id of an app that is not Melarc's alone.",
        package_,
        description_ = {
          withApplication(it, listOf(FixtureWorld.PACKAGE to 1L, "com.example.other" to 3L), listOf(FixtureWorld.SIGNER_1))
        },
      )
      case(
        "no_application_identity",
        "The description names no package at all.",
        package_,
        description_ = { it.copy(software = it.software.copy(applicationId = null)) },
      )
      case(
        "application_identity_in_the_hardware_list",
        "The identity stated by the hardware-enforced list alone is not read: it is the software list's.",
        package_,
        description_ = {
          it.copy(
            software = it.software.copy(applicationId = null),
            hardware = it.hardware.copy(applicationId = ApplicationIdSpec(listOf(FixtureWorld.PACKAGE to 1L), listOf(FixtureWorld.SIGNER_1))),
          )
        },
      )
      case(
        "signer_unapproved",
        "The right package, signed by someone else.",
        signer,
        description_ = { withApplication(it, listOf(FixtureWorld.PACKAGE to 1L), listOf(FixtureWorld.SIGNER_OTHER)) },
      )
      case(
        "signer_approved_and_unapproved",
        "Every digest reported must be approved: one that is not is enough.",
        signer,
        description_ = {
          withApplication(it, listOf(FixtureWorld.PACKAGE to 1L), listOf(FixtureWorld.SIGNER_1, FixtureWorld.SIGNER_OTHER))
        },
      )
      case(
        "signer_none",
        "No signing certificate is reported.",
        signer,
        description_ = { withApplication(it, listOf(FixtureWorld.PACKAGE to 1L), emptyList()) },
      )
    }

    // ---- step 8 ------------------------------------------------------------------------------------------------------------------

    private fun deviceState() {
      val notLocked = failed(IntegrityCause.DEVICE_NOT_LOCKED)
      val notVerified = failed(IntegrityCause.BOOT_STATE_NOT_VERIFIED)
      case("device_unlocked", "The bootloader is unlocked.", notLocked, description_ = { withRootOfTrust(it, locked(0, locked = false)) })
      case("boot_self_signed", "Locked, booted from a key the user enrolled.", notVerified, description_ = { withRootOfTrust(it, locked(1)) })
      case("boot_unverified", "Locked, boot not verified.", notVerified, description_ = { withRootOfTrust(it, locked(2)) })
      case("boot_failed", "Locked, verification failed.", notVerified, description_ = { withRootOfTrust(it, locked(3)) })
      case("unlocked_and_unverified", "Both wrong: the lock is the first thing asked.", notLocked, description_ = { withRootOfTrust(it, locked(2, locked = false)) })
      case("no_root_of_trust", "The hardware-enforced list has none.", notVerified, description_ = { withRootOfTrust(it, null) })
      case(
        "root_of_trust_only_in_the_software_list",
        "A root of trust the software claims is no root of trust: only the hardware-enforced one is read.",
        notVerified,
        description_ = {
          it.copy(
            software = it.software.copy(rootOfTrust = locked(0)),
            hardware = it.hardware.copy(rootOfTrust = null),
          )
        },
      )
      case(
        "root_of_trust_of_the_wrong_shape",
        "The lock flag is an INTEGER: a root of trust that cannot be read is none.",
        notVerified,
        description_ = {
          withHardware(it) { list ->
            list.copy(
              rootOfTrust = null,
              raw =
                mapOf<Int, ASN1Encodable>(
                  704 to DERSequence(arrayOf(DEROctetString(FixtureWorld.BOOT_KEY), ASN1Integer(1), ASN1Enumerated(0)))
                ),
            )
          }
        },
      )
    }

    // ---- step 9 ------------------------------------------------------------------------------------------------------------------

    private fun keyProperties() {
      val rejected = failed(IntegrityCause.KEY_PROPERTIES_REJECTED)
      case("key_imported", "The key was imported, not generated on the device.", rejected, description_ = { withHardware(it) { l -> l.copy(origin = 2) } })
      case("key_origin_absent", "No origin.", rejected, description_ = { withHardware(it) { l -> l.copy(origin = null) } })
      case("key_cannot_sign", "Purposes: verify only.", rejected, description_ = { withHardware(it) { l -> l.copy(purposes = listOf(3)) } })
      case("key_purposes_absent", "No purposes.", rejected, description_ = { withHardware(it) { l -> l.copy(purposes = null) } })
      case("key_is_rsa", "Algorithm RSA.", rejected, description_ = { withHardware(it) { l -> l.copy(algorithm = 1) } })
      case("key_curve_p384", "Curve P-384.", rejected, description_ = { withHardware(it) { l -> l.copy(ecCurve = 2) } })
      case("key_curve_absent", "No curve.", rejected, description_ = { withHardware(it) { l -> l.copy(ecCurve = null) } })
      case("key_digest_sha512_only", "SHA-512 alone.", rejected, description_ = { withHardware(it) { l -> l.copy(digests = listOf(6)) } })
      case("key_digests_absent", "No digests.", rejected, description_ = { withHardware(it) { l -> l.copy(digests = null) } })
      case(
        "key_properties_only_in_the_software_list",
        "The software-enforced list states what only the hardware may: it is not read.",
        rejected,
        description_ = {
          it.copy(
            software = it.software.copy(purposes = listOf(2), algorithm = 3, digests = listOf(4), ecCurve = 1, origin = 0),
            hardware = it.hardware.copy(purposes = null, algorithm = null, digests = null, ecCurve = null, origin = null),
          )
        },
      )
    }

    // ---- step 10 -----------------------------------------------------------------------------------------------------------------

    private fun keyBinding() {
      case("key_other_than_the_attested", "A valid chain for one key, a request to enrol another.", failed(IntegrityCause.KEY_MISMATCH)) {
        submittedKey = TestKey("another-key:$name").spki
      }
    }

    // ---- order: the first failing step answers -------------------------------------------------------------------------------------

    private fun order() {
      case(
        "order_chain_before_challenge",
        "A broken signature and a wrong challenge: the chain is judged first.",
        failed(IntegrityCause.CHAIN_INVALID),
        attestedChallenge = sha256("another challenge"),
      ) {
        chain[1] = tamperSignature(chain[1])
      }
      case(
        "order_revocation_before_challenge",
        "A revoked certificate and a wrong challenge: revocation is judged first.",
        failed(IntegrityCause.CERTIFICATE_REVOKED),
        attestedChallenge = sha256("another challenge"),
        revoke = listOf("intermediate"),
      )
      case(
        "order_challenge_before_package",
        "A wrong challenge and a wrong package: the challenge is judged first.",
        failed(IntegrityCause.CHALLENGE_MISMATCH),
        attestedChallenge = sha256("another challenge"),
        description_ = { withApplication(it, listOf("com.example.other" to 1L), listOf(FixtureWorld.SIGNER_1)) },
      )
      case(
        "order_package_before_signer",
        "A wrong package and a wrong signer: the package is judged first.",
        failed(IntegrityCause.PACKAGE_NOT_APPROVED),
        description_ = { withApplication(it, listOf("com.example.other" to 1L), listOf(FixtureWorld.SIGNER_OTHER)) },
      )
      case(
        "order_signer_before_device_state",
        "A wrong signer on an unlocked device: the signer is judged first.",
        failed(IntegrityCause.SIGNER_NOT_APPROVED),
        description_ = {
          withRootOfTrust(withApplication(it, listOf(FixtureWorld.PACKAGE to 1L), listOf(FixtureWorld.SIGNER_OTHER)), locked(0, locked = false))
        },
      )
      case(
        "order_device_state_before_key_properties",
        "An unlocked device and an imported key: the device is judged first.",
        failed(IntegrityCause.DEVICE_NOT_LOCKED),
        description_ = { withHardware(withRootOfTrust(it, locked(0, locked = false))) { l -> l.copy(origin = 2) } },
      )
      case(
        "order_key_properties_before_binding",
        "An imported key and a different key submitted: the key's properties are judged first.",
        failed(IntegrityCause.KEY_PROPERTIES_REJECTED),
        description_ = { withHardware(it) { l -> l.copy(origin = 2) } },
      ) {
        submittedKey = TestKey("another-key:$name").spki
      }
    }
  }
}
