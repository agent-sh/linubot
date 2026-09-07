# Linubot for Android

An Android client for your Linux Linubot installation. The native connection
screen opens the paired HTTPS interface in a restricted WebView. Bots, model
credentials and computer workspaces run on Linux.

See [phone setup and build instructions](../docs/PHONE.md). The app requests only
Internet permission, rejects invalid TLS certificates and shares downloaded
artifacts through a scoped Android FileProvider. Signing keys are never included
in source or the APK. It does not run a bot runtime on the phone.
