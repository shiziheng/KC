#!/usr/bin/env bash
# KC-PAY-GPT launcher -- start
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/kc-deploy_20261007.sh"  start
