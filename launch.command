#!/bin/bash
# Launch the FABULA-LLM-5 macOS app. Path-independent: resolves relative to this script.
# Build the app first from app/ (see README). Double-click this file or run it from a terminal.
cd "$(dirname "$0")"
exec "./FABULA-LLM-5.app/Contents/MacOS/FABULA-LLM-5"
