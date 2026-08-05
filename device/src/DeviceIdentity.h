#ifndef DEVICE_IDENTITY_H
#define DEVICE_IDENTITY_H

#include <Arduino.h>
#include <Preferences.h>
#include <mbedtls/base64.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/ecdsa.h>
#include <mbedtls/ecp.h>
#include <mbedtls/entropy.h>
#include <mbedtls/sha256.h>

// This toolchain ships mbedtls 2.28. Two differences from 3.x that a compile
// caught rather than a review: keypair fields are plain members (no
// MBEDTLS_PRIVATE accessor), and the checked SHA-256 one-shot is
// mbedtls_sha256_ret — plain mbedtls_sha256 returns void here, so testing it
// against 0 is not even a type error in the direction you would hope.

// The device's own identity: a P-256 keypair it generates once and never sends.
//
// WHY THE DEVICE GENERATES IT. The alternative is a secret issued by the hub,
// which then has to be DELIVERED — meaning either a per-device firmware build
// (exactly what runtime hub config exists to avoid) or a provisioning channel
// that is itself unauthenticated, i.e. the hole we are closing. A key made here
// needs no delivery at all: one binary serves everybody, and the private half
// never crosses a wire.
//
// P-256 because mbedtls has it on the ESP32-S3 and the hub already speaks ES256
// for federation. One curve, one set of mistakes to avoid.
//
// WHAT THIS DEFENDS AGAINST. A device id is printed on the device's own screen
// and is the only thing a device used to present, so anyone who read one could
// open that device's socket and receive its apps. Knowing an id is not evidence
// of anything; holding this key is.
//
// Stored in our own NVS namespace alongside the hub host, NOT Resident's —
// the sandbox owns namespace "resident" for the persisted app.

namespace DeviceIdentity {

static constexpr const char* NVS_NAMESPACE = "poem1";
static constexpr const char* NVS_KEY = "devkey";

/** Raw P-256 private scalar. */
static constexpr size_t KEY_BYTES = 32;
/** Uncompressed point: 0x04 ‖ X ‖ Y. */
static constexpr size_t PUB_BYTES = 65;
/** ECDSA r ‖ s, fixed width — see sign(). */
static constexpr size_t SIG_BYTES = 64;

inline String toBase64(const uint8_t* data, size_t len) {
    size_t needed = 0;
    mbedtls_base64_encode(nullptr, 0, &needed, data, len);
    char* buf = (char*)malloc(needed + 1);
    if (!buf) return String();
    size_t written = 0;
    if (mbedtls_base64_encode((unsigned char*)buf, needed, &written, data, len) != 0) {
        free(buf);
        return String();
    }
    buf[written] = '\0';
    String out(buf);
    free(buf);
    return out;
}

/**
 * Seed a DRBG from the hardware entropy source.
 *
 * Worth being careful here rather than reaching for random(): a key is only
 * as good as the entropy behind it, and an ESP32 that has not brought up its
 * RF hardware can return poor-quality bytes from the faster APIs. mbedtls's
 * entropy layer pulls from the platform source esp-idf registers, which is
 * seeded properly once WiFi is up — and identity work all happens after
 * connect.
 */
inline bool seedDrbg(mbedtls_ctr_drbg_context& drbg, mbedtls_entropy_context& entropy) {
    mbedtls_entropy_init(&entropy);
    mbedtls_ctr_drbg_init(&drbg);
    const char* pers = "poem1-device-identity";
    return mbedtls_ctr_drbg_seed(&drbg, mbedtls_entropy_func, &entropy,
                                 (const unsigned char*)pers, strlen(pers)) == 0;
}

/** Load the stored private scalar, or generate and persist one. */
inline bool loadOrCreate(uint8_t out[KEY_BYTES]) {
    Preferences prefs;
    if (prefs.begin(NVS_NAMESPACE, /*readOnly=*/true)) {
        size_t len = prefs.getBytesLength(NVS_KEY);
        if (len == KEY_BYTES) {
            prefs.getBytes(NVS_KEY, out, KEY_BYTES);
            prefs.end();
            return true;
        }
        prefs.end();
    }

    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context drbg;
    if (!seedDrbg(drbg, entropy)) return false;

    mbedtls_ecp_keypair kp;
    mbedtls_ecp_keypair_init(&kp);
    bool ok = mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1, &kp,
                                  mbedtls_ctr_drbg_random, &drbg) == 0 &&
              mbedtls_mpi_write_binary(&kp.d, out, KEY_BYTES) == 0;
    mbedtls_ecp_keypair_free(&kp);
    mbedtls_ctr_drbg_free(&drbg);
    mbedtls_entropy_free(&entropy);
    if (!ok) return false;

