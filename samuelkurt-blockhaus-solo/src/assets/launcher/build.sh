#!/bin/sh
# Rebuilds blockhaus-launcher.jar (Java 8 bytecode, runs on any JVM Crafty uses). Needs a JDK.
set -e
cd "$(dirname "$0")"
rm -rf build && mkdir build
javac --release 8 -Xlint:-options -d build Launcher.java
jar cfe ../blockhaus-launcher.jar Launcher -C build .
rm -rf build
echo "built ../blockhaus-launcher.jar"
