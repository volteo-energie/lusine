# 🏭 L'usine

**Orchestrateur visuel d'agents IA autonomes, auto-hébergé.** Interface façon n8n : tu crées des agents sur un canvas, tu donnes une mission à chacun, tu les relies en chaîne — le résultat du premier devient l'entrée du suivant, jusqu'au dernier. Chaque agent dispose de connecteurs (email, bases de données, Telegram, Printify, Shopify, GitHub…) qu'il utilise **réellement et en autonomie** pour accomplir sa mission.

## Installation en une commande

Sur n'importe quel VPS ou serveur Linux (Debian, Ubuntu, etc.) :

```bash
curl -fsSL https://raw.githubusercontent.com/volteo-energie/lusine/main/install.sh | bash
```

Le script installe Docker s'il est absent, génère les clés de chiffrement, build et lance le conteneur. À la première visite (`http://TON_IP:3200`), tu choisis ton mot de passe admin.

**Sans Docker** (Node ≥ 20 requis, crée un service systemd) :

```bash
curl -fsSL https://raw.githubusercontent.com/volteo-energie/lusine/main/install.sh | bash -s -- --node
```

**Depuis une copie locale du code** (zip / scp) :

```bash
cd lusine && bash install.sh
```

## Premiers pas (5 minutes)

1. **Fournisseurs IA** → ajoute au moins une clé API. Trois types :
   - **Anthropic** (Claude)
   - **OpenAI** (GPT)
   - **Compatible OpenAI** : Groq, Mistral, Ollama local, OpenRouter, DeepSeek… (URL de base configurable)
   Chaque agent choisit son fournisseur et son modèle → un rédacteur sur Claude, un trieur sur un petit modèle rapide, etc.
2. **Identifiants** → ajoute tes connecteurs (SMTP IONOS, Supabase, Telegram, Printify…). Tout est chiffré **AES-256-GCM** côté serveur.
3. **Workflows** → crée un workflow, ajoute des agents (bouton ＋, modèles pré-remplis), écris leurs missions, relie-les en tirant un trait de la poignée droite d'un agent vers la poignée gauche du suivant.
4. Bouton orange **▶ Exécuter la chaîne** → tu vois chaque agent travailler en direct (impulsions orange, connexions animées, ✓ verts). L'historique complet (étapes, appels d'outils, sorties) est conservé.

## Connecteurs inclus

| Catégorie | Connecteurs |
|---|---|
| Cœur | HTTP/API générique · Email envoi (SMTP) · Email lecture (IMAP) · PostgreSQL / Supabase |
| Messagerie | Telegram · Discord (webhook) · Slack |
| E-commerce | Printify · Etsy · Shopify · Stripe |
| Contenu & social | YouTube (Data API) · TikTok¹ · Recherche web (Brave) |
| Productivité | Notion · Airtable · GitHub · Google Sheets² |
| IA | OpenAI Images (DALL·E 3) |

¹ TikTok exige une app développeur approuvée par TikTok (leur règle, pas la nôtre).
² Google Sheets attend un token OAuth Google.

**Un service n'est pas dans la liste ?** Le connecteur **HTTP/API générique** couvre toute API REST : tu configures l'URL de base et les headers d'auth, l'agent fait le reste. (Fiverr, par exemple, n'a pas d'API publique — c'est la seule vraie limite.)

## Déclencheurs — exécution autonome (v2)

Bouton **⏰ Déclencheurs** dans l'éditeur. Une chaîne peut se lancer toute seule, sans toi :

**Cron (planifié)** — la chaîne tourne selon un horaire (fuseau Europe/Paris par défaut, configurable via `LUSINE_TZ`). Modèles rapides fournis (chaque heure, tous les jours 8h, chaque lundi 8h, toutes les 4h…) ou expression cron libre, avec aperçu des prochaines exécutions en direct. Une donnée d'entrée optionnelle est passée au premier agent.

**Webhook (entrant)** — une URL secrète unique est générée. Un appel `POST` (ou `GET`) dessus lance la chaîne. Le corps de la requête devient l'entrée du premier agent (ou une entrée fixe, au choix). Idéal pour brancher Zapier, Make, un formulaire, un autre service, etc.

```bash
curl -X POST "https://ton-domaine/api/hooks/<id>/<secret>" \
  -H "Content-Type: application/json" \
  -d '{"sujet":"nouvelle demande client"}'
```

Chaque exécution est tracée avec son origine (manuel / cron / webhook) dans l'historique. Les déclencheurs s'activent/désactivent d'un clic et se testent immédiatement avec le bouton **▶ Tester**.

## Fonctionnement d'un agent

Chaque agent est une boucle agentique : mission (prompt système) → le modèle réfléchit → appelle ses outils (connecteurs) autant de fois que nécessaire → produit son résultat final → transmis à l'agent suivant. Paramètres par agent : fournisseur, modèle, température, nombre max d'itérations, connecteurs attachés. Testable individuellement depuis son panneau de configuration (vraie exécution, vraies API).

## Architecture

- **Backend** : Node.js 20+ · Fastify · WebSocket (suivi live) · SQLite (better-sqlite3, zéro config)
- **Frontend** : vanilla JS, aucun build — canvas custom (pan/zoom, drag, connexions bézier)
- **Sécurité** : mot de passe obligatoire (scrypt), sessions signées, credentials et clés API chiffrés AES-256-GCM, rate-limit login
- **LLM** : appels directs aux API (pas de SDK), providers interchangeables

```
lusine/
├── install.sh              # installation universelle
├── Dockerfile / docker-compose.yml
├── server/
│   ├── index.js            # Fastify : auth, REST, WebSocket
│   ├── engine.js           # boucle agentique + runner de chaîne
│   ├── connectors.js       # catalogue des connecteurs/outils
│   ├── db.js / crypto.js
└── public/                 # SPA (index.html, css, js)
```

## Sauvegarde & mise à jour

Toutes les données vivent dans `data/` (base SQLite + clés). **Sauvegarde ce dossier et le fichier `.env`.**

```bash
cd ~/lusine
git pull && docker compose up -d --build     # mise à jour
docker compose logs -f                        # logs
```

## Feuille de route

- ✅ **v2** — déclencheurs automatiques : cron (planifié) + webhook entrant
- ⏳ Branches conditionnelles (l'agent choisit la suite selon son résultat)
- ⏳ Exécution parallèle des branches
- ⏳ Marketplace de templates de chaînes

---
Fait avec ⚡ à Nice.
