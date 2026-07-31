# Guía de Contribución

> [!CAUTION]
> **Este proyecto actualmente NO acepta PRs para nuevas funcionalidades.** Si tienes una funcionalidad que realmente te gustaría desarrollar, sigue este proceso:
>
> 1. **Abre un Issue primero** para discutir tu idea y enfoque con el mantenedor
> 2. **Espera la aprobación y un plan de implementación sólido** antes de escribir código o enviar un PR
>
> Los PRs de nuevas funcionalidades enviados sin discusión previa serán cerrados sin revisión. Gracias por tu comprensión.

> [!IMPORTANT]
> **Estado del proyecto: Mantenimiento bajo.** Espere retrasos en las respuestas. Se priorizan los PR con pruebas.

¡Gracias por considerar contribuir a Voyager! 🚀

Este documento proporciona pautas e instrucciones para contribuir. Damos la bienvenida a correcciones de errores, mejoras en la documentación y traducciones. Para nuevas funcionalidades, por favor discútelo primero mediante un Issue.

## 🚫 Política de IA

**Rechazamos explícitamente los PR generados por IA que no hayan sido verificados manualmente.**

Aunque las herramientas de IA son grandes asistentes, las contribuciones de "copiar y pegar" sin revisión hacen perder tiempo a los mantenedores.

- **Los PR de IA de baja calidad** se cerrarán inmediatamente sin discusión.
- **Los PR sin explicación** de la lógica o que carezcan de las pruebas necesarias serán rechazados.
- Debes entender y asumir la responsabilidad de cada línea de código que envíes.

## Flujo Obligatorio

1. Para una nueva funcionalidad, abre un Issue y espera la aprobación explícita del enfoque; `/claim` o una asignación solo selecciona a la persona responsable.
2. Envía cada cambio mediante una PR enfocada desde una rama temática; no envíes directamente a `main`.
3. Ejecuta `bun run format`, `bun run lint` y `bun run verify:pr`, en ese orden, e indica cualquier omisión. Para cambios solo de documentación (docs/README), `bun run format:check` más `bun run docs:build` pueden sustituir al `verify:pr` completo.
4. Añade pruebas de regresión para cambios de comportamiento o explica por qué la automatización no es útil.
5. Carga el artefacto real en los navegadores afectados y prueba el flujo modificado; indica en la PR la cobertura pendiente y su responsable.

> 💡 Si contribuyes con un agente de IA (Claude Code, Codex, …), pídele que use la skill `voyager-contribute` incluida en el repositorio (en `.claude/skills/` y `.agents/skills/`): codifica este flujo y las trampas específicas del repositorio que más rondas de revisión han costado. Los agentes fuera del checkout del repositorio (p. ej. Cursor) pueden instalarla con `npx skills add Nagi-ovo/voyager -s voyager-contribute`.

## Tabla de Contenidos

