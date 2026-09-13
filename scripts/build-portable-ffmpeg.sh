#!/bin/sh
# Run with nasm and pkg-config available; produces no Homebrew/Pixi runtime links.
set -eu

target=${1:?Use arm64 or x86_64, followed by the build directory}
build_root=${2:?An absolute build directory is required}
case "$target" in
  arm64) host=aarch64-apple-darwin ;;
  x86_64) host=x86_64-apple-darwin ;;
  *) echo "Unsupported Mac architecture" >&2; exit 1 ;;
esac
case "$build_root" in /*) ;; *) echo "Build directory must be absolute" >&2; exit 1 ;; esac

source_root="$build_root/sources"
prefix="$build_root/$target/prefix"
mkdir -p "$prefix" "$build_root/$target/x264" "$build_root/$target/lame" "$build_root/$target/ffmpeg"
compiler="clang -arch $target -mmacosx-version-min=13.0"
export MACOSX_DEPLOYMENT_TARGET=13.0

cd "$build_root/$target/lame"
CC="$compiler" "$source_root/lame/configure" \
  --host="$host" --prefix="$prefix" --enable-static --disable-shared \
  --disable-frontend --disable-gtktest --disable-nasm \
  CFLAGS="-O2 -arch $target -mmacosx-version-min=13.0" \
  LDFLAGS="-arch $target -mmacosx-version-min=13.0"
make -j4
make install

cd "$build_root/$target/x264"
CC="$compiler" "$source_root/x264/configure" \
  --host="$host" --prefix="$prefix" --enable-static --enable-pic \
  --disable-cli --disable-opencl \
  --extra-cflags="-arch $target -mmacosx-version-min=13.0" \
  --extra-ldflags="-arch $target -mmacosx-version-min=13.0"
make -j4
make install

cd "$build_root/$target/ffmpeg"
PKG_CONFIG_PATH="$prefix/lib/pkgconfig" "$source_root/ffmpeg/configure" \
  --prefix="$prefix" --arch="$target" --target-os=darwin --enable-cross-compile \
  --cc="$compiler" --cxx="clang++ -arch $target -mmacosx-version-min=13.0" \
  --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib" \
  --pkg-config-flags=--static --disable-autodetect \
  --enable-static --disable-shared --enable-gpl --enable-libx264 --enable-libmp3lame \
  --enable-securetransport --enable-videotoolbox --enable-audiotoolbox \
  --enable-zlib --disable-doc --disable-debug --disable-ffplay
make -j4
make install

for tool in ffmpeg ffprobe; do
  binary="$prefix/bin/$tool"
  if otool -L "$binary" | tail -n +2 | \
      awk '{print $1}' | \
      awk '!/^\/usr\/lib\// && !/^\/System\/Library\// {bad=1} END {exit !bad}'; then
    echo "$tool depends on a non-system library" >&2
    exit 1
  fi
  lipo "$binary" -verify_arch "$target"
done
printf 'Built portable %s FFmpeg tools in %s\n' "$target" "$prefix/bin"
