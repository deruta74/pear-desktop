#!/usr/bin/env bash
set -euo pipefail
if [[ $(uname -s) != Darwin ]]; then
  echo 'This bundle script requires macOS.' >&2
  exit 1
fi

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
build=(cargo build --manifest-path "$root/Cargo.toml" --target-dir "$root/target" --release --locked -p pear-desktop-preview)

case "${1:-preview}" in
  preview)
    name='Pear Desktop Rust Preview'
    identifier='com.pear-desktop.rust-preview'
    executable='pear-desktop-preview'
    version='0.2.0'
    build_number='2'
    source="$root/target/release/$executable"
    ;;
  embed)
    name='Pear Official Embed Probe'
    identifier='com.pear-desktop.rust-preview.embed-probe'
    executable='official_embed'
    version='0.1.0'
    build_number='1'
    build+=(--example "$executable")
    source="$root/target/release/examples/$executable"
    ;;
  *)
    echo 'Usage: bundle-macos.sh [preview|embed]' >&2
    exit 2
    ;;
esac

"${build[@]}" >&2
bundle="$root/target/macos/$name.app"
mkdir -p "$bundle/Contents/MacOS"
install -m 0755 "$source" "$bundle/Contents/MacOS/$executable"
cat > "$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>$identifier</string>
  <key>CFBundleName</key>
  <string>$name</string>
  <key>CFBundleExecutable</key>
  <string>$executable</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$version</string>
  <key>CFBundleVersion</key>
  <string>$build_number</string>
</dict>
</plist>
PLIST
plutil -lint "$bundle/Contents/Info.plist" >&2
codesign --force --sign - --timestamp=none "$bundle" >&2
codesign --verify --strict "$bundle"
printf '%s\n' "$bundle"
