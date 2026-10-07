#!/usr/bin/env bash
# ============================================================
# KC-PAY-GPT one-click deploy / start console  (Linux / macOS bash)
# ------------------------------------------------------------
# Non-technical admin: just run the matching .sh.
#   ./kc-deploy_20261007.sh            # interactive menu
#   ./kc-deploy_20261007.sh start       # start all (default)
#   ./kc-deploy_20261007.sh stop        # stop all (data kept)
#   ./kc-deploy_20261007.sh deploy      # pull latest + rebuild + start
#   ./kc-deploy_20261007.sh inject      # re-apply Xboard frontend injection only
#   ./kc-deploy_20261007.sh status      # show container status
#   ./kc-deploy_20261007.sh verify      # compare running containers vs deploy-manifest.json
#   ./kc-deploy_20261007.sh list        # print the service list from deploy-manifest.json
#
# SINGLE SOURCE OF TRUTH:
#   The service list lives in deploy-manifest.json next to this script. start/stop/
#   deploy/status/verify all read it, so adding or renaming a service means editing
#   ONLY the manifest -- both the Linux (.sh) and Windows (.ps1) engines follow
#   automatically. Run `verify` any time to detect drift.
#
# Requires: Docker Engine + docker compose plugin (or docker-compose).
# Optional env: KC_DIR, XBOARD_DIR, DOCKER_BIN.
# JSON parsing needs jq (preferred), else python3, else node.
# ============================================================
set -u

VERSION="20261007"

# ---------- paths ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KC_DIR="${KC_DIR:-$SCRIPT_DIR}"
XBOARD_DIR="${XBOARD_DIR:-}"
MANIFEST="$KC_DIR/deploy-manifest.json"

# ---------- docker location ----------
DOCKER_BIN="${DOCKER_BIN:-docker}"
USE_PLUGIN=0
DC_BIN=""

# ---------- helpers ----------
step()  { echo; echo "==> $1"; }
ok()    { echo "    [OK] $1"; }
warn()  { echo "    [!] $1"; }
err()   { echo "    [X] $1"; }

# ---------- JSON engine (single source of truth reader) ----------
JSON_ENGINE=""

detect_json_engine() {
  if command -v jq >/dev/null 2>&1; then JSON_ENGINE="jq"
  elif command -v python3 >/dev/null 2>&1; then JSON_ENGINE="python3"
  elif command -v node >/dev/null 2>&1; then JSON_ENGINE="node"
  else
    err "No JSON parser found (need jq, python3, or node) to read $MANIFEST."
    exit 1
  fi
}

# Print every service as one TAB-delimited row:
# id name type compose_path project containers ports health access inject image volume build
mj_tsv() {
  case "$JSON_ENGINE" in
    jq)
      jq -r '.services[] | [.id,(.name//""),(.type//""),(.compose_path//""),(.project//""),((.containers//[])|join(",")),((.ports//[])|join(",")),(.health_url//""),((.access_urls//[])|join(",")),(.inject|tostring|ascii_downcase),(.image//""),(.volume//""),(.build|tostring|ascii_downcase)] | @tsv' "$MANIFEST"
      ;;
    python3)
      python3 -c "import json,sys;m=json.load(open(sys.argv[1]));[print('\t'.join([s.get('id',''),s.get('name',''),s.get('type',''),s.get('compose_path',''),s.get('project',''),','.join(s.get('containers',[])),','.join(s.get('ports',[])),s.get('health_url',''),','.join(s.get('access_urls',[])),str(s.get('inject',False)).lower(),s.get('image',''),s.get('volume',''),str(s.get('build',False)).lower()])) for s in m.get('services',[])]" "$MANIFEST"
      ;;
    node)
      node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const s of m.services||[]){const r=[s.id,s.name,s.type,s.compose_path,s.project,(s.containers||[]).join(","),(s.ports||[]).join(","),s.health_url,(s.access_urls||[]).join(","),String(s.inject).toLowerCase(),s.image,s.volume,String(s.build).toLowerCase()];console.log(r.join("\t"));}' "$MANIFEST"
      ;;
  esac
}

