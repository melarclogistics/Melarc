package com.melarc.attestation

import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStreamReader
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * Google's attestation revocation list, as the verifier holds it: the serial numbers of the certificates it lists, and how many entries the
 * list had (a list with no entries is not a list: SECURITY_DESIGN.md 15.2.2, "a fetched list replaces the held one only if it parses,
 * validates against its schema and is non-empty").
 *
 * **Every entry of the list is treated as revoked**, whatever its status. The library treats only `REVOKED` as revoked; the design says "no
 * certificate in the chain is on Google's attestation revocation list" (15.2.1 step 5), and an entry that Google has suspended is on it.
 */
data class RevocationList(val entries: Int, val serials: Set<String>)

class TrustDataException(message: String) : IOException(message)

fun interface RevocationFetcher {
  /** Fetches and validates the list, or throws: a failure keeps the held list, and an invalid list is never held. */
  fun fetch(): RevocationList
}

/** Serial numbers are compared as the library compares them: `BigInteger.toString(16)`, lower case and without leading zeros. */
internal fun normalisedSerial(text: String): String? {
  if (text.isEmpty() || text.length > 64 || !text.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
    return null
  }
  return text.lowercase().trimStart('0').ifEmpty { "0" }
}

/**
 * Reads the status file Google publishes, strictly: `{"entries": {"<serial>": {"status": "<STATUS>", ...}, ...}}`. Anything else (a
 * different top-level shape, an entry that is not an object or has no status, a serial that is not hexadecimal, trailing content, a number
 * where a string belongs) is a failure, never a partial list.
 */
fun parseRevocationList(bytes: ByteArray): RevocationList {
  val serials = linkedSetOf<String>()
  var entries = 0
  try {
    JsonReader(InputStreamReader(ByteArrayInputStream(bytes), Charsets.UTF_8)).use { reader ->
      reader.setStrictness(Strictness.STRICT)
      reader.beginObject()
      var sawEntries = false
      while (reader.hasNext()) {
        if (reader.nextName() != "entries") {
          reader.skipValue()
          continue
        }
        if (sawEntries) throw TrustDataException("The revocation list names its entries twice")
        sawEntries = true
        reader.beginObject()
        while (reader.hasNext()) {
          val serial =
            normalisedSerial(reader.nextName())
              ?: throw TrustDataException("A serial number of the revocation list is not hexadecimal")
          reader.beginObject()
          var status: String? = null
          while (reader.hasNext()) {
            if (reader.nextName() == "status") {
              if (reader.peek() != JsonToken.STRING) throw TrustDataException("A status is not text")
              status = reader.nextString()
            } else {
              reader.skipValue()
            }
          }
          reader.endObject()
          if (status.isNullOrEmpty()) throw TrustDataException("An entry of the revocation list has no status")
          entries += 1
          serials += serial
        }
        reader.endObject()
      }
      reader.endObject()
      if (reader.peek() != JsonToken.END_DOCUMENT) {
        throw TrustDataException("The revocation list has content after its document")
      }
      if (!sawEntries) throw TrustDataException("The revocation list names no entries")
    }
  } catch (failure: TrustDataException) {
    throw failure
  } catch (failure: IOException) {
    throw TrustDataException("The revocation list does not parse")
  } catch (failure: IllegalStateException) {
    throw TrustDataException("The revocation list does not have the expected shape")
  } catch (failure: NumberFormatException) {
    throw TrustDataException("The revocation list does not have the expected shape")
  }
  if (entries == 0) throw TrustDataException("The revocation list is empty")
  return RevocationList(entries, serials)
}

/**
 * Fetches the list from its one configured source: HTTPS (or loopback HTTP outside production, for a test), no redirect, a time-out, and a
 * ceiling on the bytes read. It never follows a URL a certificate supplies, and it reads nothing it was not asked for.
 */
class HttpRevocationFetcher(
  private val url: URI,
  private val timeout: Duration,
  private val maxBytes: Int,
) : RevocationFetcher {
  private val client: HttpClient =
    HttpClient.newBuilder()
      .connectTimeout(timeout)
      .followRedirects(HttpClient.Redirect.NEVER)
      .build()

  override fun fetch(): RevocationList {
    val request =
      HttpRequest.newBuilder(url).timeout(timeout).header("Accept", "application/json").GET().build()
    val response =
      try {
        client.send(request, HttpResponse.BodyHandlers.ofInputStream())
      } catch (failure: InterruptedException) {
        Thread.currentThread().interrupt()
        throw TrustDataException("The revocation list fetch was interrupted")
      } catch (failure: IOException) {
        throw TrustDataException("The revocation list could not be fetched")
      }
    response.body().use { body ->
      if (response.statusCode() != 200) throw TrustDataException("The revocation list answered with a status other than 200")
      val declared = response.headers().firstValueAsLong("content-length")
      if (declared.isPresent && declared.asLong > maxBytes) {
        throw TrustDataException("The revocation list is larger than the ceiling")
      }
      val bytes = body.readNBytes(maxBytes + 1)
      if (bytes.size > maxBytes) throw TrustDataException("The revocation list is larger than the ceiling")
      return parseRevocationList(bytes)
    }
  }
}
