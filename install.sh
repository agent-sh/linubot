#!/usr/bin/env bash
set -euo pipefail

# User installation only. Application data lives outside this directory.
linubot_root="${LINUBOT_INSTALL_ROOT:-$HOME/.local/opt}"
linubot_version=""
linubot_build=0
linubot_stage=0
linubot_activate=0
linubot_relaunch=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) linubot_version="${2:?Missing version}"; shift 2 ;;
    --build) linubot_build=1; shift ;;
    --stage-only) linubot_stage=1; shift ;;
    --activate-only) linubot_activate=1; shift ;;
    --launch) linubot_relaunch=1; shift ;;
    --help) echo 'Usage: bash install.sh [--version 2.7.2] [--build] [--launch]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[ "$(uname -s)" = Linux ] || { echo 'Linubot requires Linux.' >&2; exit 1; }
[ "$(id -u)" != 0 ] || { echo 'Run this installer as your desktop user, without sudo.' >&2; exit 1; }
case "$(uname -m)" in x86_64) linubot_arch=x64 ;; *) echo 'This release provides x86_64 Linux builds only.' >&2; exit 1 ;; esac
for linubot_command in tar sha256sum flock realpath; do command -v "$linubot_command" >/dev/null || { echo "Install $linubot_command first." >&2; exit 1; }; done
download() {
  if command -v curl >/dev/null; then curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 600 "$1" -o "$2";
  elif command -v wget >/dev/null; then wget --https-only --timeout=30 --tries=2 -qO "$2" "$1";
  else echo 'Install curl or wget first.' >&2; return 1; fi
}
linubot_tmp=$(mktemp -d "${TMPDIR:-/tmp}/linubot-install.XXXXXXXX")
trap 'rm -rf -- "$linubot_tmp"' EXIT
if [ -z "$linubot_version" ]; then
  download https://api.github.com/repos/agent-sh/linubot/releases/latest "$linubot_tmp/release.json"
  linubot_version=$(sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' "$linubot_tmp/release.json" | head -n 1)
fi
linubot_version="${linubot_version#v}"
[[ "$linubot_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'A stable release version is required.' >&2; exit 1; }
mkdir -p "$linubot_root"
linubot_root=$(realpath "$linubot_root")
[[ "$linubot_root" != / && "$linubot_root" != "$HOME" ]] || { echo 'Choose a dedicated application installation directory.' >&2; exit 1; }
exec 9>"$linubot_root/.linubot-install.lock"
flock -n 9 || { echo 'Another Linubot installer is running.' >&2; exit 1; }
linubot_target="$linubot_root/linubot-$linubot_version"

if [ "$linubot_activate" = 0 ]; then
  if [ -f "$linubot_target/.linubot-managed" ] && [ ! -L "$linubot_target" ] && [ -x "$linubot_target/linubot" ]; then
    linubot_existing_source=0
    [ ! -f "$linubot_target/.linubot-source-build" ] || linubot_existing_source=1
    if [ "$linubot_existing_source" != "$linubot_build" ]; then
      echo 'This version is already installed using a different build mode. Choose another LINUBOT_INSTALL_ROOT to keep a separate build.' >&2
      exit 1
    fi
    echo "Version $linubot_version is already staged."
  elif [ "$linubot_build" = 1 ]; then
    for linubot_command in git node npm; do command -v "$linubot_command" >/dev/null || { echo "Install $linubot_command first." >&2; exit 1; }; done
    node -e 'if(Number(process.versions.node.split(".")[0])<24)throw Error("Node.js 24 or newer is required")'
    git clone --quiet --depth 1 --branch "v$linubot_version" https://github.com/agent-sh/linubot.git "$linubot_tmp/source"
    (
      cd "$linubot_tmp/source"
      npm ci
      npm run build
      # Optional workspace support needs locally installed agent-workspace-linux, uv and uvx.
      # The ordinary desktop app can be built without bundling those programs.
      node --input-type=module -e 'import {build, Platform} from "electron-builder"; import {readFileSync} from "node:fs"; const config=JSON.parse(readFileSync("package.json")).build; config.extraResources=config.extraResources.filter(r=>!["workspace","runners"].includes(r.to)); await build({targets:Platform.LINUX.createTarget("dir"),config});'
    )
    cp "$linubot_tmp/source/desktop/icon.png" "$linubot_tmp/source/release/linux-unpacked/linubot.png"
    mv "$linubot_tmp/source/release/linux-unpacked" "$linubot_tmp/app"
    touch "$linubot_tmp/app/.linubot-source-build"
  else
    linubot_asset="linubot-$linubot_version-$linubot_arch.tar.gz"
    linubot_url="https://github.com/agent-sh/linubot/releases/download/v$linubot_version"
    download "$linubot_url/$linubot_asset" "$linubot_tmp/$linubot_asset"
    download "$linubot_url/SHA256SUMS" "$linubot_tmp/SHA256SUMS"
    linubot_digest=$(awk -v asset="$linubot_asset" '$2 == asset || $2 == "*" asset { print $1 }' "$linubot_tmp/SHA256SUMS")
    [[ "$linubot_digest" =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'Release checksum is missing or invalid.' >&2; exit 1; }
    printf '%s  %s\n' "$linubot_digest" "$linubot_tmp/$linubot_asset" | sha256sum --check --status
    # Reject absolute names and parent traversal before extracting the checked release.
    if tar -tzf "$linubot_tmp/$linubot_asset" | awk '/^\// || /(^|\/)\.\.(\/|$)/ {bad=1} END {exit !bad}'; then echo 'Unsafe archive path.' >&2; exit 1; fi
    mkdir "$linubot_tmp/app"
    tar -xzf "$linubot_tmp/$linubot_asset" -C "$linubot_tmp/app" --no-same-owner --no-same-permissions
    while IFS= read -r -d '' linubot_link; do
      case "$(realpath -m "$linubot_link")" in "$linubot_tmp/app/"*) ;; *) echo 'Unsafe archive link.' >&2; exit 1 ;; esac
    done < <(find "$linubot_tmp/app" -type l -print0)
  fi
  if [ -d "$linubot_tmp/app" ]; then
  [ -x "$linubot_tmp/app/linubot" ] && [ -f "$linubot_tmp/app/resources/app.asar" ] || { echo 'The release does not contain a Linux application.' >&2; exit 1; }
  # Detect incompatible Electron/libc builds before replacing an existing installation.
  ELECTRON_RUN_AS_NODE=1 "$linubot_tmp/app/linubot" -e 'process.exit(0)'
  if [ -e "$linubot_target" ] || [ -L "$linubot_target" ]; then
    [ ! -L "$linubot_target" ] && [ -f "$linubot_target/.linubot-managed" ] || { echo 'Refusing to replace an unmanaged version directory.' >&2; exit 1; }
    echo "Version $linubot_version is already installed."
  else
    printf '%s\n' "$linubot_version" > "$linubot_tmp/app/.linubot-managed"
    mv "$linubot_tmp/app" "$linubot_target"
  fi
  fi
fi
[ -f "$linubot_target/.linubot-managed" ] && [ ! -L "$linubot_target" ] && [ -x "$linubot_target/linubot" ] || { echo 'The staged version is missing.' >&2; exit 1; }
if [ "$linubot_stage" = 1 ]; then echo "Staged Linubot $linubot_version."; exit 0; fi

# Keep the prior version for rollback and leave the running process's files intact.
if [ -e "$linubot_root/linubot" ] && [ ! -L "$linubot_root/linubot" ]; then
  [ -x "$linubot_root/linubot/linubot" ] && [ -f "$linubot_root/linubot/resources/app.asar" ] || { echo 'The existing linubot directory is not an application installation.' >&2; exit 1; }
  mv "$linubot_root/linubot" "$linubot_root/linubot-before-$(date +%s)"
fi
ln -s "$linubot_target" "$linubot_root/.linubot-next-$$"
mv -Tf "$linubot_root/.linubot-next-$$" "$linubot_root/linubot"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/512x512/apps"
printf '#!/usr/bin/env bash\nexec %q "$@"\n' "$linubot_root/linubot/linubot" > "$HOME/.local/bin/linubot"
chmod 755 "$HOME/.local/bin/linubot"
cp "$linubot_target/linubot.png" "$HOME/.local/share/icons/hicolor/512x512/apps/linubot.png"
# Desktop entry Exec fields escape backslashes, quotes, backticks and dollar signs.
linubot_launcher="$HOME/.local/bin/linubot"
linubot_launcher=${linubot_launcher//\\/\\\\}
linubot_launcher=${linubot_launcher//\"/\\\"}
linubot_launcher=${linubot_launcher//\$/\\\$}
linubot_launcher=${linubot_launcher//\`/\\\`}
linubot_icon="$HOME/.local/share/icons/hicolor/512x512/apps/linubot.png"
linubot_icon=${linubot_icon//\\/\\\\}
printf '[Desktop Entry]\nName=Linubot\nComment=Your local AI team\nExec="%s"\nIcon=%s\nType=Application\nCategories=Utility;\nStartupWMClass=linubot\nTerminal=false\n' "$linubot_launcher" "$linubot_icon" > "$HOME/.local/share/applications/linubot.desktop"
# Refresh discovery where the desktop utilities are available. The explicit icon path also works without a theme cache.
if command -v gtk-update-icon-cache >/dev/null; then gtk-update-icon-cache --force --ignore-theme-index "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true; fi
if command -v update-desktop-database >/dev/null; then update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true; fi
echo "Installed Linubot $linubot_version. Open Linubot from your applications menu."
# Do not let the launched app inherit the installation lock for its whole lifetime.
flock -u 9
exec 9>&-
if [ "$linubot_relaunch" = 1 ]; then nohup "$HOME/.local/bin/linubot" >/dev/null 2>&1 </dev/null & fi