mj_version() {
  case "$JSON_ENGINE" in
    jq) jq -r '.manifest_version' "$MANIFEST" ;;
    python3) python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('manifest_version',''))" "$MANIFEST" ;;
    node) node -e 'const fs=require("fs");console.log((JSON.parse(fs.readFileSync(process.argv[1],"utf8")).manifest_version)||"")' "$MANIFEST" ;;
  esac
}

contains() {
  local n="$1"; shift
  local e
  for e in "$@"; do [ "$e" = "$n" ] && return 0; done
  return 1
}

# ---------- docker locate & ensure ----------
ensure_docker() {
  if ! command -v "$DOCKER_BIN" >/dev/null 2>&1; then
    err "Docker not found. Install Docker Engine: https://docs.docker.com/engine/install/"
    exit 1
  fi
  if "$DOCKER_BIN" compose version >/dev/null 2>&1; then
    USE_PLUGIN=1
  elif command -v docker-compose >/dev/null 2>&1; then
    DC_BIN="docker-compose"
  else
    err "Docker is installed but missing the compose component."
    exit 1
  fi

  if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
    warn "Docker daemon not running. Trying to start it..."
    if command -v systemctl >/dev/null 2>&1; then
      sudo systemctl start docker 2>/dev/null || true
    elif command -v service >/dev/null 2>&1; then
      sudo service docker start 2>/dev/null || true
    fi
    local t=0
    while [ $t -lt 60 ]; do
      sleep 5; t=$((t+5))
      if "$DOCKER_BIN" info >/dev/null 2>&1; then ok "Docker is ready"; return; fi
      printf "."
    done
    err "Docker daemon did not start. Start it manually (e.g. 'sudo systemctl start docker') and retry."
    exit 1
  else
    ok "Docker daemon is running"
  fi
}

# ---------- compose wrapper ----------
invoke_compose() {
  local file="$1"; local proj="$2"; shift 2
  if [ "$USE_PLUGIN" -eq 1 ]; then
    "$DOCKER_BIN" compose -f "$file" -p "$proj" "$@"
  else
    "$DC_BIN" -f "$file" -p "$proj" "$@"
  fi
}

# ---------- resolve compose file path (env override > manifest path > candidate search) ----------
resolve_compose_path() {
  local cp="$1"
  if [ -n "$XBOARD_DIR" ] && [ -f "$XBOARD_DIR/docker-compose.yml" ]; then
    echo "$XBOARD_DIR/docker-compose.yml"; return
  fi
  local f="$KC_DIR/$cp"
  if [ -f "$f" ]; then echo "$f"; return; fi
  local c
  for c in "$KC_DIR/../Xboard" "$KC_DIR/Xboard" "/opt/xboard" "D:/tools/Xboard"; do
    if [ -f "$c/docker-compose.yml" ]; then echo "$c/docker-compose.yml"; return; fi
  done
  echo ""
}

# ---------- health check ----------
wait_http() {
  local url="$1"; local label="$2"; local timeout="${3:-120}"
  [ -z "$url" ] && return 0
  step "Waiting for $label ($url)"
  local t=0
  while [ $t -lt "$timeout" ]; do
    if curl -fsS -o /dev/null -m 5 "$url" 2>/dev/null; then
      ok "$label is ready (HTTP 200)"
      return 0
    fi
    sleep 3; t=$((t+3))
    printf "."
  done
  warn "$label did not respond within ${timeout}s; continuing (verify in browser later)"
  return 1
}

