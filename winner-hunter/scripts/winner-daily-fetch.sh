#!/bin/bash
# VPS cron: fetch today's winners digest from D1 into ~/winner-daily (Grok Bot reads latest.md at about 07:00 Asia/Bangkok).
# Secrets come from 1Password at run time and are never written to disk; it only reads D1.
#
# One-time setup (see research/2026-11-05-winner-system/shared/SYSTEM.md):
#   1. ~/.config/winner-daily.env (not secret):
#        CF_ACCOUNT_ID=<Cloudflare account id>
#        WH_CF_ITEM=<1Password item id of a Cloudflare token with D1 read on winner-hunter-clean>
#        WH_BOARD_ITEM=wmpiwdjtozhqeaw2zbhds7v7ca      # "Winner Hunter board PIN", its url field is the board's address
#        WH_REPO=/home/connor/src/winner-hunter         # a checkout of main (git pull before the run is fine)
#   2. crontab (server time is Europe/Berlin):  40 0 * * *  and  55 0 * * *  /path/to/winner-daily-fetch.sh >> ~/.local/share/winner-daily.log 2>&1
set -u
set -a; . "$HOME/.config/op/claude.env"; . "$HOME/.config/winner-daily.env"; set +a
CF_API_TOKEN="$(op read "op://AGENT/${WH_CF_ITEM}/credential")" || { echo "winner-daily-fetch: no Cloudflare token from 1Password"; exit 1; }
WH_BOARD_URL="$(op read "op://AGENT/${WH_BOARD_ITEM}/url" 2>/dev/null || true)"
export CF_API_TOKEN WH_BOARD_URL
unset OP_SERVICE_ACCOUNT_TOKEN
exec node "${WH_REPO:-$HOME/src/winner-hunter}/winner-hunter/scripts/fetch-daily-digest.mjs" --dir "${WINNER_DAILY_DIR:-$HOME/winner-daily}"
