'use strict';
/*
 * Modèles de chaînes prêts à l'emploi.
 * À la création, le premier fournisseur IA de l'utilisateur est assigné à tous les agents ;
 * les connecteurs (credentialIds) restent à cocher par l'utilisateur — chaque mission
 * indique clairement lesquels brancher.
 */

const TEMPLATES = [
  {
    id: 'etsy-ecommerce',
    icon: '🧵',
    name: 'Chaîne e-commerce Etsy',
    description: "D'un simple mot-clé à des annonces publiées : analyse du marché, conception de produits originaux, fiches optimisées, visuels générés, mise en vente.",
    connectors: ['HTTP / API générique (Apify)', 'OpenAI Images', 'Etsy (boutique)'],
    data: {
      nodes: [
        { id: 't1', name: 'Analyste marché', x: 60, y: 200, config: { icon: '🔎', color: '#4f9cf9', temperature: 0.4, maxIterations: 10, retries: 2, retryDelay: 5, mission:
`Tu es analyste e-commerce spécialisé Etsy, expert en détection de produits rentables. On te donne en entrée un créneau ou mot-clé produit (ex : "affiche montessori chambre enfant"). Si l'entrée est vide, choisis toi-même un créneau à forte marge et annonce-le.

MÉTHODE :
1. COLLECTE. Appelle ton outil http_request : method POST, url "/acts/automation-lab~etsy-scraper/run-sync-get-dataset-items", body {"searchQuery": "<le mot-clé>", "maxItems": 40}, timeoutMs 120000.
2. VOLUME (estimé) : sers-toi des avis, favoris et badge Bestseller comme indicateurs de ventes.
3. MARGE (estimée par type) : digital/téléchargeable ≈ 100 %, print-on-demand = élevée, fait-main lourd = faible.
4. SCORE = volume × marge. Fais remonter le SWEET SPOT : fort volume + marge élevée + reproductible en digital/print-on-demand.

RENDS : le sous-créneau le plus rentable, le top 5 produits gagnants (reformulés, jamais copiés), les patterns (prix, styles, mots-clés SEO), et 3 idées de produits ORIGINAUX à créer. Précise que ventes et marges sont estimées.

⚠️ Connecteur requis : coche ton identifiant HTTP générique configuré sur https://api.apify.com/v2 avec ton token Apify.` } },
        { id: 't2', name: 'Concepteur produit', x: 340, y: 200, config: { icon: '🧠', color: '#9b5cff', temperature: 0.8, maxIterations: 6, mission:
`Tu es concepteur produit e-commerce. On te donne l'analyse d'un créneau Etsy porteur.

Transforme les PATTERNS gagnants (jamais les produits copiés) en 3 concepts de produits ORIGINAUX prêts à produire. Pour chacun : NOM accrocheur, TYPE (digital/téléchargeable ou print-on-demand avec support exact), DESCRIPTION DU DESIGN précise (style, couleurs, composition), ANGLE DIFFÉRENCIANT, PRIX conseillé cohérent avec le marché, et un PROMPT D'IMAGE en anglais prêt pour un générateur.

Classe les 3 concepts du plus prometteur au moins prometteur.` } },
        { id: 't3', name: 'Rédacteur fiche', x: 620, y: 200, config: { icon: '✍️', color: '#3ee6c1', temperature: 0.7, maxIterations: 5, mission:
`Tu es rédacteur SEO Etsy. On te donne 3 concepts de produits originaux.

Pour CHAQUE concept, rédige la fiche Etsy complète : TITRE riche en mots-clés (max 140 caractères), 13 TAGS, DESCRIPTION vendeuse et structurée. Reprends les mots-clés SEO de l'analyse marché. Conserve pour chaque produit son prix et son prompt d'image (l'agent suivant en a besoin).` } },
        { id: 't4', name: 'Générateur visuel', x: 900, y: 200, config: { icon: '🎨', color: '#ff6d5a', temperature: 0.7, maxIterations: 8, retries: 1, retryDelay: 5, mission:
`Tu es directeur artistique e-commerce. On te donne des fiches produit avec leurs prompts d'image.

Pour chacun des 3 produits (pas plus) : améliore le prompt d'image (anglais, précis, vendeur), appelle generate_image (taille "1024x1536" pour un portrait, "1536x1024" paysage, "1024x1024" carré), et récupère l'URL hébergée.

RENDS le dossier consolidé produit par produit : nom, fiche Etsy complète (titre, tags, description, prix), URL DE L'IMAGE. ✅ Les URLs sont permanentes (hébergées sur le serveur).

⚠️ Connecteur requis : coche ton identifiant OpenAI Images (GPT Image).` } },
        { id: 't5', name: 'Vendeur Etsy', x: 1180, y: 200, config: { icon: '🧵', color: '#ffa24b', temperature: 0.3, maxIterations: 8, retries: 2, retryDelay: 5, onError: 'continue', loop: 'foreach', loopMaxItems: 5, loopSplitHint: 'une fiche produit complète avec son image', approval: true, mission:
`Tu es responsable de la mise en vente sur Etsy. Tu reçois UNE fiche produit complète (titre, description, prix, tags, URL d'image).

Publie-la avec etsy_create_listing : title, description, price, tags (max 13), image_urls (l'URL du visuel), type "download" pour un produit numérique ou "physical" sinon, state "active".

Si tu ne connais pas la catégorie, cherche-la d'abord avec etsy_request (GET /application/seller-taxonomy/nodes). Indique l'URL de l'annonce créée.

⚠️ Connecteur requis : coche ton identifiant Etsy (boutique).` } }
      ],
      connections: [
        { from: 't1', to: 't2' }, { from: 't2', to: 't3' }, { from: 't3', to: 't4' }, { from: 't4', to: 't5' }
      ],
      settings: {}
    }
  },
  {
    id: 'veille-contenu',
    icon: '📣',
    name: 'Veille & article hebdo',
    description: "Chaque semaine : un agent fait la veille de ton secteur, un second rédige un article SEO complet, un troisième le transforme en posts réseaux sociaux.",
    connectors: ['Recherche web (optionnel)', 'SMTP (optionnel, pour recevoir le résultat)'],
    data: {
      nodes: [
        { id: 'v1', name: 'Veilleur', x: 80, y: 200, config: { icon: '🔎', color: '#4f9cf9', temperature: 0.4, maxIterations: 8, retries: 2, retryDelay: 5, mission:
`Tu es chargé de veille. On te donne en entrée un secteur ou un sujet (ex : "bornes de recharge électrique en France"). Si tu disposes d'un outil de recherche web, utilise-le pour trouver les actualités et évolutions marquantes des 7 derniers jours ; sinon, appuie-toi sur tes connaissances en le précisant.

RENDS une synthèse structurée : les 3 à 5 faits marquants (avec source si disponible), pourquoi c'est important pour le secteur, et l'angle le plus intéressant pour un article de blog cette semaine.` } },
        { id: 'v2', name: 'Rédacteur article', x: 380, y: 200, config: { icon: '✍️', color: '#3ee6c1', temperature: 0.7, maxIterations: 5, mission:
`Tu es rédacteur SEO. On te donne une synthèse de veille avec un angle recommandé.

Rédige un article de blog complet en français : TITRE accrocheur avec mot-clé principal, introduction qui pose l'enjeu, 3 à 5 sections H2 structurées, conclusion avec ouverture. 1200 à 1500 mots, ton expert mais accessible, optimisé SEO (mots-clés naturels, pas de bourrage).` } },
        { id: 'v3', name: 'Community manager', x: 680, y: 200, config: { icon: '📣', color: '#ff6d5a', temperature: 0.85, maxIterations: 4, mission:
`Tu es community manager. On te donne un article de blog complet.

Décline-le en : 1 post LinkedIn (professionnel, avec accroche forte et 3-5 hashtags), 1 thread X/Twitter de 4-6 tweets, et 1 idée de visuel à créer pour accompagner. Garde le lien logique avec l'article, adapte le ton à chaque plateforme.` } }
      ],
      connections: [{ from: 'v1', to: 'v2' }, { from: 'v2', to: 'v3' }],
      settings: {}
    }
  },
  {
    id: 'demandes-entrantes',
    icon: '✉️',
    name: 'Traitement des demandes entrantes',
    description: "Un webhook reçoit tes formulaires de contact : un agent qualifie la demande (chaud/froid), un aiguilleur route vers la bonne réponse, rédigée et prête à envoyer.",
    connectors: ['SMTP (optionnel, pour envoyer les réponses)'],
    data: {
      nodes: [
        { id: 'd1', name: 'Qualificateur', x: 80, y: 220, config: { icon: '🧠', color: '#9b5cff', temperature: 0.3, maxIterations: 4, isRouter: true, routeHint: "Demande commerciale sérieuse (devis, projet, budget) → Réponse commerciale. Question générale, SAV ou hors sujet → Réponse standard.", mission:
`Tu es qualificateur de leads. Tu reçois le contenu d'un formulaire de contact (généralement du JSON : nom, email, message).

Analyse la demande : est-ce une opportunité commerciale sérieuse (projet, devis, budget évoqué, urgence) ou une question générale/SAV ?

RENDS : un résumé de la demande en 2 lignes, le niveau (CHAUD ou FROID) avec justification, et les infos de contact extraites (nom, email).` } },
        { id: 'd2', name: 'Réponse commerciale', x: 420, y: 120, config: { icon: '💼', color: '#ff6d5a', temperature: 0.6, maxIterations: 4, mission:
`Tu es commercial. On te donne une demande entrante qualifiée CHAUDE avec les coordonnées du prospect.

Rédige un email de réponse personnalisé et engageant : remercie, reformule son besoin pour montrer qu'il a été compris, propose un créneau d'échange téléphonique, signe professionnellement. Ton chaleureux, réactif, sans jargon. Rends l'objet ET le corps de l'email, prêts à envoyer.` } },
        { id: 'd3', name: 'Réponse standard', x: 420, y: 320, config: { icon: '📨', color: '#4f9cf9', temperature: 0.5, maxIterations: 4, mission:
`Tu es chargé de relation client. On te donne une demande entrante générale (question, SAV, information).

Rédige un email de réponse courtois et utile : réponds à la question si possible, oriente vers la bonne ressource sinon, et laisse une porte ouverte. Rends l'objet ET le corps de l'email, prêts à envoyer.` } }
      ],
      connections: [{ from: 'd1', to: 'd2' }, { from: 'd1', to: 'd3' }],
      settings: {}
    }
  },
  {
    id: 'rapport-hebdo',
    icon: '📊',
    name: 'Rapport hebdomadaire automatique',
    description: "Chaque lundi matin : un agent interroge ta base de données, un second analyse les chiffres et rédige la synthèse, un troisième te l'envoie par email.",
    connectors: ['PostgreSQL / Supabase', 'SMTP'],
    data: {
      nodes: [
        { id: 'r1', name: 'Collecteur de données', x: 80, y: 200, config: { icon: '🐘', color: '#4f9cf9', temperature: 0.2, maxIterations: 8, retries: 2, retryDelay: 5, mission:
`Tu es analyste data. Interroge la base de données avec ton outil SQL pour collecter les chiffres de la semaine écoulée (7 derniers jours) : d'abord liste les tables disponibles pour comprendre le schéma, puis requête les données pertinentes (nouvelles lignes, totaux, évolutions).

RENDS les chiffres bruts organisés par thème, avec les requêtes utilisées.

⚠️ Connecteur requis : coche ton identifiant PostgreSQL/Supabase. Adapte les requêtes au schéma réel que tu découvres.` } },
        { id: 'r2', name: 'Analyste', x: 380, y: 200, config: { icon: '📊', color: '#9b5cff', temperature: 0.5, maxIterations: 4, mission:
`Tu es analyste business. On te donne les chiffres bruts de la semaine.

Rédige une synthèse claire pour un dirigeant : les 3 chiffres clés de la semaine, les tendances (hausse/baisse et pourquoi), les points d'attention, et 1 ou 2 recommandations concrètes. Format : court, direct, scannable.` } },
        { id: 'r3', name: 'Expéditeur', x: 680, y: 200, config: { icon: '📤', color: '#3ee6c1', temperature: 0.3, maxIterations: 4, mission:
`Tu es assistant. On te donne une synthèse hebdomadaire.

Envoie-la par email avec ton outil SMTP : objet "📊 Rapport hebdo — semaine du <date>", corps = la synthèse mise en forme proprement (HTML simple si l'outil le permet). Confirme l'envoi.

⚠️ Connecteur requis : coche ton identifiant SMTP et indique dans cette mission l'adresse de destination (ex : "envoie à contact@monentreprise.fr").` } }
      ],
      connections: [{ from: 'r1', to: 'r2' }, { from: 'r2', to: 'r3' }],
      settings: {}
    }
  }
];

function listTemplates() {
  return TEMPLATES.map(t => ({
    id: t.id, icon: t.icon, name: t.name, description: t.description,
    connectors: t.connectors, agents: t.data.nodes.map(n => ({ name: n.name, icon: n.config.icon }))
  }));
}

function getTemplate(id) { return TEMPLATES.find(t => t.id === id) || null; }

module.exports = { listTemplates, getTemplate };