# ---------- Xboard frontend injection (only for services with inject=true) ----------
apply_injection() {
  step "Applying Xboard frontend injection (custom_html + cache clear + octane reload)"
  local running
  running="$("$DOCKER_BIN" ps --filter "name=^xboard$" --format '{{.Names}}' 2>/dev/null)"
  if [ -z "$running" ]; then warn "xboard container not running; skip injection (start Xboard first)"; return; fi

  local src dst p
  declare -a pairs=(
    "$KC_DIR/tools/kc_activate_inject.html|xboard:/www/kc_activate_inject.html"
    "$KC_DIR/tools/kc_panel_inject.html|xboard:/www/kc_panel_inject.html"
    "$KC_DIR/tools/kc_theme_inject.html|xboard:/www/kc_theme_inject.html"
    "$KC_DIR/tools/xboard-set-custom-html.php|xboard:/www/xboard-set-custom-html.php"
  )
  for p in "${pairs[@]}"; do
    src="${p%%|*}"; dst="${p##*|}"
    if [ ! -f "$src" ]; then warn "Missing source file: $src, skip"; return; fi
    "$DOCKER_BIN" cp "$src" "$dst"
  done
  "$DOCKER_BIN" exec xboard php /www/xboard-set-custom-html.php
  "$DOCKER_BIN" exec xboard php artisan optimize:clear
  "$DOCKER_BIN" exec xboard php artisan octane:reload
  ok "Frontend injection applied"
}