- [Comenzando](#comenzando)
- [Reclamar un Problema](#reclamar-un-problema)
- [Configuración de Desarrollo](#configuración-de-desarrollo)
- [Realizando Cambios](#realizando-cambios)
- [Enviar un Pull Request](#enviar-un-pull-request)
- [Estilo de Código](#estilo-de-código)
- [Agregar Soporte para Gem](#agregar-soporte-para-gem)
- [Licencia](#licencia)

---

## Comenzando

### Requisitos Previos

- **Bun 1.3.12** (coincide con `packageManager` y CI)
- **GitHub CLI (`gh`)** ([instalación](https://cli.github.com/)): instálalo y autentícate con `gh auth login`, luego ejecuta `gh auth status` para confirmar que la cuenta activa es la que quieres usar para contribuir; la skill `voyager-contribute` lo usa para consultar y publicar Issues/PRs. Sin `gh`, usa la interfaz web de GitHub e indícalo en la PR.
- Los navegadores afectados para cargar la extensión y probar el flujo real

### Inicio Rápido

```bash
# Clonar el repositorio
git clone https://github.com/Nagi-ovo/voyager.git
cd voyager

# Instalar dependencias
bun install

# Iniciar modo de desarrollo
bun run dev
```

---

## Reclamar un Problema

Para evitar trabajo duplicado y coordinar contribuciones:

### 1. Verificar Trabajo Existente

Antes de comenzar, verifica si el problema ya está asignado a alguien mirando la sección **Assignees**.

### 2. Reclamar un Problema

En un problema no asignado **sin** la etiqueta `community-only`, comenta `/claim` para asignártelo automáticamente. Un bot confirmará la asignación.

### 3. Problemas exclusivos de la comunidad

Los problemas con la etiqueta `community-only` están reservados para miembros verificados de la comunidad Voyager:

1. El miembro de la comunidad comenta `/claim`.
2. Un mantenedor verifica su membresía y comenta `/approve @usuario`.
3. Empieza la implementación o abre un PR solo después de que el bot asigne el problema.

La etiqueta elimina automáticamente `help wanted` y `good first issue`. Otros colaboradores pueden unirse al [Discord de Voyager](https://discord.gg/TEUFxdMbGb) o elegir un problema sin `community-only`.

### 4. Liberar si es Necesario

Si ya no puedes trabajar en un problema, comenta `/unclaim` para liberarlo para otros.

### 5. Casilla de Verificación de Contribución

Al crear problemas, puedes marcar la casilla "I am willing to contribute code" para indicar tu interés en implementar la funcionalidad o corrección.

---

## Configuración de Desarrollo

### Instalar Dependencias

```bash
bun install
```

### Comandos Disponibles

| Comando               | Descripción                                           |
| --------------------- | ----------------------------------------------------- |
| `bun run dev`         | Iniciar modo desarrollo Chrome con recarga automática |
| `bun run dev:firefox` | Iniciar modo desarrollo Firefox                       |
| `bun run dev:safari`  | Iniciar modo desarrollo Safari (solo macOS)           |
| `bun run build`       | Compilación de producción para Chrome                 |
| `bun run build:edge`  | Compilación y paquete independientes para Edge        |
| `bun run build:all`   | Compilación para Chrome + Firefox + Safari            |
| `bun run lint`        | Ejecutar ESLint con corrección automática             |
| `bun run typecheck`   | Ejecutar comprobación de tipos TypeScript             |
| `bun run test`        | Ejecutar conjunto de pruebas                          |
| `bun run verify:pr`   | Verificación automática local estándar de una PR      |

### Cargar la Extensión

1. Ejecuta `bun run dev` para iniciar la compilación de desarrollo
2. Abre Chrome y ve a `chrome://extensions/`
3. Habilita el "Modo de desarrollador"
4. Haz clic en "Cargar descomprimida" y selecciona la carpeta `dist_chrome_dev`

---

## Realizando Cambios

### Antes de Empezar

1. **Crea una rama** desde `main`:

   ```bash
   git checkout -b feature/nombre-de-tu-funcionalidad
   # o
   git checkout -b fix/tu-correccion-de-error
   ```

2. **Vincular Issues** - Al implementar una nueva funcionalidad, **primero debes abrir un Issue de discusión**. Los PR de nuevas funcionalidades enviados sin discusión previa serán cerrados. Al enviar un PR, por favor enlaza ese Issue.
3. **Mantén los cambios enfocados** - una funcionalidad o corrección por PR

### Lista de Verificación Pre-Commit

Antes de enviar, ejecuta siempre:

```bash
bun run format     # Formatear código
bun run lint       # Corregir problemas de linting
bun run verify:pr  # Ejecutar la verificación local estándar
```

Asegúrate de que:

1. Tus cambios logran la funcionalidad deseada.
2. Tus cambios no afectan negativamente a las funciones existentes.

---

## Estrategia de Pruebas

Prueba la interfaz con mayor riesgo de regresión: automatiza la lógica y el estado complejo, añade una prueba DOM mínima cuando cambien selectores o navegación SPA, y verifica el flujo real cargando la extensión.

---

## Enviar un Pull Request

### Pautas de PR

1. **Título**: Usa un título claro y descriptivo (ej: "feat: add dark mode toggle" o "fix: timeline scroll sync")
2. **Descripción**: Explica qué cambios hiciste y por qué
3. **Impacto en el Usuario**: Describe cómo se verán afectados los usuarios
4. **Prueba Visual (Estricto)**: Para CUALQUIER cambio de UI o nueva funcionalidad, **DEBES** proporcionar capturas de pantalla o grabaciones. **Sin captura = Sin revisión/respuesta.**
5. **Referencia de Problema**: Enlaza problemas relacionados (ej: "Closes #123")

### Formato de Mensaje de Commit

Sigue [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - Nuevas funcionalidades
- `fix:` - Corrección de errores
- `docs:` - Cambios en documentación
- `chore:` - Tareas de mantenimiento
- `refactor:` - Refactorización de código
- `test:` - Agregar o actualizar pruebas

---

## Estilo de Código

### Pautas Generales

- **Prefiere retornos tempranos** sobre condicionales anidados
- **Usa nombres descriptivos** - evita abreviaciones
- **Evita números mágicos** - usa constantes con nombre
- **Sigue el estilo existente** - consistencia sobre preferencia

### Convenciones TypeScript

- **PascalCase**: Clases, interfaces, tipos, enums, componentes React
- **camelCase**: Funciones, variables, métodos
- **UPPER_SNAKE_CASE**: Constantes

### Orden de Importación

1. React e importaciones relacionadas
2. Bibliotecas de terceros
3. Importaciones absolutas internas (`@/...`)
4. Importaciones relativas (`./...`)
5. Importaciones solo de tipo

```typescript
import React, { useState } from 'react';

import { marked } from 'marked';

import { Button } from '@/components/ui/Button';
import { StorageService } from '@/core/services/StorageService';
import type { FolderData } from '@/core/types/folder';

import { parseData } from './parser';
```

---

## Agregar Soporte para Gem

Para agregar soporte para un nuevo Gem (Gems oficiales de Google o Gems personalizados):

1. Abre `src/pages/content/folder/gemConfig.ts`
2. Agrega una nueva entrada al array `GEM_CONFIG`:

```typescript
{
  id: 'your-gem-id',           // De la URL: /gem/your-gem-id/...
  name: 'Your Gem Name',       // Nombre para mostrar
  icon: 'material_icon_name',  // Icono de Google Material Symbols
}
```

### Encontrar el ID del Gem

- Abre una conversación con el Gem
- Verifica la URL: `https://gemini.google.com/app/gem/[GEM_ID]/...`
- Usa la parte `[GEM_ID]` en tu configuración

### Elegir un Icono

Usa nombres de iconos válidos de [Google Material Symbols](https://fonts.google.com/icons):

| Icono          | Caso de Uso            |
| -------------- | ---------------------- |
| `auto_stories` | Aprendizaje, Educación |
| `lightbulb`    | Ideas, Lluvia de ideas |
| `work`         | Carrera, Profesional   |
| `code`         | Programación, Técnica  |
| `analytics`    | Datos, Análisis        |

---

## Alcance del Proyecto

Voyager mejora la experiencia de chat de Gemini AI con:

- Navegación por línea de tiempo
- Organización de carpetas
- Bóveda de prompts
- Exportación de chat
- Personalización de UI

> [!NOTE]
> **Consideramos que el conjunto de funcionalidades de Voyager ya es completo y suficiente.** Añadir demasiadas funciones especializadas o excesivamente personalizadas no mejora el software, solo aumenta la carga de mantenimiento. A menos que consideres que una función es verdaderamente esencial y beneficiaría a la mayoría de los usuarios, te pedimos que reconsideres enviar un Feature Request.

**Fuera de alcance**: Scraping de sitios, intercepción de red, automatización de cuentas.

---

## Obtener Ayuda

- 💬 [GitHub Discussions](https://github.com/Nagi-ovo/voyager/discussions) - Haz preguntas
- 🐛 [Issues](https://github.com/Nagi-ovo/voyager/issues) - Reporta errores
- 📖 [Documentación](https://voyager.nagi.fun/) - Lee la documentación

---

## Licencia

Al contribuir, aceptas que tus contribuciones se licenciarán bajo la [Licencia GPLv3](../LICENSE).
