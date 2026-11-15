#!/bin/sh
# Fake `pi` for the ACP bridge tests: only its --help output matters.
case "$1" in
--help) echo "pi - AI coding assistant with read, bash, edit, write tools" ;;
esac
