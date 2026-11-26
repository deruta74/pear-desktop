#!/usr/bin/env bash
set -euo pipefail
if [[ $(uname -s) != Darwin ]]; then
  echo 'This bundle script requires macOS.' >&2
  exit 1
fi

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
repository=$(cd -- "$root/../.." && pwd -P)
build=(cargo build --manifest-path "$root/Cargo.toml" --target-dir "$root/target" --release --locked -p pear-desktop-preview)
output="$root/target/macos"
release="$root/target/release"

usage() {
  echo 'Usage: bundle-macos.sh [preview|embed] [aarch64-apple-darwin|x86_64-apple-darwin]' >&2
  exit 2
}

if [[ $# -gt 2 ]]; then
  usage
fi
case "${2:-}" in
  '') ;;
  aarch64-apple-darwin|x86_64-apple-darwin)
    build+=(--target "$2")
    output="$output/$2"
    release="$root/target/$2/release"
    ;;
  *) usage ;;
esac

case "${1:-preview}" in
  preview)
    name='Pear Desktop Rust Preview'
    identifier='com.pear-desktop.rust-preview'
    executable='pear-desktop-preview'
    version='0.3.0'
    build_number='3'
    source="$release/$executable"
    ;;
  embed)
    name='Pear Official Embed Probe'
    identifier='com.pear-desktop.rust-preview.embed-probe'
    executable='official_embed'
    version='0.1.0'
    build_number='1'
    build+=(--example "$executable")
    source="$release/examples/$executable"
    ;;
  *) usage ;;
esac

# Use the system Mach-O tools for the installed copy on both architectures.
CARGO_PROFILE_RELEASE_STRIP=none "${build[@]}" >&2
bundle="$output/$name.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
install -m 0755 "$source" "$bundle/Contents/MacOS/$executable"
xcrun strip -S "$bundle/Contents/MacOS/$executable"

icons="$repository/assets/generated/icons/png"
iconset="$output/Pear.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  double=$((size * 2))
  install -m 0644 "$icons/${size}x${size}.png" "$iconset/icon_${size}x${size}.png"
  install -m 0644 "$icons/${double}x${double}.png" "$iconset/icon_${size}x${size}@2x.png"
done
iconutil --convert icns --output "$bundle/Contents/Resources/Pear.icns" "$iconset"

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
  <key>CFBundleIconFile</key>
  <string>Pear.icns</string>
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
