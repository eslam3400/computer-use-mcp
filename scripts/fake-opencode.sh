#!/bin/sh
# Fake 'opencode' CLI used by tests. Optional delay: FAKE_SLEEP_SECONDS (default 4).
# Writes a small edit to the repo and ends with [DONE].
sleep "${FAKE_SLEEP_SECONDS:-4}"
cwd="$(pwd)"
cat >> "$cwd/src/index.ts" <<'EOF'

export function reverseWords(s: string): string {
  return s.split(/\s+/).reverse().join(" ");
}
EOF
echo "fake opencode completed the task"
echo "[DONE] Added reverseWords to src/index.ts"
