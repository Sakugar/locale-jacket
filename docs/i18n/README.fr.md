# Locale Jacket

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · **Français** · [Español](README.es.md) · [Русский](README.ru.md) · [Português (Brasil)](README.pt-BR.md)

> Ce document est une traduction du README anglais. En cas de divergence, la [version anglaise](../../README.md) fait foi ; elle contient aussi les détails techniques et de développement.

Locale Jacket est une extension Chrome / Edge (Manifest V3) qui montre aux sites des **paramètres régionaux différents selon le site** (par exemple `en-US` sur google.com et `ja-JP` sur apple.com), tandis que la langue de l’interface du navigateur reste inchangée.

Elle automatise ce que fait **Outils de développement ▸ Capteurs ▸ Paramètres régionaux**, sur chaque onglet concerné, sans ouvrir les outils de développement. Les règles s’écrivent comme dans Clash, sing-box ou Shadowrocket : `DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`, `DOMAIN-REGEX`, `GEOSITE`, `IP-CIDR`, `IP-CIDR6`, `IP-ASN` et `GEOIP`, avec des exceptions `SYSTEM`/`DIRECT` et une action par défaut.

## Fonctionnalités

| Ce que voit le site | Comment c’est usurpé | Portée |
|---|---|---|
| `Intl.*` (DateTimeFormat, NumberFormat, Collator, `toLocaleString`…) | `Emulation.setLocaleOverride` | Page, cadres du même site et intersites, workers dédiés |
| `navigator.language`, `navigator.languages` | `Emulation.setUserAgentOverride` avec **uniquement** `acceptLanguage` (User-Agent et Client Hints inchangés) | Page, cadres, workers dédiés |
| En-tête HTTP `Accept-Language` | Le même remplacement, plus `declarativeNetRequest` pour la première requête du document | Documents, sous-ressources, `fetch()`, requêtes des workers |
| Fuseau horaire, géolocalisation | **Désactivés par défaut**, activables par règle | Page et cadres |

- Aucune API JavaScript de la page n’est modifiée : seule l’émulation intégrée de Chrome est utilisée.
- Tout s’exécute localement : ni serveur, ni compte, ni télémétrie.
- L’interface existe en 10 langues (voir plus bas).

## Installation

**Depuis une release (recommandé)**
1. Sur la page *Releases* de GitHub, téléchargez `locale-jacket-<version>.zip` et décompressez-le.
2. Ouvrez `chrome://extensions` (Edge : `edge://extensions`), activez le **Mode développeur**, cliquez sur **Charger l’extension non empaquetée** et choisissez le dossier décompressé.
3. Épinglez l’extension : son badge (par exemple `EN` ou `JA`) indique le profil de l’onglet actif. Pour la navigation privée, activez **Autoriser en mode navigation privée** dans les détails de l’extension.

**Mise à jour :** pour un dossier non empaqueté de la version précédente, utilisez `locale-jacket-<ancienne>-to-<nouvelle>.diff.zip`. Il ne contient que les fichiers ajoutés ou modifiés : copiez-les par-dessus l’ancien dossier, supprimez les fichiers listés dans `DELETED.txt` (s’il existe), puis rechargez l’extension. L’ID de l’extension et vos réglages sont conservés.

**Fichier `.crx` :** signé avec la même clé (ID `jenefdmhnbfepiohiplfobageceacokb`), mais Chrome et Edge n’installent un `.crx` hors de leur boutique que si une stratégie d’entreprise l’autorise. Pour un usage personnel, utilisez **Charger l’extension non empaquetée**.

**Depuis les sources :** Node.js 20+ requis. Lancez `npm install` puis `npm run build`, et chargez le dossier `dist/` généré. Compatible Chrome / Edge 125 et plus (développé et testé sur 155).

**Règles au premier lancement :** lors d’une nouvelle installation, l’extension lit `presets/default-rules.yaml` dans son dossier (même format que *Importer / exporter*). Modifiez ce fichier avant de charger le dossier pour démarrer avec vos propres règles. Le `.crx` ne contient pas ce fichier et génère lui-même le même préréglage d’exemple.

## Règles par défaut

| Règle | Résultat |
|---|---|
| `DOMAIN-SUFFIX,google.com` | `en-US` |
| `DOMAIN-SUFFIX,openai.com` | `en-US` |
| `DOMAIN-SUFFIX,apple.com` | `ja-JP` |
| `DOMAIN-SUFFIX,yahoo.co.jp` | `ja-JP` |
| `DOMAIN,accounts.google.com` | `SYSTEM` (vrais paramètres régionaux) |
| par défaut | `SYSTEM` |

Vous pouvez les modifier ou les supprimer librement depuis la fenêtre contextuelle ou la page d’options.

## Barre de débogage

Tant qu’un onglet est usurpé, Chrome affiche **« Locale Jacket a commencé à déboguer ce navigateur »**. C’est l’avertissement de sécurité de Chrome pour l’API `chrome.debugger` ; l’extension ne le masque pas. Cliquer sur **Annuler** met Locale Jacket en pause jusqu’à ce que vous cliquiez sur **Reprendre** dans la fenêtre contextuelle.

