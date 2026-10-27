package com.melarc.attestation.fixtures

import org.bouncycastle.asn1.ASN1Boolean
import org.bouncycastle.asn1.ASN1Encodable
import org.bouncycastle.asn1.ASN1Enumerated
import org.bouncycastle.asn1.ASN1Integer
import org.bouncycastle.asn1.ASN1ObjectIdentifier
import org.bouncycastle.asn1.DERNull
import org.bouncycastle.asn1.DEROctetString
import org.bouncycastle.asn1.DERSequence
import org.bouncycastle.asn1.DERSet
import org.bouncycastle.asn1.DERTaggedObject

/**
 * The Android key attestation extension, **encoded here from the published schema** (https://source.android.com/docs/security/features/keystore/attestation#schema)
 * and not by the library under test: the fixtures of the adversarial suite are independent of the code they hold to account, so that a
 * misreading shared by the library's encoder and its parser cannot make a wrong chain look right. Only what the policy reads is modelled.
 */
object KeyDescriptionEncoder {
  /** The extension's object identifier. */
  val OID = ASN1ObjectIdentifier("1.3.6.1.4.1.11129.2.1.17")

  data class RootOfTrustSpec(
    val verifiedBootKey: ByteArray,
    val deviceLocked: Boolean,
    /** 0 Verified, 1 SelfSigned, 2 Unverified, 3 Failed. */
    val verifiedBootState: Int,
    val verifiedBootHash: ByteArray?,
  )

  data class ApplicationIdSpec(
    val packages: List<Pair<String, Long>>,
    /** The SHA-256 digests (32 bytes) of the signing certificates. */
    val signatures: List<ByteArray>,
  )

  /** One authorization list. A member that is null is absent from the encoding; the members are written in ascending tag order. */
  data class AuthorizationSpec(
    val purposes: List<Int>? = null,
    val algorithm: Int? = null,
    val keySize: Int? = null,
    val digests: List<Int>? = null,
    val ecCurve: Int? = null,
    val noAuthRequired: Boolean = false,
    val creationDateTime: Long? = null,
    val origin: Int? = null,
    val rootOfTrust: RootOfTrustSpec? = null,
    val osVersion: Int? = null,
    val osPatchLevel: Int? = null,
    val applicationId: ApplicationIdSpec? = null,
    /** Members written as given, after the others and over them: how a fixture states a tag the schema has no field for, or a wrong type. */
    val raw: Map<Int, ASN1Encodable> = emptyMap(),
  )

  data class KeyDescriptionSpec(
    val attestationVersion: Int = 300,
    /** 0 Software, 1 TrustedEnvironment, 2 StrongBox. */
    val attestationSecurityLevel: Int = 1,
    val keyMintVersion: Int = 300,
    val keyMintSecurityLevel: Int = 1,
    val challenge: ByteArray,
    val uniqueId: ByteArray = ByteArray(0),
    val software: AuthorizationSpec,
    val hardware: AuthorizationSpec,
  )

  private fun explicit(tag: Int, value: ASN1Encodable) = DERTaggedObject(true, tag, value)

  private fun integers(values: List<Int>) = DERSet(values.map { ASN1Integer(it.toLong()) }.toTypedArray())

  private fun applicationId(spec: ApplicationIdSpec): DEROctetString {
    val packages =
      DERSet(
        spec.packages
          .map { (name, version) ->
            DERSequence(arrayOf(DEROctetString(name.toByteArray(Charsets.UTF_8)), ASN1Integer(version)))
          }
          .toTypedArray()
      )
    val signatures = DERSet(spec.signatures.map { DEROctetString(it) }.toTypedArray())
    return DEROctetString(DERSequence(arrayOf(packages, signatures)).encoded)
  }

  private fun rootOfTrust(spec: RootOfTrustSpec): DERSequence {
    val members =
      mutableListOf<ASN1Encodable>(
        DEROctetString(spec.verifiedBootKey),
        ASN1Boolean.getInstance(spec.deviceLocked),
        ASN1Enumerated(spec.verifiedBootState),
      )
    spec.verifiedBootHash?.let { members += DEROctetString(it) }
    return DERSequence(members.toTypedArray())
  }

  fun authorizationList(spec: AuthorizationSpec): DERSequence {
    val members = sortedMapOf<Int, ASN1Encodable>()
    spec.purposes?.let { members[1] = integers(it) }
    spec.algorithm?.let { members[2] = ASN1Integer(it.toLong()) }
    spec.keySize?.let { members[3] = ASN1Integer(it.toLong()) }
    spec.digests?.let { members[5] = integers(it) }
    spec.ecCurve?.let { members[10] = ASN1Integer(it.toLong()) }
    if (spec.noAuthRequired) members[503] = DERNull.INSTANCE
    spec.creationDateTime?.let { members[701] = ASN1Integer(it) }
    spec.origin?.let { members[702] = ASN1Integer(it.toLong()) }
    spec.rootOfTrust?.let { members[704] = rootOfTrust(it) }
    spec.osVersion?.let { members[705] = ASN1Integer(it.toLong()) }
    spec.osPatchLevel?.let { members[706] = ASN1Integer(it.toLong()) }
    spec.applicationId?.let { members[709] = applicationId(it) }
    members.putAll(spec.raw)
    return DERSequence(members.map { (tag, value) -> explicit(tag, value) }.toTypedArray())
  }

  fun keyDescription(spec: KeyDescriptionSpec): DERSequence =
    DERSequence(
      arrayOf(
        ASN1Integer(spec.attestationVersion.toLong()),
        ASN1Enumerated(spec.attestationSecurityLevel),
        ASN1Integer(spec.keyMintVersion.toLong()),
        ASN1Enumerated(spec.keyMintSecurityLevel),
        DEROctetString(spec.challenge),
        DEROctetString(spec.uniqueId),
        authorizationList(spec.software),
        authorizationList(spec.hardware),
      )
    )
}
