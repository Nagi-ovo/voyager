# Política de Privacidad

Última actualización: 7 de septiembre de 2026

## Introducción

Voyager (en adelante "nosotros") se compromete a proteger su privacidad. Esta política de privacidad explica cómo nuestra extensión de navegador recopila, utiliza y protege su información.

## Recopilación y Uso de Datos

**No recopilamos ninguna información personal.**

Voyager se ejecuta completamente en local en su navegador. Todos los datos generados o gestionados por la extensión (como carpetas, plantillas de prompts, mensajes favoritos y configuraciones) se almacenan en:

1. Su dispositivo local (`chrome.storage.local`)
2. El almacenamiento sincronizado de su navegador (`chrome.storage.sync`, si está disponible), para sincronizar configuraciones entre sus dispositivos.

No tenemos acceso a sus datos personales, historial de chat ni ninguna otra información privada. Tampoco rastreamos su historial de navegación.

## Sincronización con Google Drive (Opcional)

Si activa la sincronización con Google Drive, Chrome, Edge y Firefox usan la API de identidad del navegador; la aplicación directa de Safari usa Google Sign-In nativo y guarda las credenciales en el Llavero de macOS. Ambas rutas solicitan únicamente el scope limitado `drive.file` y transfieren los datos directamente entre su dispositivo y **su propio Google Drive**. Los tokens OAuth no se envían a ningún servidor de Voyager.

## Actualizaciones en línea del catálogo de complementos (opcional)

En un sitio donde haya activado al menos un complemento, Voyager puede solicitar por HTTPS el archivo de catálogo de ese sitio en `https://voyager.nagi.fun/catalog/hosts/<host del sitio>.json`, por ejemplo `https://voyager.nagi.fun/catalog/hosts/chat.deepseek.com.json`. La comprobación se realiza al abrir una página de ese tipo o al abrir la ventana de la extensión en ella, y solo si la última comprobación es más antigua que el intervalo que usted haya elegido (6 horas de forma predeterminada; 1 hora, 6 horas, 24 horas o solo manual). Las páginas de Gemini y AI Studio no tienen complementos, por lo que nunca generan una solicitud. La solicitud es un GET normal que no envía cookies, ni identificadores de cuenta o de la extensión, ni contenido de la página o de la conversación; como en cualquier solicitud web, el servidor ve la dirección IP que la origina y el user agent del navegador, además del nombre de host del sitio en la ruta de la URL. En los sitios con complementos, la ventana de la extensión ofrece un interruptor de «Actualizaciones en línea de complementos» y el selector de intervalo; ambos ajustes se guardan en el almacenamiento sincronizado del navegador y se incluyen en la copia de seguridad de la configuración. Con el interruptor desactivado, Voyager no se conecta a voyager.nagi.fun salvo que usted pulse «Buscar actualizaciones de complementos ahora». Si la solicitud falla o el sitio no tiene archivo de catálogo, se sigue usando la instantánea de complementos incluida en la extensión. Un catálogo descargado contiene únicamente CSS y JSON, que se validan y se depuran antes de usarse; nunca se descarga ni se ejecuta JavaScript.

## Permisos

Esta extensión solo solicita los permisos mínimos necesarios para funcionar:

- **Storage (Almacenamiento)**: Para guardar sus preferencias, carpetas, prompts, mensajes favoritos y opciones de personalización de la interfaz localmente y entre dispositivos.
- **Identity (Identidad)**: Para la autenticación de Google de la función opcional de sincronización con Google Drive. Solo se usa cuando activa explícitamente la sincronización en la nube.
- **Scripting (Scripts)**: Para inyectar dinámicamente scripts de contenido en las páginas de Gemini y en sitios web personalizados especificados por el usuario para la función Gestor de Prompts. Solo se inyectan scripts incluidos en la propia extensión — no se descarga ni ejecuta código remoto.
- **Host Permissions (Permisos de host)** (gemini.google.com, aistudio.google.com, etc.): Para inyectar scripts de contenido que mejoran la interfaz de Gemini con funciones como carpetas, exportación, línea de tiempo y cita de respuesta. Los dominios adicionales de Google (googleapis.com, accounts.google.com) son necesarios para la autenticación de la sincronización con Google Drive.
- **Optional Host Permissions (Permisos de host opcionales)** (todas las URL): Solo se solicitan en tiempo de ejecución cuando usted añade explícitamente sitios web personalizados para el Gestor de Prompts. Nunca se activan sin su acción.

## Servicios de Terceros

Voyager no comparte datos con ningún servicio de terceros, anunciantes o proveedores de análisis.

## Cambios en la Política

Podemos actualizar nuestra política de privacidad de vez en cuando. Le notificaremos cualquier cambio publicando la nueva política de privacidad en esta página.

## Contáctenos

Si tiene alguna pregunta sobre esta política de privacidad, contáctenos a través de nuestro [repositorio de GitHub](https://github.com/Nagi-ovo/voyager).
