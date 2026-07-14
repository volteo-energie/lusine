#!/usr/bin/env bash
# ================================================================
#  L'usine — installation en une commande
#
#  Usage :
#    curl -fsSL https://raw.githubusercontent.com/volteo-energie/lusine/main/install.sh | bash
#    ./install.sh            → installation via Docker (recommandé, Docker installé si absent)
#    ./install.sh --node     → installation sans Docker (Node ≥ 20 + service systemd)
# ================================================================
set -euo pipefail

REPO="${LUSINE_REPO:-https://github.com/volteo-energie/lusine}"
APP_DIR="${LUSINE_DIR:-$HOME/lusine}"
PORT="${LUSINE_PORT:-3200}"
MODE="docker"
[ "${1:-}" = "--node" ] && MODE="node"

c() { printf "\033[1;38;5;209m%s\033[0m\n" "$1"; }
ok() { printf "\033[1;32m✔ %s\033[0m\n" "$1"; }
warn() { printf "\033[1;33m⚠ %s\033[0m\n" "$1"; }
die() { printf "\033[1;31m✖ %s\033[0m\n" "$1"; exit 1; }

echo ""
c "  ╔══════════════════════════════════════╗"
c "  ║   🏭  L'usine — installation          ║"
c "  ║   Orchestrateur d'agents IA autonomes ║"
c "  ╚══════════════════════════════════════╝"
echo ""

# ---------- 1. Récupération du code ----------
if [ -f "./package.json" ] && grep -q '"name": "lusine"' ./package.json 2>/dev/null; then
  APP_DIR="$(pwd)"
  ok "Code déjà présent dans $APP_DIR"
else
  if [ -d "$APP_DIR/.git" ] || [ -f "$APP_DIR/package.json" ]; then
    ok "Installation existante trouvée dans $APP_DIR"
    if command -v git >/dev/null 2>&1 && [ -d "$APP_DIR/.git" ]; then
      (cd "$APP_DIR" && git pull --ff-only) && ok "Code mis à jour" || warn "Mise à jour git ignorée"
    fi
  else
    c "→ Téléchargement de L'usine dans $APP_DIR"
    if command -v git >/dev/null 2>&1; then
      git clone --depth 1 "$REPO" "$APP_DIR" || die "Échec du clone. Le dépôt $REPO existe-t-il et est-il public ?"
    else
      mkdir -p "$APP_DIR"
      curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$APP_DIR" --strip-components=1 \
        || die "Échec du téléchargement. Installe git ou vérifie l'URL du dépôt."
    fi
    ok "Code téléchargé"
  fi
fi
cd "$APP_DIR"

# ---------- 2. Fichier .env ----------
if [ ! -f .env ]; then
  c "→ Génération du fichier .env (clés de chiffrement)"
  ENC_KEY="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -A n -t x1 | tr -d ' \n')"
  SESS_KEY="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -A n -t x1 | tr -d ' \n')"
  cat > .env <<EOF
PORT=$PORT
ENCRYPTION_KEY=$ENC_KEY
SESSION_SECRET=$SESS_KEY
EOF
  chmod 600 .env
  ok "Fichier .env créé (garde-le précieusement : il chiffre tes credentials)"
else
  ok "Fichier .env existant conservé"
fi
mkdir -p data

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")"

# ---------- 3a. Mode Docker ----------
if [ "$MODE" = "docker" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    c "→ Docker absent : installation automatique (get.docker.com)"
    curl -fsSL https://get.docker.com | sh || die "Impossible d'installer Docker. Relance avec :  ./install.sh --node"
    ok "Docker installé"
  fi
  if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose";
  elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose";
  else die "Docker Compose introuvable. Installe le plugin compose, ou relance avec --node."; fi

  c "→ Build & démarrage du conteneur (première fois : 1 à 3 min)"
  $COMPOSE up -d --build
  ok "Conteneur démarré"

  echo ""
  c "  ══════════════════════════════════════════════"
  ok "L'usine tourne !  →  http://$IP:$PORT"
  echo "     Première visite : tu choisis ton mot de passe admin."
  echo ""
  echo "     Commandes utiles :"
  echo "       cd $APP_DIR && $COMPOSE logs -f      # logs"
  echo "       cd $APP_DIR && $COMPOSE restart      # redémarrer"
  echo "       cd $APP_DIR && $COMPOSE down         # arrêter"
  c "  ══════════════════════════════════════════════"
  exit 0
fi

# ---------- 3b. Mode Node natif ----------
command -v node >/dev/null 2>&1 || die "Node.js absent. Installe Node ≥ 20 (ex: https://deb.nodesource.com) puis relance."
NODE_MAJ="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
[ "$NODE_MAJ" -ge 20 ] || die "Node $(node -v) détecté — il faut Node ≥ 20."

c "→ Installation des dépendances npm"
npm install --omit=dev
ok "Dépendances installées"

if command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
  c "→ Création du service systemd 'lusine'"
  cat > /etc/systemd/system/lusine.service <<EOF
[Unit]
Description=L'usine — orchestrateur d'agents IA
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now lusine
  ok "Service systemd démarré (systemctl status lusine)"
else
  warn "Pas de systemd/root : lancement direct. Pour un service permanent, relance ce script en root."
  nohup node server/index.js > data/lusine.log 2>&1 &
  ok "Serveur lancé en arrière-plan (logs : data/lusine.log)"
fi

echo ""
ok "L'usine tourne !  →  http://$IP:$PORT"
echo "   Première visite : tu choisis ton mot de passe admin."
