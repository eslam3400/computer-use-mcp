#!/bin/sh
# Fake 'opencode' that ends with [NEEDS_DECISION] — used to test the blocked-job path.
set -e
echo "I'm blocked: missing API key for the feature under test"
echo "[NEEDS_DECISION] Should the feature read the key from env OPENAI_API_KEY?"