# ---------- generic service actions (driven by manifest) ----------
svc_start() {
  local id="$1" name="$2" type="$3" compose_path="$4" project="$5" containers="$6" ports="$7" health="$8" access="$9" inject="${10}" image="${11}" volume="${12}" build="${13}" do_build="${14}"
  step "Starting service: $name"
  if [ "$type" = "compose" ]; then
    local file; file="$(resolve_compose_path "$compose_path")"
    if [ -z "$file" ] || [ ! -f "$file" ]; then err "Cannot find compose file for $id (set XBOARD_DIR env or place Xboard next to this folder)"; return; fi
    local args=(up -d)
    if [ "$do_build" = "1" ] && [ "$build" = "true" ]; then args+=(--build); fi
    invoke_compose "$file" "$project" "${args[@]}"
  elif [ "$type" = "standalone" ]; then
    local exists
    exists="$("$DOCKER_BIN" ps -a --filter "name=^$containers$" --format '{{.Names}}' 2>/dev/null)"
    if [ -z "$exists" ]; then
      local hostvol="${volume%%:*}" contvol="${volume##*:}"
      case "$hostvol" in /*) ;; *) hostvol="$KC_DIR/$hostvol" ;; esac
      mkdir -p "$hostvol" 2>/dev/null
      "$DOCKER_BIN" run -d --pull=always --name "$containers" --restart=unless-stopped \
        -p "$ports" "-v${hostvol}:${contvol}" "$image"
    else
      "$DOCKER_BIN" start "$containers" >/dev/null 2>&1
    fi
  else
    err "Unknown service type: $type for $id"; return
  fi
  wait_http "$health" "$name"
  if [ "$inject" = "true" ]; then apply_injection; fi
}

svc_stop() {
  local id="$1" name="$2" type="$3" compose_path="$4" project="$5" containers="$6"
  step "Stopping service: $name"
  if [ "$type" = "compose" ]; then
    local file; file="$(resolve_compose_path "$compose_path")"
    if [ -n "$file" ] && [ -f "$file" ]; then invoke_compose "$file" "$project" stop; else warn "Cannot find compose file for $id; skipping"; fi
  elif [ "$type" = "standalone" ]; then
    "$DOCKER_BIN" stop "$containers" >/dev/null 2>&1
  fi
  ok "Stopped $name"
}

svc_deploy() {
  local id="$1" name="$2" type="$3" compose_path="$4" project="$5" containers="$6" ports="$7" health="$8" access="$9" inject="${10}" image="${11}" volume="${12}" build="${13}"
  step "Deploying service: $name"
  if [ "$type" = "compose" ]; then
    local file; file="$(resolve_compose_path "$compose_path")"
    if [ -z "$file" ] || [ ! -f "$file" ]; then err "Cannot find compose file for $id"; return; fi
    invoke_compose "$file" "$project" pull
    local args=(up -d)
    if [ "$build" = "true" ]; then args+=(--build); fi
    invoke_compose "$file" "$project" "${args[@]}"
  elif [ "$type" = "standalone" ]; then
    local exists
    exists="$("$DOCKER_BIN" ps -a --filter "name=^$containers$" --format '{{.Names}}' 2>/dev/null)"
    if [ -n "$exists" ]; then "$DOCKER_BIN" rm -f "$containers" >/dev/null 2>&1; fi
    local hostvol="${volume%%:*}" contvol="${volume##*:}"
    case "$hostvol" in /*) ;; *) hostvol="$KC_DIR/$hostvol" ;; esac
    mkdir -p "$hostvol" 2>/dev/null
    "$DOCKER_BIN" run -d --pull=always --name "$containers" --restart=unless-stopped \
      -p "$ports" "-v${hostvol}:${contvol}" "$image"
  fi
  wait_http "$health" "$name"
  if [ "$inject" = "true" ]; then apply_injection; fi
}

# ---------- open admin urls ----------
open_urls() {
  step "Opening admin backends (if not auto-opened, visit manually)"
  local opener=""
  if command -v xdg-open >/dev/null 2>&1; then opener="xdg-open"
  elif command -v open >/dev/null 2>&1; then opener="open"; fi
  local id name type compose_path project containers ports health access inject image volume build u
  while IFS=$'\t' read -r id name type compose_path project containers ports health access inject image volume build; do
    IFS=',' read -ra us <<< "$access"
    for u in "${us[@]}"; do
      if [ -n "$opener" ]; then
        "$opener" "$u" >/dev/null 2>&1 && ok "Opened $u" || warn "Could not open $u automatically; visit manually"
      else
        warn "No GUI opener found; visit $u manually"
      fi
    done
  done < <(mj_tsv)
}

# ---------- status ----------
show_status() {
  step "Current container status"
  local filters=()
  local id name type compose_path project containers ports health access inject image volume build c u
  while IFS=$'\t' read -r id name type compose_path project containers ports health access inject image volume build; do
    IFS=',' read -ra cs <<< "$containers"
    for c in "${cs[@]}"; do filters+=(--filter "name=$c"); done
  done < <(mj_tsv)
  "$DOCKER_BIN" ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' "${filters[@]}"
  echo
  echo "Access URLs:"
  while IFS=$'\t' read -r id name type compose_path project containers ports health access inject image volume build; do
    IFS=',' read -ra us <<< "$access"
    for u in "${us[@]}"; do echo "  $name: $u"; done
  done < <(mj_tsv)
}

# ---------- verify (drift detection) ----------
verify_deploy() {
  step "Verifying running containers against deploy-manifest.json"
  local expected=()
  local id name type compose_path project containers ports health access inject image volume build c
  while IFS=$'\t' read -r id name type compose_path project containers ports health access inject image volume build; do
    IFS=',' read -ra cs <<< "$containers"
    for c in "${cs[@]}"; do expected+=("$c"); done
  done < <(mj_tsv)
  local running=($("$DOCKER_BIN" ps --format '{{.Names}}' 2>/dev/null))
  local all=($("$DOCKER_BIN" ps -a --format '{{.Names}}' 2>/dev/null))

  echo
  echo "Expected containers from manifest (${#expected[@]}):"
  local missing=() extra=()
  for c in "${expected[@]}"; do
    if contains "$c" "${running[@]}"; then echo "  [UP]   $c"
    elif contains "$c" "${all[@]}"; then echo "  [DOWN] $c -- container exists but is stopped"
    else echo "  [MISS] $c -- not created"; missing+=("$c"); fi
  done
  for c in "${running[@]}"; do
    if ! contains "$c" "${expected[@]}"; then echo "  [DRIFT] $c -- running but not in manifest"; extra+=("$c"); fi
  done

  echo
  local up_count=0
  for c in "${expected[@]}"; do contains "$c" "${running[@]}" && up_count=$((up_count+1)); done
  if [ ${#missing[@]} -eq 0 ] && [ ${#extra[@]} -eq 0 ]; then
    ok "All $up_count/${#expected[@]} expected containers are running and no drift detected."
  else
    [ ${#missing[@]} -gt 0 ] && err "${#missing[@]} expected container(s) missing/down."
    [ ${#extra[@]} -gt 0 ] && warn "${#extra[@]} unexpected container(s) running (not defined in manifest)."
    err "Verification found drift. Edit deploy-manifest.json to align, or start/stop services to match."
  fi
}

# ---------- list (manifest table, no docker needed) ----------
list_services() {
  step "Service list from deploy-manifest.json (manifest_version $(mj_version))"
  echo
  local id name type compose_path project containers ports health access inject image volume build
  while IFS=$'\t' read -r id name type compose_path project containers ports health access inject image volume build; do
    echo "  [$id] $name <$type>"
    echo "      containers: $containers"
    echo "      ports: $ports"
    if [ "$type" = "compose" ]; then echo "      compose: $compose_path (project $project)"; else echo "      image: $image  volume: $volume"; fi
    [ -n "$health" ] && echo "      health: $health"
    echo "      access: $access"
    echo "      inject: $inject"
  done < <(mj_tsv)
  echo
  echo "To add/remove/rename a service, edit deploy-manifest.json only; both engines follow automatically."
}

# ---------- interactive menu ----------
show_menu() {
  echo
  echo "===== KC-PAY-GPT one-click console ====="
  echo "  1) Start all (default)"
  echo "  2) Stop all"
  echo "  3) Deploy update (pull latest + rebuild)"
  echo "  4) Re-apply Xboard frontend injection only"
  echo "  5) Show status"
  echo "  6) Verify running vs manifest (drift check)"
  echo "  7) List services from manifest"
  echo "  q) Quit"
  printf "Choose (1/2/3/4/5/6/7/q): "
  read -r c
  case "$c" in
    1) ACTION="start" ;;
    2) ACTION="stop" ;;
    3) ACTION="deploy" ;;
    4) ACTION="inject" ;;
    5) ACTION="status" ;;
    6) ACTION="verify" ;;
    7) ACTION="list" ;;
    q) ACTION="quit" ;;
    *) ACTION="start" ;;
  esac
}

# ---------- main ----------
ACTION="${1:-}"
if [ -z "$ACTION" ]; then show_menu; fi
if [ "$ACTION" = "quit" ]; then exit 0; fi

echo "KC-PAY-GPT one-click deploy console  (version $VERSION)"
if [ ! -f "$MANIFEST" ]; then
  err "deploy-manifest.json not found next to this script ($MANIFEST)."
  err "It is the single source of truth for the service list; restore it before running."
  exit 1
fi
detect_json_engine
if [ "$ACTION" != "list" ]; then ensure_docker; fi

case "$ACTION" in
  start)
    DO_BUILD=0
    while IFS=$'\t' read -r id name type compose_path project containers ports health access inject image volume build; do
      svc_start "$id" "$name" "$type" "$compose_path" "$project" "$containers" "$ports" "$health" "$access" "$inject" "$image" "$volume" "$build" "$DO_BUILD"
    done < <(mj_tsv)
    show_status
    open_urls
    ;;
  stop)
    while IFS=$'\t' read -r id name type compose_path project containers ports health access inject image volume build; do
      svc_stop "$id" "$name" "$type" "$compose_path" "$project" "$containers" "$ports" "$health" "$access" "$inject" "$image" "$volume" "$build"
    done < <(mj_tsv)
    show_status
    ;;
  deploy)
    DO_BUILD=1
    while IFS=$'\t' read -r id name type compose_path project containers ports health access inject image volume build; do
      svc_deploy "$id" "$name" "$type" "$compose_path" "$project" "$containers" "$ports" "$health" "$access" "$inject" "$image" "$volume" "$build"
    done < <(mj_tsv)
    show_status
    open_urls
    ;;
  inject) apply_injection; show_status ;;
  status) show_status ;;
  verify) verify_deploy ;;
  list)   list_services ;;
  *)      err "Unknown action: $ACTION" ;;
esac

echo
echo "Done."