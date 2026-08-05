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
const devType = flagVal("--type", "poem1")
const [scrW, scrH] = flagVal("--screen", "960x540").split("x").map(Number)
const hold = Number(flagVal("--hold", "0"))

const b64 = (buf) => Buffer.from(buf).toString("base64")

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