Si vous acceptez ce compromis de sécurité, [`tools/chrome-banner-flag.ps1`](../../tools/chrome-banner-flag.ps1) (Windows) ajoute l’option de lancement `--silent-debugger-extension-api` à Chrome. Cela masque l’avertissement pour **toutes** les extensions utilisant l’autorisation de débogage. Détails dans le [README anglais](../../README.md#hiding-the-debugging-banner-optional).

## Utilisation

**Fenêtre contextuelle** (icône de la barre d’outils) : interrupteur global ; règle, profil et état de l’onglet actif ; « Vérifier ce que voit la page » ; ajout ou modification d’une règle pour le site actuel ; action par défaut pour tous les autres sites.

**Page d’options :**
- **Règles :** activer / désactiver, réordonner, modifier, supprimer ; les doublons, conflits et règles redondantes sont signalés.
- **Tester et vérifier :** saisissez un nom d’hôte pour voir quelles règles correspondent et pourquoi, ou vérifiez ce que rapporte réellement un onglet ouvert.
- **Importer / exporter :** JSON ou YAML, en remplaçant ou en fusionnant.
- **Jeux de données :** téléchargement, import et mise à jour automatique des données GeoSite / GeoIP / ASN.
- **Paramètres :** langue d’affichage, mode des cadres, etc.
- **Sessions et journal :** onglets en cours de débogage et journal d’activité en mémoire.

## Règles

```yaml
rules:
  - type: DOMAIN-SUFFIX        # google.com et tous ses sous-domaines (par labels)
    domain: google.com
    locale: en-US
  - type: DOMAIN               # uniquement ce nom d’hôte exact
    domain: accounts.google.com
    action: SYSTEM             # garder les vrais paramètres régionaux (DIRECT est un alias)
  - type: DOMAIN-KEYWORD       # le nom d’hôte contient ce texte
    keyword: microsoft
    locale: en-GB
  - DOMAIN-SUFFIX,yahoo.co.jp,ja-JP   # la forme courte de type Clash est acceptée
  - GEOSITE,google,en-US              # nécessite le jeu de données GeoSite
  - IP-CIDR,17.0.0.0/8,en-US          # adresse du serveur dans la plage
  - GEOIP,LAN,SYSTEM                  # adresses privées, aucune donnée nécessaire
default:
  mode: SYSTEM                 # ou : mode: PROFILE + locale/languages/…
```

**Priorité** (déterministe ; la première différence décide) :
1. Type de règle : `DOMAIN` › `DOMAIN-SUFFIX` › `DOMAIN-KEYWORD` › `DOMAIN-REGEX` › `GEOSITE` › `IP-CIDR`/`IP-CIDR6` › `IP-ASN` › `GEOIP`. Les règles de nom d’hôte l’emportent toujours sur les règles IP.
2. Au sein d’un type, la plus précise gagne (suffixe avec le plus de labels, plage IP au préfixe le plus long).
3. La `priority` la plus élevée gagne.
4. La position la plus haute dans la liste gagne.
5. L’action par défaut ne s’applique que si rien ne correspond.

Ainsi `DOMAIN,accounts.google.com → SYSTEM` l’emporte toujours sur `DOMAIN-SUFFIX,google.com → en-US`, quel que soit l’ordre.

## Jeux de données et mises à jour automatiques

Les règles `GEOSITE`, `GEOIP` (pays) et `IP-ASN` nécessitent des fichiers de données. Rien n’est téléchargé sans votre demande : dans *Options ▸ Jeux de données*, téléchargez-les depuis une URL modifiable ou importez un fichier local.

**Mises à jour automatiques** (facultatives, désactivées par défaut) : vérifier les jeux de données téléchargés au démarrage du navigateur et/ou chaque jour, semaine ou mois. Un **délai minimal** (24 h par défaut, de 1 à 720 h) limite chaque jeu de données à une tentative automatique par période, échecs compris : les redémarrages ne provoquent jamais de téléchargements répétés. Les requêtes sont conditionnelles ; un fichier inchangé n’est pas retéléchargé. Les fichiers importés ne sont jamais mis à jour automatiquement.

Les règles IP utilisent l’adresse à laquelle Chrome s’est réellement connecté ; l’extension n’effectue aucune requête DNS.

## Langue de l’interface

La fenêtre contextuelle et la page d’options existent en English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Русский et Português (Brasil). Par défaut elles suivent la langue du navigateur ; modifiable dans *Options ▸ Paramètres ▸ Langue d’affichage*. Cela ne change jamais ce que voient les sites.

## Confidentialité et autorisations

Tout s’exécute localement. En dehors des téléchargements de jeux de données que vous lancez et des mises à jour automatiques que vous activez (toujours depuis l’URL affichée), l’extension n’effectue aucune requête réseau. Les règles sont stockées dans `chrome.storage.local` ; le journal d’activité reste en mémoire et ne contient que des noms d’hôte.

Autorisations : `debugger` (l’émulation elle-même), `webNavigation` et accès aux sites, `declarativeNetRequestWithHostAccess` (Accept-Language de la première requête), `webRequest` (adresses de serveur pour les règles IP, en observation seulement), `alarms` (vérification planifiée des mises à jour, seulement si activée), `storage`.

## Limites

- L’extension ne peut pas masquer la barre de débogage (voir ci-dessus).
- Les pages `chrome://` et `edge://`, la page Nouvel onglet, les boutiques d’extensions et les sites bloqués par stratégie ne peuvent pas être débogués.
- Quand une URL est saisie directement dans un nouvel onglet, les premiers scripts peuvent voir les vrais paramètres régionaux ; l’en-tête HTTP reste correct et la page peut être rechargée automatiquement une fois.
- Un seul paramètre régional Intl par processus de rendu ; des profils différents partageant un processus sont signalés comme « Partiel ».
- Les service workers et shared workers ne sont pas remplacés.

Plus de détails dans [docs/LIMITATIONS.md](../LIMITATIONS.md) et aide au dépannage dans [docs/TROUBLESHOOTING.md](../TROUBLESHOOTING.md) (en anglais).

## Licence

GPL-3.0, voir [LICENSE](../../LICENSE).
