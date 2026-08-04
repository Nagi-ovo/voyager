---
title: Vista Activity
description: Ordena las conversaciones de las carpetas por actividad real para mostrar primero el trabajo que sigue en marcha.
---

# Activity: mantén la atención en las conversaciones activas

Las carpetas responden a una pregunta: ¿dónde pertenece esta conversación? A medida que crece el archivo, aparece otra con más frecuencia: ¿qué conviene mirar ahora?

Activity es una vista temporal sobre las carpetas. Haz clic en la campana a la derecha de **Folders** para sustituir el árbol por conversaciones ordenadas según la actividad real. No cambia la estructura de las carpetas, la ubicación de las conversaciones ni el estado de Star.

**Inspiración del diseño:** esta vista se inspira en la barra lateral de Codex / ChatGPT Desktop de OpenAI. Voyager retoma la idea de mostrar primero las conversaciones que siguen activas y la adapta a una vista temporal sobre las carpetas de Gemini.

<img src="/assets/activity-view.png" alt="Vista Activity en la barra lateral de Gemini" style="display: block; width: 100%; max-width: 517px; margin: 24px auto; border-radius: 14px; box-shadow: 0 12px 32px rgba(0,0,0,0.12);"/>

## Prioridad (Priority) sigue la actividad reciente

Prioridad contiene conversaciones con un turno nuevo durante las últimas **tres horas**. Usa la hora real de la conversación, no la hora en la que se abrió o consultó el chat.

Una conversación que está en Prioridad no aparece también en Hoy. Cuando termina su periodo activo de tres horas, Activity la devuelve automáticamente a Hoy o al grupo de fecha correspondiente. No hace falta recargar la página.

Star sigue disponible como una marca manual independiente. Añadir una Star no mueve la conversación a Prioridad, y quitarla no saca una conversación activa de Prioridad.

## Una ventana corta de los últimos días

Debajo de Prioridad aparecen Hoy (Today), Ayer (Yesterday) y los días de la semana anteriores. Activity cubre hoy y los cuatro días naturales previos para mantener la lista cerca del trabajo actual.

Las conversaciones más antiguas y los registros sin hora de actividad no aparecen aquí. No se ocultan ni se eliminan. Vuelve a pulsar la campana para regresar al árbol de carpetas y encontrarlos en su ubicación original.

## Una conversación, una fila

Una conversación puede pertenecer a varias carpetas. Activity combina esas referencias en una fila y conserva los nombres de las carpetas debajo del título. Pasa el cursor sobre esa información para ver las rutas completas.

Así, una misma conversación no ocupa varios lugares en Prioridad o Hoy y mantiene el contexto de sus proyectos.

## Tres señales con funciones distintas

| Señal    | Origen                                    | Pregunta que responde                      |
| -------- | ----------------------------------------- | ------------------------------------------ |
| Carpetas | Proyectos y temas organizados manualmente | ¿Dónde pertenece esta conversación?        |
| Activity | Hora del último turno real                | ¿Qué trabajo ha avanzado recientemente?    |
| Star     | Marca manual                              | ¿Qué conversaciones deben seguir marcadas? |

Las carpetas ayudan a recuperar algo del archivo. Activity reduce las opciones que hay que volver a valorar cada vez que regresas a Gemini. Empieza por una conversación que aún tenga continuidad en Prioridad, sigue con Hoy o Ayer y vuelve al árbol completo cuando necesites material más antiguo.
