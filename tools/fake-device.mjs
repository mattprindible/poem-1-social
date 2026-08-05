// A stand-in for the firmware: connects, answers the identity challenge with a
// P-256 signature, and reports what it claims to be.
//
// WHY THIS EXISTS. The identity handshake is the one part of this project whose
// real client is a device you have to reflash, on hardware whose panel can be
// damaged by a badly timed flash. Making the firmware change ALSO the first test
// of the protocol would mean debugging a wire format through the riskiest
// operation available. This proves the hub half first, so the reflash only has
// to prove the firmware.
//
// It is also the only way to exercise the cases that matter, because they all
// require behaving badly on purpose — presenting the wrong key, presenting
// none, or staying silent — which a real device cannot be asked to do.
//
//   node tools/fake-device.mjs <hub-host> <device-id> [flags]
//     --no-key      answer nothing (the downgrade attempt)
//     --wrong-key   sign correctly with a DIFFERENT key (the impostor who read
//                   the device id off the screen)
//     --fresh       forget the stored key and generate a new one
//     --type T      what board to claim to be (default poem1)
//     --screen WxH  what display to claim (default 960x540)
//     --hold N      stay connected N seconds instead of exiting on the verdict
//     --stall MS    BLOCK the event loop for MS after identifying
//     --slow-identify MS   wait MS before answering the challenge
//     --chatty MS   emit an app event every MS while holding
//
// ── WHY IT NEEDS TO BE ABLE TO BE BUSY ───────────────────────────────────────
// Both bugs found on 2026-08-05 required a device that was doing something else
// at the same time, and neither showed up in a suite that only ever pushes to an
// IDLE device. A real Poem/1 runs Lua at 10Hz on the same loop that services its
// WebSocket, and an e-ink refresh blocks that loop for around a second.
//
// --stall reproduces exactly that: a synchronous busy-wait blocks Node's event
// loop, so pings go unanswered and frames go unread, which is what a blocking
// panel refresh does to the firmware. --slow-identify does the same to the
// handshake specifically. Being able to make the simulator LATE is what turns
// "how long can a device block before the hub gives up?" from a guess into a
// measurement.
//
// The --type/--screen flags are what make this a network simulator rather than
// a single test double: a hub's whole point is carrying DIFFERENT hardware, and
// the interesting discovery questions ("can they run what I wrote?") need more
// than one shape to be questions at all. Standing up an M5Stick next to a Poem/1
// costs a flag here and a soldering iron otherwise.

const [host, deviceId, ...flags] = process.argv.slice(2)
const noKey = flags.includes("--no-key")
const wrongKey = flags.includes("--wrong-key")
const flagVal = (name, fallback) => {
  const i = flags.indexOf(name)
  return i === -1 ? fallback : flags[i + 1]
}
const stallMs = Number(flagVal("--stall", "0"))
const slowIdentifyMs = Number(flagVal("--slow-identify", "0"))
const chattyMs = Number(flagVal("--chatty", "0"))
const devType = flagVal("--type", "poem1")
const [scrW, scrH] = flagVal("--screen", "960x540").split("x").map(Number)
const hold = Number(flagVal("--hold", "0"))

const b64 = (buf) => Buffer.from(buf).toString("base64")

/** Block the event loop, the way a blocking panel refresh blocks the firmware's. */
const blockFor = (ms) => {
  const until = Date.now() + ms
  while (Date.now() < until) { /* deliberately spinning */ }
}

// Persisted like the firmware's NVS would: a device that regenerates its key
// every boot could never be recognised on reconnect, so the test rig must not
// either.
import { readFileSync, writeFileSync, existsSync } from "node:fs"
const KEYFILE = `/tmp/fake-device-${deviceId}.jwk`
let pair
if (existsSync(KEYFILE) && !flags.includes("--fresh")) {
  const saved = JSON.parse(readFileSync(KEYFILE, "utf8"))
  pair = {
    privateKey: await crypto.subtle.importKey("jwk", saved, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]),
    publicKey: await crypto.subtle.importKey("jwk", { ...saved, d: undefined, key_ops: ["verify"] }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]),
  }
} else {
  pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  writeFileSync(KEYFILE, JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)))
}
const rawPub = b64(await crypto.subtle.exportKey("raw", pair.publicKey))

const ws = new WebSocket(`wss://${host}/devices/${deviceId}`)
const done = (msg, code = 0) => {
  console.log(msg)
  try { ws.close() } catch {}
  setTimeout(() => process.exit(code), 100)
}

ws.onopen = () => console.log("connected")

ws.onmessage = async (ev) => {
  let msg
  try { msg = JSON.parse(ev.data) } catch { return }
  if (msg.channel !== "system") return

  if (msg.type === "identify") {
    console.log("challenged")
    if (noKey) return console.log("(offering no key — legacy device)")

    // Synchronous on purpose: a timer would let the event loop keep running,
    // which is precisely what a blocked firmware loop does NOT do.
    if (slowIdentifyMs > 0) {
      console.log(`stalling ${slowIdentifyMs}ms BEFORE answering (blocking)`)
      blockFor(slowIdentifyMs)
    }

    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(msg.challenge),
    )
    // --wrong-key: a valid signature from a DIFFERENT key, which is what an
    // impostor holding only the device id can actually produce.
    let pubkey = rawPub
    if (wrongKey) {
      const other = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
      pubkey = b64(await crypto.subtle.exportKey("raw", other.publicKey))
    }
    ws.send(JSON.stringify({
      channel: "system",
      type: "identify",
      pubkey,
      sig: b64(sig),
      device: {
        deviceType: devType,
        screen: { w: scrW, h: scrH },
        fw: "fake-device",
      },
    }))
    return
  }

  if (msg.type === "identified") {
    if (stallMs > 0) {
      console.log(`stalling ${stallMs}ms AFTER identifying (blocking, like an e-ink refresh)`)
      blockFor(stallMs)
      console.log(`stall over; socket ${ws.readyState === 1 ? "still open" : "CLOSED during stall"}`)
    }
    if (chattyMs > 0) {
      // A running app emitting events — the other half of "busy".
      setInterval(() => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ channel: "app", type: "sim_tick", data: { t: Date.now() } }))
        }
      }, chattyMs)
    }
    const line = `RESULT state=${msg.state}${msg.fingerprint ? ` fingerprint=${msg.fingerprint}` : ""}`
    if (hold > 0) {
      console.log(`${line} (holding ${hold}s)`)
      setTimeout(() => done("done holding"), hold * 1000)
      return
    }
    done(line)
  }
}

ws.onclose = (ev) => done(`CLOSED code=${ev.code} reason=${ev.reason || "(none)"}`)
ws.onerror = () => done("REFUSED at connect", 1)
setTimeout(() => done("TIMEOUT — no verdict", 1), 15000)
