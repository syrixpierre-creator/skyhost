/**
 * User documentation shown at /docs. Bodies use a small Markdown subset rendered by pages/Docs.tsx:
 * "## " and "### " headings, "- " and "1. " lists, "> " notes, ``` code blocks, `code`, **bold** and [links](/path).
 */
type Text = { en: string; fr: string };

export interface Article {
  slug: string;
  section: "start" | "guides" | "help";
  title: Text;
  summary: Text;
  body: Text;
}

export const SECTIONS: Record<Article["section"], Text> = {
  start: { en: "Getting started", fr: "Premiers pas" },
  guides: { en: "Guides", fr: "Guides" },
  help: { en: "Help", fr: "Aide" },
};

export const ARTICLES: Article[] = [
  {
    slug: "getting-started",
    section: "start",
    title: { en: "Deploy your first app", fr: "Déployer votre première app" },
    summary: { en: "From a GitHub repository or a ZIP to a live HTTPS address in a few minutes.", fr: "D'un dépôt GitHub ou d'un ZIP à une adresse HTTPS en ligne en quelques minutes." },
    body: {
      en: `## 1. Create an account
Sign up at [skyhost.tech](/signup) with your email, Google or GitHub. The free plan needs no credit card.

## 2. Pick your code
Click **New project** in the sidebar, then choose:
- **GitHub**: connect your account once, then pick a repository and a branch. Every push to that branch redeploys automatically.
- **ZIP upload**: upload an archive of your project folder (without \`node_modules\`).
- **Template**: start from a ready-made starter such as Next.js + PostgreSQL or a WhatsApp bot.

## 3. Check the analysis
SKYHOST reads your project and detects the language, the framework, the build and start commands and the port. You can change any of them before deploying. A monorepo shows one entry per app it finds.

## 4. Deploy
Click **Deploy**. The deployment page streams the build logs live. When it finishes, the **Live at** banner at the top shows your address, for example \`https://web-ab12cd.skyhost.tech\`. Click **Open app**.

> Next steps: [add a database](/docs/databases), [set environment variables](/docs/environment-variables) and [connect your own domain](/docs/custom-domains).`,
      fr: `## 1. Créer un compte
Inscrivez-vous sur [skyhost.tech](/signup) avec votre e-mail, Google ou GitHub. Le plan gratuit ne demande pas de carte bancaire.

## 2. Choisir votre code
Cliquez sur **Nouveau projet** dans le menu, puis choisissez :
- **GitHub** : connectez votre compte une fois, puis choisissez un dépôt et une branche. Chaque push sur cette branche redéploie automatiquement.
- **Envoi d'un ZIP** : envoyez une archive du dossier de votre projet (sans \`node_modules\`).
- **Modèle** : partez d'un projet prêt à l'emploi comme Next.js + PostgreSQL ou un bot WhatsApp.

## 3. Vérifier l'analyse
SKYHOST lit votre projet et détecte le langage, le framework, les commandes de build et de démarrage et le port. Vous pouvez tout modifier avant de déployer. Un monorepo affiche une entrée par application trouvée.

## 4. Déployer
Cliquez sur **Déployer**. La page du déploiement affiche les logs de build en direct. À la fin, le bandeau **En ligne sur** en haut affiche votre adresse, par exemple \`https://web-ab12cd.skyhost.tech\`. Cliquez sur **Ouvrir l'app**.

> Ensuite : [ajoutez une base de données](/docs/databases), [définissez des variables d'environnement](/docs/environment-variables) et [connectez votre propre domaine](/docs/custom-domains).`,
    },
  },
  {
    slug: "frameworks",
    section: "guides",
    title: { en: "Languages and frameworks", fr: "Langages et frameworks" },
    summary: { en: "What SKYHOST detects and what your app must do to run.", fr: "Ce que SKYHOST détecte et ce que votre app doit faire pour tourner." },
    body: {
      en: `## The one rule: listen on PORT
Web services receive a \`PORT\` environment variable. Your app must listen on that port and on all interfaces (\`0.0.0.0\`), not \`localhost\`.
\`\`\`
// Node.js
app.listen(process.env.PORT || 3000, "0.0.0.0");
\`\`\`
\`\`\`
# Python
uvicorn main:app --host 0.0.0.0 --port $PORT
\`\`\`

## Node.js
Detected from \`package.json\`. The package manager follows your lockfile (npm, pnpm, Yarn or Bun). SKYHOST runs \`build\` if it exists, then \`start\`. Next.js, Nuxt, SvelteKit, Astro, Express, NestJS and others are recognised. Pin the Node version with \`engines.node\` in \`package.json\`.

## Python
Detected from \`requirements.txt\`, \`pyproject.toml\` or \`Pipfile\`. Django, Flask, FastAPI and Streamlit get a suitable start command. For Django, set \`ALLOWED_HOSTS\` to include your SKYHOST address.

## PHP
Laravel and Symfony are detected from \`composer.json\`. Set \`APP_KEY\` and the database variables.

## Static sites
Plain HTML or a front-end build (Vite, Create React App…) is served as a static site with HTTPS, compression and an SPA fallback, so client-side routes work.

## Docker
If your repository has a \`Dockerfile\`, SKYHOST builds it as is. Expose the port your app listens on, or read \`PORT\`.

## Bots and workers
A service without a web port (a Discord or WhatsApp bot, a queue consumer) is created as a **worker**: it runs continuously and gets no public address. Add a volume if it must keep files, for example a WhatsApp session.

## Cron jobs
Choose the **Cron job** type and a schedule such as \`0 3 * * *\` (every day at 03:00 UTC). The command runs to completion each time.`,
      fr: `## La règle d'or : écouter sur PORT
Les services web reçoivent une variable d'environnement \`PORT\`. Votre app doit écouter sur ce port et sur toutes les interfaces (\`0.0.0.0\`), pas \`localhost\`.
\`\`\`
// Node.js
app.listen(process.env.PORT || 3000, "0.0.0.0");
\`\`\`
\`\`\`
# Python
uvicorn main:app --host 0.0.0.0 --port $PORT
\`\`\`

## Node.js
Détecté grâce à \`package.json\`. Le gestionnaire de paquets suit votre lockfile (npm, pnpm, Yarn ou Bun). SKYHOST lance \`build\` s'il existe, puis \`start\`. Next.js, Nuxt, SvelteKit, Astro, Express, NestJS et d'autres sont reconnus. Fixez la version de Node avec \`engines.node\` dans \`package.json\`.

## Python
Détecté grâce à \`requirements.txt\`, \`pyproject.toml\` ou \`Pipfile\`. Django, Flask, FastAPI et Streamlit reçoivent une commande de démarrage adaptée. Pour Django, ajoutez votre adresse SKYHOST à \`ALLOWED_HOSTS\`.

## PHP
Laravel et Symfony sont détectés grâce à \`composer.json\`. Définissez \`APP_KEY\` et les variables de base de données.

## Sites statiques
Du HTML simple ou un build front-end (Vite, Create React App…) est servi comme site statique avec HTTPS, compression et repli SPA, pour que les routes côté client fonctionnent.

## Docker
Si votre dépôt contient un \`Dockerfile\`, SKYHOST le construit tel quel. Exposez le port sur lequel votre app écoute, ou lisez \`PORT\`.

## Bots et workers
Un service sans port web (bot Discord ou WhatsApp, consommateur de file) est créé comme **worker** : il tourne en continu et n'a pas d'adresse publique. Ajoutez un volume s'il doit garder des fichiers, par exemple une session WhatsApp.

## Tâches cron
Choisissez le type **Tâche cron** et un horaire comme \`0 3 * * *\` (tous les jours à 03:00 UTC). La commande s'exécute jusqu'au bout à chaque fois.`,
    },
  },
  {
    slug: "databases",
    section: "guides",
    title: { en: "Databases", fr: "Bases de données" },
    summary: { en: "PostgreSQL, MySQL, MongoDB and Redis, connected in one click.", fr: "PostgreSQL, MySQL, MongoDB et Redis, connectés en un clic." },
    body: {
      en: `## Create a database
Click **New database** in the sidebar, pick PostgreSQL, MySQL (MariaDB), MongoDB or Redis, a name and a size. It is ready in a few seconds. The overview shows:
- **Internal URL**: use it from your SKYHOST services. Traffic stays on the private network.
- **External URL**: use it from your computer (a database client, migrations). Enable it first and restrict it to your IP when possible.
- the host, port, database name, user and password.

## Connect it to a service
On the database page, open **Connections** and pick a service of your team. SKYHOST adds a variable such as \`DATABASE_URL\` (PostgreSQL, MySQL), \`MONGODB_URI\` or \`REDIS_URL\` to the service and redeploys it. You can also reference it yourself: \`\${{db.DATABASE_URL}}\`.

## Backups
Paid plans get automatic daily backups. You can also take a manual backup and restore it from the **Backups** tab.

> Deleting a database deletes its data and its backups for good. Download a backup first if you may need it.`,
      fr: `## Créer une base
Cliquez sur **Nouvelle base de données** dans le menu, choisissez PostgreSQL, MySQL (MariaDB), MongoDB ou Redis, un nom et une taille. Elle est prête en quelques secondes. La page d'aperçu affiche :
- **URL interne** : à utiliser depuis vos services SKYHOST. Le trafic reste sur le réseau privé.
- **URL externe** : à utiliser depuis votre ordinateur (client de base, migrations). Activez-la d'abord et limitez-la à votre IP si possible.
- l'hôte, le port, le nom de la base, l'utilisateur et le mot de passe.

## La connecter à un service
Sur la page de la base, ouvrez **Connexions** et choisissez un service de votre équipe. SKYHOST ajoute une variable comme \`DATABASE_URL\` (PostgreSQL, MySQL), \`MONGODB_URI\` ou \`REDIS_URL\` au service et le redéploie. Vous pouvez aussi la référencer vous-même : \`\${{db.DATABASE_URL}}\`.

## Sauvegardes
Les plans payants ont une sauvegarde automatique quotidienne. Vous pouvez aussi faire une sauvegarde manuelle et la restaurer depuis l'onglet **Sauvegardes**.

> Supprimer une base supprime définitivement ses données et ses sauvegardes. Téléchargez une sauvegarde avant si vous risquez d'en avoir besoin.`,
    },
  },
  {
    slug: "environment-variables",
    section: "guides",
    title: { en: "Environment variables", fr: "Variables d'environnement" },
    summary: { en: "Secrets, references between services and shared groups.", fr: "Secrets, références entre services et groupes partagés." },
    body: {
      en: `## Add variables
Open a service, then **Variables**. Add them one by one or paste a whole \`.env\` file. Saving redeploys the service so the new values apply. Values are encrypted and hidden in logs.

## References
A value can point to another service or database of the project:
\`\`\`
DATABASE_URL=\${{db.DATABASE_URL}}
API_URL=https://\${{api.SKYHOST_PUBLIC_DOMAIN}}
\`\`\`
References are resolved at deploy time, so they follow password rotations and domain changes.

## Variables set by SKYHOST
- \`PORT\`: the port your web service must listen on.
- \`SKYHOST_*\`: information about the service, the environment and its public address.

## Shared variables
In the project settings, shared variables and variable groups apply to several services at once. A value set on the service itself always wins.`,
      fr: `## Ajouter des variables
Ouvrez un service, puis **Variables**. Ajoutez-les une par une ou collez un fichier \`.env\` entier. L'enregistrement redéploie le service pour appliquer les nouvelles valeurs. Les valeurs sont chiffrées et masquées dans les logs.

## Références
Une valeur peut pointer vers un autre service ou une base du projet :
\`\`\`
DATABASE_URL=\${{db.DATABASE_URL}}
API_URL=https://\${{api.SKYHOST_PUBLIC_DOMAIN}}
\`\`\`
Les références sont résolues au déploiement : elles suivent les changements de mot de passe et de domaine.

## Variables définies par SKYHOST
- \`PORT\` : le port sur lequel votre service web doit écouter.
- \`SKYHOST_*\` : des informations sur le service, l'environnement et son adresse publique.

## Variables partagées
Dans les paramètres du projet, les variables partagées et les groupes de variables s'appliquent à plusieurs services à la fois. Une valeur définie sur le service lui-même est toujours prioritaire.`,
    },
  },
  {
    slug: "custom-domains",
    section: "guides",
    title: { en: "Custom domains", fr: "Domaines personnalisés" },
    summary: { en: "Serve your app on your own domain with free HTTPS.", fr: "Servez votre app sur votre propre domaine avec HTTPS gratuit." },
    body: {
      en: `## Add the domain
Open the service, then **Domains** (on a phone, pick it in the section menu) and enter your domain, for example \`www.example.com\`.

## Create the DNS records
At your registrar (Hostinger, Namecheap, Cloudflare…), create the records SKYHOST shows:
1. A **TXT** record named \`_skyhost-challenge.www.example.com\` with the \`skyhost-verify=…\` value. It proves you own the domain.
2. A **CNAME** record \`www\` pointing to your service address, or an **A** record with the server IP for a root domain such as \`example.com\`.

Then click **Verify**. DNS changes can take from a few minutes to a few hours.

## HTTPS
Once the domain is verified, a Let's Encrypt certificate is issued automatically and renewed before it expires. The status goes from **Pending** to **Certificate issued**.

## Common problems
- **Verification fails**: check there is only one A record for the name. Registrars often add a default "parking" record that must be deleted.
- **Cloudflare**: set the CNAME to "DNS only" (grey cloud) until the certificate is issued.`,
      fr: `## Ajouter le domaine
Ouvrez le service, puis **Domaines** (sur téléphone, choisissez-le dans le menu des sections) et saisissez votre domaine, par exemple \`www.example.com\`.

## Créer les enregistrements DNS
Chez votre registraire (Hostinger, Namecheap, Cloudflare…), créez les enregistrements affichés par SKYHOST :
1. Un enregistrement **TXT** nommé \`_skyhost-challenge.www.example.com\` avec la valeur \`skyhost-verify=…\`. Il prouve que le domaine vous appartient.
2. Un enregistrement **CNAME** \`www\` vers l'adresse de votre service, ou un enregistrement **A** avec l'IP du serveur pour un domaine racine comme \`example.com\`.

Cliquez ensuite sur **Vérifier**. Les changements DNS prennent de quelques minutes à quelques heures.

## HTTPS
Une fois le domaine vérifié, un certificat Let's Encrypt est émis automatiquement et renouvelé avant expiration. Le statut passe de **En attente** à **Certificat émis**.

## Problèmes courants
- **La vérification échoue** : vérifiez qu'il n'y a qu'un seul enregistrement A pour ce nom. Les registraires ajoutent souvent un enregistrement de « parking » par défaut qu'il faut supprimer.
- **Cloudflare** : mettez le CNAME en « DNS only » (nuage gris) jusqu'à l'émission du certificat.`,
    },
  },
  {
    slug: "notifications",
    section: "guides",
    title: { en: "Alerts and notifications", fr: "Alertes et notifications" },
    summary: { en: "Get told by email, Telegram, WhatsApp, Slack or Discord when something breaks.", fr: "Soyez prévenu par e-mail, Telegram, WhatsApp, Slack ou Discord quand quelque chose casse." },
    body: {
      en: `## Email
Crashes, failed deployments, outages and payment problems are emailed to every team member by default, with the probable cause and the last log lines. Change this in **Account → Notifications**.

## Telegram
1. In Telegram, talk to **@BotFather**, send \`/newbot\` and copy the bot token.
2. Send any message to your new bot, then find your chat ID (for example with **@userinfobot**).
3. In **Team settings → Notifications**, add a Telegram channel with the token and the chat ID, then click **Test**.

## WhatsApp
WhatsApp alerts use the free CallMeBot service. Follow the instructions on [callmebot.com](https://www.callmebot.com/blog/free-api-whatsapp-messages/) to get your API key, then add a WhatsApp channel with your number (international format) and the key.

## Slack, Discord and webhooks
Paste an incoming webhook URL. Generic webhooks receive a signed JSON body you can verify.`,
      fr: `## E-mail
Les crashs, les déploiements échoués, les pannes et les problèmes de paiement sont envoyés par e-mail à chaque membre de l'équipe par défaut, avec la cause probable et les dernières lignes de log. Modifiez cela dans **Compte → Notifications**.

## Telegram
1. Dans Telegram, parlez à **@BotFather**, envoyez \`/newbot\` et copiez le jeton du bot.
2. Envoyez un message à votre nouveau bot, puis trouvez votre identifiant de chat (par exemple avec **@userinfobot**).
3. Dans **Paramètres de l'équipe → Notifications**, ajoutez un canal Telegram avec le jeton et l'identifiant, puis cliquez sur **Tester**.

## WhatsApp
Les alertes WhatsApp passent par le service gratuit CallMeBot. Suivez les instructions sur [callmebot.com](https://www.callmebot.com/blog/free-api-whatsapp-messages/) pour obtenir votre clé API, puis ajoutez un canal WhatsApp avec votre numéro (format international) et la clé.

## Slack, Discord et webhooks
Collez l'URL d'un webhook entrant. Les webhooks génériques reçoivent un JSON signé que vous pouvez vérifier.`,
    },
  },
  {
    slug: "billing",
    section: "guides",
    title: { en: "Plans and billing", fr: "Plans et facturation" },
    summary: { en: "Plans, credits, invoices and pay-as-you-go usage.", fr: "Plans, crédits, factures et usage à la consommation." },
    body: {
      en: `## Plans
Each team has a plan that sets its limits: projects, services, databases, memory, storage and features. Compare them on the [pricing section](/#pricing) and change plan in **Billing**.

## Credits
Credits (from a promo code, a referral or a top-up) are used before your card. The balance is shown in **Billing**.

## Pay as you go
When enabled by SKYHOST, CPU, memory, bandwidth and build minutes beyond what your plan includes are billed at the end of the month. **Billing** shows the estimate for the current month in real time, line by line.

## Invoices
Every payment produces an invoice you can download from **Billing → Invoices**.

## Unpaid invoices
If a payment fails, the team is marked past due and you are emailed. Pay the invoice to avoid your services being paused.`,
      fr: `## Plans
Chaque équipe a un plan qui fixe ses limites : projets, services, bases, mémoire, stockage et fonctionnalités. Comparez-les dans la [section tarifs](/#pricing) et changez de plan dans **Facturation**.

## Crédits
Les crédits (code promo, parrainage ou recharge) sont utilisés avant votre carte. Le solde est affiché dans **Facturation**.

## À la consommation
Quand SKYHOST l'active, le CPU, la mémoire, la bande passante et les minutes de build au-delà de ce que votre plan inclut sont facturés en fin de mois. **Facturation** affiche l'estimation du mois en cours en temps réel, ligne par ligne.

## Factures
Chaque paiement produit une facture téléchargeable dans **Facturation → Factures**.

## Factures impayées
Si un paiement échoue, l'équipe passe en retard de paiement et vous recevez un e-mail. Réglez la facture pour éviter la mise en pause de vos services.`,
    },
  },
  {
    slug: "cli-and-api",
    section: "guides",
    title: { en: "CLI and API", fr: "CLI et API" },
    summary: { en: "Deploy and manage services from your terminal or your own scripts.", fr: "Déployez et gérez vos services depuis le terminal ou vos scripts." },
    body: {
      en: `## CLI
\`\`\`
skyhost login          # opens the browser to approve the device
skyhost init           # create a service from the current folder
skyhost deploy         # upload and deploy the current folder
skyhost logs -f        # follow the runtime logs
skyhost env set KEY=value
skyhost db create postgres
skyhost rollback
\`\`\`
Run \`skyhost help\` for every command.

## API
Create an API key in **Account → API keys**, then send it as \`Authorization: Bearer <key>\`. The full reference is at [/api/docs](/api/docs).

## Deploy hooks
A deploy hook is a secret URL that redeploys a service when called, handy for CI pipelines or a CMS. Create one in the service settings.`,
      fr: `## CLI
\`\`\`
skyhost login          # ouvre le navigateur pour approuver l'appareil
skyhost init           # crée un service depuis le dossier courant
skyhost deploy         # envoie et déploie le dossier courant
skyhost logs -f        # suit les logs d'exécution
skyhost env set CLE=valeur
skyhost db create postgres
skyhost rollback
\`\`\`
Lancez \`skyhost help\` pour voir toutes les commandes.

## API
Créez une clé API dans **Compte → Clés API**, puis envoyez-la en \`Authorization: Bearer <clé>\`. La référence complète est sur [/api/docs](/api/docs).

## Deploy hooks
Un deploy hook est une URL secrète qui redéploie un service quand on l'appelle, pratique pour une CI ou un CMS. Créez-en un dans les paramètres du service.`,
    },
  },
  {
    slug: "troubleshooting",
    section: "help",
    title: { en: "Troubleshooting", fr: "Dépannage" },
    summary: { en: "Fixes for the most common build, deploy and runtime problems.", fr: "Solutions aux problèmes de build, de déploiement et d'exécution les plus courants." },
    body: {
      en: `When a deployment fails, the deployment page shows the probable cause and a suggested fix above the logs. The most common cases:

## Bad Gateway (502)
Your app is running but SKYHOST cannot reach it.
- Listen on \`process.env.PORT\` and on \`0.0.0.0\`, not \`localhost\` or \`127.0.0.1\`.
- Check that the port in the service settings matches the one your app prints in its logs.

## The build fails
- **Module not found**: the dependency is missing from \`package.json\` or \`requirements.txt\`, or only in \`devDependencies\` while needed at runtime.
- **Out of memory**: large front-end builds need more memory. Upgrade the plan or reduce the build (for example disable source maps).
- **Wrong folder**: in a monorepo, set the **Root directory** to the app folder.

## The app keeps restarting (crash loop)
Open the **Logs** tab: the error is usually in the last lines. Missing environment variables and an unreachable database are the usual causes.

## The site says "Not secure" or the certificate is pending
Certificates are issued once DNS points to SKYHOST. A new address can take a minute. For custom domains, see [Custom domains](/docs/custom-domains).

## Changes do not appear
Check the deployment finished and is **Live**. Static sites may be cached by your browser: reload with Ctrl+Shift+R.

## Still stuck?
[Open a support ticket](/support) with the project and service name and what you expected to happen.`,
      fr: `Quand un déploiement échoue, la page du déploiement affiche la cause probable et une solution au-dessus des logs. Les cas les plus courants :

## Bad Gateway (502)
Votre app tourne mais SKYHOST ne peut pas la joindre.
- Écoutez sur \`process.env.PORT\` et sur \`0.0.0.0\`, pas \`localhost\` ni \`127.0.0.1\`.
- Vérifiez que le port des paramètres du service correspond à celui que votre app affiche dans ses logs.

## Le build échoue
- **Module introuvable** : la dépendance manque dans \`package.json\` ou \`requirements.txt\`, ou elle est seulement dans \`devDependencies\` alors qu'elle sert à l'exécution.
- **Mémoire insuffisante** : les gros builds front-end demandent plus de mémoire. Passez à un plan supérieur ou allégez le build (par exemple sans source maps).
- **Mauvais dossier** : dans un monorepo, réglez le **Dossier racine** sur le dossier de l'app.

## L'app redémarre en boucle
Ouvrez l'onglet **Logs** : l'erreur est généralement dans les dernières lignes. Les causes habituelles sont une variable d'environnement manquante ou une base injoignable.

## Le site affiche « Non sécurisé » ou le certificat est en attente
Les certificats sont émis une fois que le DNS pointe vers SKYHOST. Une nouvelle adresse peut prendre une minute. Pour les domaines personnalisés, voir [Domaines personnalisés](/docs/custom-domains).

## Les changements n'apparaissent pas
Vérifiez que le déploiement est terminé et **En ligne**. Les sites statiques peuvent être en cache dans le navigateur : rechargez avec Ctrl+Maj+R.

## Toujours bloqué ?
[Ouvrez un ticket de support](/support) avec le nom du projet et du service et ce que vous attendiez.`,
    },
  },
];
