# Phone access and Android

Your Linux computer continues to run the bots. Your phone connects to that same
installation, with its existing conversations, approvals and bot computers.
Linubot must be running and the Linux computer must be awake and online.

## Connect your phone

1. Install [Tailscale](https://tailscale.com/download) on Linux and your phone.
   Sign in to the same Tailscale account on both devices.
2. In the Linux Linubot app, open **Settings → Phone access** and choose
   **Enable phone access**. This creates a private HTTPS address on your tailnet.
3. Choose **Pair a phone**. Scan the QR with your phone camera to use the browser.
   The code works once and expires after five minutes.
4. For the Android app, download `linubot-VERSION-android.apk` from the
   [release page](https://github.com/agent-sh/linubot/releases/latest), install it,
   and enter the HTTPS computer address shown in Settings. Enter a fresh pairing
   code in the app. If the code was already used in a browser, create another.

The Android APK is distributed directly from GitHub, not through Google Play.
Android may ask you to allow installation from the browser or file manager you
used to download it. Later APKs signed by the same release key update this app
without removing its saved connection.

Pairing is saved for 30 days. Phones and browsers pair separately. You can chat,
continue stopped tasks, approve actions, manage bots and interact with the bot's
Computer panel. Android downloads bot-created files through the paired connection
and opens the system share sheet. Downloads are limited to 20 MiB each and 20
cached files; Android's **Clear cache** removes downloaded copies.

Enable **Keep running in background** in Linubot's Linux app menu if you want
phone access after closing its window. Quitting Linubot or suspending Linux
makes it unavailable. This version has no push notifications or offline bot
execution. Set up provider OAuth connections on Linux.

## Pairing and revocation

A paired device has owner access, including task approvals and computer control.
Keep the QR/code private. Codes are held only in memory, expire quickly and stop
accepting guesses after five failed attempts. Device credentials are random;
Linux stores their hashes. The client receives a Secure, HttpOnly, SameSite cookie.

In Linux Settings, **Revoke** removes one device and closes its live connections.
**Disable phone access** closes the phone gateway without stopping local bots.
Paired devices cannot create pairing codes or manage other devices remotely.
Changing the HTTPS address clears existing pairings. Paired-device metadata lives
in `phone-devices.json` and gateway settings in `phone-access.json`, inside the
private Linubot data directory. App upgrades preserve these files.

The Android app accepts HTTPS only, rejects invalid certificates, does not use a
JavaScript/native bridge, and keeps external sites in the system browser. Its
WebView cookies are not shared with that browser. Android backup and device
transfer exclude app data. **Connection → Change computer** clears the app's local
cookies; revoke the old device from Linux to remove its server-side pairing too.

## Networking

The phone gateway listens only on `127.0.0.1:45873`. Tailscale Serve terminates
HTTPS on port `45874`, privately inside your tailnet. Linubot refuses to replace
an unrelated service on that port or use a port configured for public Funnel.
Other Tailscale services are left in place. The mapping can remain configured
when phone access is disabled; its backend is closed.

If Tailscale needs permission, sign in locally and enable Serve for your Linux
user following [Tailscale's guide](https://tailscale.com/docs/features/tailscale-serve).
No router port forwarding is needed. Your phone's Tailscale connection works on
Wi-Fi and cellular networks.

An advanced option accepts your own HTTPS origin. Configure a trusted reverse
proxy to forward that origin to `http://127.0.0.1:45873`, preserving its Host
header. Keep the proxy private. Never expose the normal desktop/development
server, and do not disable TLS verification to make a phone connect.

## Build Android

The client requires Android 8 or later and was tested on an Android 15 emulator.
Build with JDK 17, Android SDK platform 37 and build-tools 36.0.0:

```sh
export ANDROID_HOME=/path/to/Android/Sdk
android/gradlew -p android :app:assembleDebug :app:lintDebug
```

To produce a signed release, use a private keystore with alias `linubot`:

```sh
export LINUBOT_ANDROID_KEYSTORE=/private/path/release.keystore
export LINUBOT_ANDROID_STORE_PASSWORD='your-keystore-password'
bash scripts/build-android.sh
```

Keep the keystore and password outside the repository, and back them up privately.
Losing the key prevents updates to existing APK installations. The published
certificate SHA-256 is
`26cfd6a5d3ea6a2f5e6641e8eabde038108d8df5f860ba781178fe1df4caa5c2`.
The normal `SHA256SUMS` release file covers the APK alongside the Linux packages.
