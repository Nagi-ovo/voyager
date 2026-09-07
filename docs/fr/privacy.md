# Politique de Confidentialité

Dernière mise à jour : 7 septembre 2026

## Introduction

Voyager ("nous", "notre", ou "nos") s'engage à protéger votre vie privée. Cette Politique de Confidentialité explique comment notre extension de navigateur collecte, utilise et protège vos informations.

## Collecte et Utilisation des Données

**Nous ne collectons aucune information personnelle.**

Voyager fonctionne entièrement dans votre navigateur. Toutes les données générées ou gérées par l'extension (comme les dossiers, les modèles de prompts, les messages favoris et les paramètres) sont stockées :

1. Localement sur votre appareil (`chrome.storage.local`)
2. Dans le stockage synchronisé de votre navigateur (`chrome.storage.sync`) s'il est disponible, pour synchroniser les paramètres entre vos appareils.

Nous n'avons accès à aucune de vos données personnelles, historiques de chat ou autres informations privées. Nous ne suivons pas votre historique de navigation.

## Synchronisation Google Drive (Optionnelle)

Si vous activez la synchronisation Google Drive, Chrome, Edge et Firefox utilisent l'API d'identité du navigateur ; l'application Safari distribuée directement utilise Google Sign-In natif et conserve les identifiants dans le Trousseau macOS. Les deux méthodes demandent uniquement le scope limité `drive.file` et transfèrent les données directement entre votre appareil et **votre propre Google Drive**. Les jetons OAuth ne sont envoyés à aucun serveur Voyager.

## Mises à jour en ligne du catalogue d'extensions (optionnel)

Sur un site où vous avez activé au moins une extension, Voyager peut récupérer en HTTPS le fichier de catalogue de ce site à l'adresse `https://voyager.nagi.fun/catalog/hosts/<hôte du site>.json`, par exemple `https://voyager.nagi.fun/catalog/hosts/chat.deepseek.com.json`. La vérification a lieu uniquement à l'ouverture d'une telle page ou à l'ouverture de la fenêtre de l'extension sur cette page, et seulement si la dernière vérification est plus ancienne que l'intervalle que vous avez choisi (6 heures par défaut ; 1 heure, 6 heures, 24 heures ou manuel uniquement). Les pages Gemini et AI Studio n'ont pas d'extensions et ne déclenchent donc aucune requête. La requête est un simple GET qui ne transmet ni cookies, ni identifiant de compte ou d'extension, ni contenu de page ou de conversation ; comme pour toute requête web, le serveur voit l'adresse IP à l'origine de la requête et le user agent du navigateur, ainsi que le nom d'hôte du site dans le chemin de l'URL. Sur les sites concernés, la fenêtre de l'extension propose un interrupteur « Mises à jour en ligne des extensions » et le sélecteur d'intervalle ; les deux réglages sont enregistrés dans le stockage synchronisé du navigateur et inclus dans la sauvegarde des paramètres. Interrupteur désactivé, Voyager ne contacte voyager.nagi.fun que si vous appuyez sur « Rechercher les mises à jour d'extensions maintenant ». Si la requête échoue ou si le site n'a pas de fichier de catalogue, l'instantané d'extensions livré avec le module reste utilisé. Un catalogue récupéré ne contient que du CSS et du JSON, validés et assainis avant utilisation ; aucun JavaScript n'est téléchargé ni exécuté.

## Permissions

L'extension demande le minimum de permissions nécessaires pour fonctionner :

- **Storage (Stockage)** : Pour enregistrer vos préférences, dossiers, prompts, messages favoris et options de personnalisation de l'interface localement et entre vos appareils.
- **Identity (Identité)** : Pour l'authentification Google de la fonction optionnelle de synchronisation Google Drive. Utilisé uniquement lorsque vous activez explicitement la synchronisation cloud.
- **Scripting (Scripts)** : Pour injecter dynamiquement des scripts de contenu sur les pages Gemini et sur les sites web personnalisés spécifiés par l'utilisateur pour la fonction Gestionnaire de Prompts. Seuls les scripts intégrés à l'extension sont injectés — aucun code distant n'est récupéré ou exécuté.
- **Host Permissions (Permissions d'hôte)** (gemini.google.com, aistudio.google.com, etc.) : Pour injecter des scripts de contenu qui améliorent l'interface Gemini avec des fonctionnalités comme les dossiers, l'exportation, la timeline et la citation de réponse. Les domaines Google supplémentaires (googleapis.com, accounts.google.com) sont nécessaires pour l'authentification de la synchronisation Google Drive.
- **Optional Host Permissions (Permissions d'hôte optionnelles)** (toutes les URL) : Demandées uniquement au moment de l'exécution lorsque vous ajoutez explicitement des sites web personnalisés pour le Gestionnaire de Prompts. Jamais activées sans votre action.

## Services Tiers

Voyager ne partage aucune donnée avec des services tiers, des annonceurs ou des fournisseurs d'analyse.

## Modifications de cette Politique

Nous pouvons mettre à jour notre Politique de Confidentialité de temps à autre. Nous vous informerons de tout changement en publiant la nouvelle Politique de Confidentialité sur cette page.

## Nous Contacter

Si vous avez des questions concernant cette Politique de Confidentialité, veuillez nous contacter via notre [Dépôt GitHub](https://github.com/Nagi-ovo/voyager).
