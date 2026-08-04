---
title: Vue Activity
description: Classez les conversations des dossiers selon leur activité réelle afin de faire remonter le travail encore en cours.
---

# Activity : garder son attention sur les conversations en cours

Les dossiers répondent à une question : où ranger cette conversation ? À mesure que les archives grandissent, une autre question revient plus souvent : que faut-il regarder maintenant ?

Activity est une vue chronologique placée au-dessus des dossiers. Cliquez sur la cloche à droite de **Folders** pour remplacer temporairement l'arborescence par les conversations classées selon leur activité réelle. La structure des dossiers, l'appartenance des conversations et l'état Star ne changent pas.

**Inspiration du design :** cette vue s'inspire de la barre latérale de Codex / ChatGPT Desktop d'OpenAI. Voyager reprend l'idée de faire remonter les conversations encore actives, puis l'adapte en une vue chronologique au-dessus des dossiers Gemini.

<img src="/assets/activity-view.png" alt="Vue Activity dans la barre latérale de Gemini" style="display: block; width: 100%; max-width: 517px; margin: 24px auto; border-radius: 14px; box-shadow: 0 12px 32px rgba(0,0,0,0.12);"/>

## Priorité (Priority) suit l'activité récente

Priorité contient les conversations avec un nouveau tour au cours des **trois dernières heures**. La vue utilise l'heure réelle de la conversation, pas l'heure d'ouverture ou de consultation.

Une conversation placée dans Priorité n'apparaît pas aussi dans Aujourd’hui. À la fin de sa période d'activité de trois heures, Activity la replace automatiquement dans Aujourd’hui ou dans le groupe de date correspondant. Aucun rechargement n'est nécessaire.

Star reste disponible comme marqueur manuel indépendant. Ajouter une Star ne déplace pas une conversation dans Priorité, et la retirer ne fait pas sortir une conversation active de Priorité.

## Une fenêtre courte sur les derniers jours

Sous Priorité se trouvent Aujourd’hui (Today), Hier (Yesterday), puis les jours de la semaine précédents. Activity couvre aujourd'hui et les quatre jours calendaires précédents pour garder la liste proche du travail actuel.

Les conversations plus anciennes et les entrées sans heure d'activité n'apparaissent pas ici. Elles ne sont ni masquées ni supprimées. Cliquez de nouveau sur la cloche pour revenir à l'arborescence et les retrouver à leur emplacement d'origine.

## Une conversation, une seule ligne

Une conversation peut appartenir à plusieurs dossiers. Activity fusionne ces références en une ligne et conserve les noms des dossiers sous le titre. Survolez ces informations pour afficher les chemins complets.

Une même conversation ne prend ainsi pas plusieurs places dans Priorité ou Aujourd’hui, tout en conservant le contexte de ses projets.

## Trois signaux, trois usages

| Signal   | Source                                   | Question associée                               |
| -------- | ---------------------------------------- | ----------------------------------------------- |
| Dossiers | Projets et thèmes organisés manuellement | Où appartient cette conversation ?              |
| Activity | Heure du dernier échange réel            | Quels travaux ont avancé récemment ?            |
| Star     | Marqueur manuel                          | Quelles conversations doivent rester marquées ? |

Les dossiers servent à retrouver un élément dans les archives. Activity réduit le nombre de choix à refaire à chaque retour dans Gemini. Reprenez une conversation encore active dans Priorité, continuez avec Aujourd’hui ou Hier, puis revenez à l'arborescence complète lorsque vous avez besoin d'un contenu plus ancien.