    // Persist immediately. A key that only lives in RAM would be regenerated on
    // every boot, and a device whose identity changes each time it powers up
    // can never be recognised — it would pair once and be refused forever after.
    if (!prefs.begin(NVS_NAMESPACE, /*readOnly=*/false)) return false;
    prefs.putBytes(NVS_KEY, out, KEY_BYTES);
    prefs.end();
    Serial.println("[identity] generated a new device key");
    return true;
}

/** Rebuild the keypair from the stored scalar. Caller frees. */
inline bool loadKeypair(mbedtls_ecp_keypair& kp, mbedtls_ctr_drbg_context& drbg) {
    uint8_t d[KEY_BYTES];
    if (!loadOrCreate(d)) return false;

    mbedtls_ecp_keypair_init(&kp);
    bool ok = mbedtls_ecp_group_load(&kp.grp, MBEDTLS_ECP_DP_SECP256R1) == 0 &&
              mbedtls_mpi_read_binary(&kp.d, d, KEY_BYTES) == 0 &&
              // Derive Q = d*G rather than storing it: the public half is a pure
              // function of the private one, so persisting both invites them to
              // disagree after a partial write.
              mbedtls_ecp_mul(&kp.grp, &kp.Q,
                              &kp.d, &kp.grp.G,
                              mbedtls_ctr_drbg_random, &drbg) == 0;
    memset(d, 0, sizeof(d));
    return ok;
}

/** Base64 of the uncompressed public point, as the hub's WebCrypto expects. */
inline String publicKeyBase64() {
    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context drbg;
    if (!seedDrbg(drbg, entropy)) return String();

    mbedtls_ecp_keypair kp;
    String out;
    if (loadKeypair(kp, drbg)) {
        uint8_t pub[PUB_BYTES];
        size_t len = 0;
        if (mbedtls_ecp_point_write_binary(&kp.grp, &kp.Q,
                                           MBEDTLS_ECP_PF_UNCOMPRESSED, &len,
                                           pub, sizeof(pub)) == 0 && len == PUB_BYTES) {
            out = toBase64(pub, len);
        }
        mbedtls_ecp_keypair_free(&kp);
    }
    mbedtls_ctr_drbg_free(&drbg);
    mbedtls_entropy_free(&entropy);
    return out;
}

/**
 * Sign a challenge. Returns base64 of raw r ‖ s, 32 bytes each, zero-padded.
 *
 * RAW, NOT DER. WebCrypto's ECDSA verify wants r‖s, and mbedtls hands us r and
 * s as separate integers anyway — DER would mean both sides doing extra work to
 * meet in a format neither of them wanted. Fixed width matters: mpi_write_binary
 * left-pads, so a short r cannot silently shift s.
 */
inline String sign(const char* challenge) {
    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context drbg;
    if (!seedDrbg(drbg, entropy)) return String();

    mbedtls_ecp_keypair kp;
    String out;
    if (loadKeypair(kp, drbg)) {
        uint8_t digest[32];
        if (mbedtls_sha256_ret((const unsigned char*)challenge, strlen(challenge), digest, 0) == 0) {
            mbedtls_mpi r, s;
            mbedtls_mpi_init(&r);
            mbedtls_mpi_init(&s);
            if (mbedtls_ecdsa_sign(&kp.grp, &r, &s, &kp.d,
                                   digest, sizeof(digest),
                                   mbedtls_ctr_drbg_random, &drbg) == 0) {
                uint8_t sig[SIG_BYTES];
                if (mbedtls_mpi_write_binary(&r, sig, 32) == 0 &&
                    mbedtls_mpi_write_binary(&s, sig + 32, 32) == 0) {
                    out = toBase64(sig, sizeof(sig));
                }
            }
            mbedtls_mpi_free(&r);
            mbedtls_mpi_free(&s);
        }
        mbedtls_ecp_keypair_free(&kp);
    }
    mbedtls_ctr_drbg_free(&drbg);
    mbedtls_entropy_free(&entropy);
    return out;
}

/**
 * First 3 bytes of SHA-256 over the public key, as 6 hex characters.
 *
 * Must match the hub's fingerprintOf() exactly — it is shown on the device's
 * own screen so the owner can confirm the key the hub bound is the key this
 * device holds. A fingerprint the two sides compute differently is worse than
 * none: it would fail comparison every time and train the owner to ignore it.
 */
inline String fingerprint() {
    String pub = publicKeyBase64();
    if (pub.isEmpty()) return String();

    size_t rawLen = 0;
    uint8_t raw[PUB_BYTES];
    if (mbedtls_base64_decode(raw, sizeof(raw), &rawLen,
                              (const unsigned char*)pub.c_str(), pub.length()) != 0) {
        return String();
    }
    uint8_t digest[32];
    if (mbedtls_sha256_ret(raw, rawLen, digest, 0) != 0) return String();

    char hex[7];
    snprintf(hex, sizeof(hex), "%02x%02x%02x", digest[0], digest[1], digest[2]);
    return String(hex);
}

}  // namespace DeviceIdentity

#endif  // DEVICE_IDENTITY_H
