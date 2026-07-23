#ifndef HUB_CONFIG_H
#define HUB_CONFIG_H

#include <Arduino.h>
#include <Preferences.h>

// Which hub this device talks to, stored in NVS so it survives reboots and can
// be changed without reflashing.
//
// Why this is runtime rather than compile-time: every person running Poem/1
// Social points at their OWN hub. If the hostname were baked into the firmware,
// every participant would need their own build — one more cliff on top of an
// onboarding path that already asks them to reflash a device with an e-ink
// panel that can be damaged if you get it wrong. Runtime config means one
// binary works for everyone, and a hub move is a message rather than a flash.
// See docs/social-plan.md.
//
// Stored in our own NVS namespace, NOT Resident's — the sandbox owns
// namespace "resident" for the persisted app.
namespace HubConfig {

// Buffer size for a hostname, including the terminator. Courier's own time-sync
// URL buffer is 192 bytes including scheme, so this is comfortably within it.
static constexpr size_t HOST_MAX = 128;

static constexpr const char* NVS_NAMESPACE = "poem1";
static constexpr const char* NVS_KEY = "hub";

// A bare hostname: no scheme, no path, no whitespace. Rejecting these matters
// because a malformed host is only recoverable via the connect-failure
// fallback, which costs a boot — better to refuse it at the door.
inline bool isValidHost(const char* host) {
  if (!host) return false;
  size_t len = strlen(host);
  if (len == 0 || len >= HOST_MAX) return false;
  if (strstr(host, "://")) return false;
  for (size_t i = 0; i < len; i++) {
    char c = host[i];
    if (c == '/' || c == ' ' || c == '?' || c == '#' || c == '@') return false;
    if ((unsigned char)c < 0x21 || (unsigned char)c > 0x7e) return false;
  }
  // Reject a leading/trailing dot or hyphen; cheap catch for typo'd hosts.
  if (host[0] == '.' || host[0] == '-') return false;
  if (host[len - 1] == '.' || host[len - 1] == '-') return false;
  return true;
}

// Returns the stored hostname, or an empty String when none is set (in which
// case the caller should use its compiled-in default).
inline String load() {
  Preferences prefs;
  // Read-only open fails when the namespace has never been written.
  if (!prefs.begin(NVS_NAMESPACE, true)) return String();
  String host = prefs.getString(NVS_KEY, "");
  prefs.end();
  return host;
}

inline bool save(const char* host) {
  if (!isValidHost(host)) return false;
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) return false;
  size_t written = prefs.putString(NVS_KEY, host);
  prefs.end();
  return written > 0;
}

// Forget the stored hub; the device falls back to its compiled-in default.
inline bool clear() {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) return false;
  bool ok = prefs.remove(NVS_KEY);
  prefs.end();
  return ok;
}

} // namespace HubConfig

#endif // HUB_CONFIG_H
