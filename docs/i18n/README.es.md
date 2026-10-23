# Locale Jacket

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · **Español** · [Русский](README.ru.md) · [Português (Brasil)](README.pt-BR.md)

> Este documento es una traducción del README en inglés. Si hay diferencias, prevalece la [versión en inglés](../../README.md), que también contiene los detalles técnicos y de desarrollo.

Locale Jacket es una extensión de Chrome / Edge (Manifest V3) que hace que los sitios vean **una configuración regional distinta según el sitio** (por ejemplo `en-US` en google.com y `ja-JP` en apple.com), mientras el idioma de la interfaz del navegador no cambia.

Automatiza lo que hace **Herramientas para desarrolladores ▸ Sensores ▸ Configuración regional** y lo aplica a cada pestaña que coincida, sin abrir las herramientas para desarrolladores. Las reglas funcionan como en Clash, sing-box o Shadowrocket: `DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`, `DOMAIN-REGEX`, `GEOSITE`, `IP-CIDR`, `IP-CIDR6`, `IP-ASN` y `GEOIP`, con excepciones `SYSTEM`/`DIRECT` y una acción predeterminada.

## Características

| Lo que ve el sitio | Cómo se suplanta | Alcance |
|---|---|---|
| `Intl.*` (DateTimeFormat, NumberFormat, Collator, `toLocaleString`…) | `Emulation.setLocaleOverride` | Página, marcos del mismo sitio y entre sitios, workers dedicados |
| `navigator.language`, `navigator.languages` | `Emulation.setUserAgentOverride` **solo** con `acceptLanguage` (User-Agent y client hints sin cambios) | Página, marcos, workers dedicados |
| Encabezado HTTP `Accept-Language` | La misma sustitución, más `declarativeNetRequest` para la primera solicitud del documento | Documentos, subrecursos, `fetch()`, solicitudes de workers |
| Zona horaria, geolocalización | **Desactivadas de forma predeterminada**, activables por regla | Página y marcos |

- No se modifica ninguna API de JavaScript de la página: solo se usa la emulación propia de Chrome.
- Todo se ejecuta localmente: sin servidor, cuenta ni telemetría.
- La interfaz está en 10 idiomas (ver abajo).

## Instalación

**Desde una release (recomendado)**
1. En la página *Releases* de GitHub, descarga `locale-jacket-<versión>.zip` y descomprímelo.
2. Abre `chrome://extensions` (Edge: `edge://extensions`), activa el **Modo de desarrollador**, haz clic en **Cargar descomprimida** y elige la carpeta descomprimida.
3. Fija la extensión: su insignia (por ejemplo `EN` o `JA`) muestra el perfil de la pestaña actual. Para las ventanas de incógnito, activa **Permitir en modo incógnito** en los detalles de la extensión.

**Actualizar:** para una carpeta descomprimida de la versión anterior, usa `locale-jacket-<anterior>-to-<nueva>.diff.zip`. Solo contiene los archivos añadidos o modificados: cópialos sobre la carpeta antigua, elimina los archivos listados en `DELETED.txt` (si existe) y recarga la extensión. El ID de la extensión y tus ajustes se conservan.

**Archivo `.crx`:** firmado con la misma clave (ID `jenefdmhnbfepiohiplfobageceacokb`), pero Chrome y Edge solo instalan `.crx` fuera de sus tiendas cuando una política empresarial lo permite. Para uso personal, usa **Cargar descomprimida**.

**Desde el código fuente:** requiere Node.js 20+. Ejecuta `npm install` y `npm run build`, y carga la carpeta `dist/` generada. Compatible con Chrome / Edge 125 o posterior (desarrollado y probado en 155).

**Reglas del primer inicio:** en una instalación nueva, la extensión lee `presets/default-rules.yaml` de su carpeta (mismo formato que *Importar / exportar*). Edita ese archivo antes de cargar la carpeta para empezar con tus propias reglas. El `.crx` no contiene este archivo y genera por sí mismo el mismo ajuste de ejemplo.

## Reglas predeterminadas

| Regla | Resultado |
|---|---|
| `DOMAIN-SUFFIX,google.com` | `en-US` |
| `DOMAIN-SUFFIX,openai.com` | `en-US` |
| `DOMAIN-SUFFIX,apple.com` | `ja-JP` |
| `DOMAIN-SUFFIX,yahoo.co.jp` | `ja-JP` |
| `DOMAIN,accounts.google.com` | `SYSTEM` (configuración real) |
| predeterminada | `SYSTEM` |

Puedes cambiarlas o eliminarlas libremente desde la ventana emergente o la página de opciones.

## Barra de depuración

Mientras haya una pestaña suplantada, Chrome muestra **«Locale Jacket ha empezado a depurar este navegador»**. Es el aviso de seguridad de Chrome para la API `chrome.debugger`; la extensión no lo oculta. Al pulsar **Cancelar**, Locale Jacket se pausa hasta que pulses **Reanudar** en la ventana emergente.

Si aceptas ese compromiso de seguridad, [`tools/chrome-banner-flag.ps1`](../../tools/chrome-banner-flag.ps1) (Windows) añade a Chrome la opción de inicio `--silent-debugger-extension-api`. Esto oculta el aviso para **todas** las extensiones con permiso de depuración. Detalles en el [README en inglés](../../README.md#hiding-the-debugging-banner-optional).

## Uso

**Ventana emergente** (icono de la barra de herramientas): interruptor general; regla, perfil y estado de la pestaña actual; «Comprobar lo que ve la página»; crear o cambiar la regla del sitio actual; acción predeterminada para el resto de sitios.

**Página de opciones:**
- **Reglas:** activar / desactivar, reordenar, editar, eliminar; se señalan duplicados, conflictos y reglas redundantes.
- **Probar y verificar:** escribe un nombre de host para ver qué reglas coinciden y por qué, o comprueba lo que informa realmente una pestaña abierta.
- **Importar / exportar:** JSON o YAML, sustituyendo o combinando.
- **Conjuntos de datos:** descarga, importación y actualización automática de los datos GeoSite / GeoIP / ASN.
- **Ajustes:** idioma de la interfaz, modo de marcos y más.
- **Sesiones y registro:** pestañas en depuración y registro de actividad en memoria.

## Reglas

```yaml
rules:
  - type: DOMAIN-SUFFIX        # google.com y todos sus subdominios (por etiquetas)
    domain: google.com
    locale: en-US
  - type: DOMAIN               # solo este nombre de host exacto
    domain: accounts.google.com
    action: SYSTEM             # mantener la configuración real (DIRECT es un alias)
  - type: DOMAIN-KEYWORD       # el nombre de host contiene el texto
    keyword: microsoft
    locale: en-GB
  - DOMAIN-SUFFIX,yahoo.co.jp,ja-JP   # también se acepta la forma corta de Clash
  - GEOSITE,google,en-US              # necesita el conjunto de datos GeoSite
  - IP-CIDR,17.0.0.0/8,en-US          # dirección del servidor en el rango
  - GEOIP,LAN,SYSTEM                  # direcciones privadas, sin datos
default:
  mode: SYSTEM                 # o: mode: PROFILE + locale/languages/…
```

**Precedencia** (determinista; decide la primera diferencia):
1. Tipo de regla: `DOMAIN` › `DOMAIN-SUFFIX` › `DOMAIN-KEYWORD` › `DOMAIN-REGEX` › `GEOSITE` › `IP-CIDR`/`IP-CIDR6` › `IP-ASN` › `GEOIP`. Las reglas de nombre de host siempre ganan a las reglas IP.
2. Dentro de un tipo gana la más específica (sufijo con más etiquetas, rango IP con el prefijo más largo).
3. Gana la `priority` más alta.
4. Gana la posición más temprana en la lista.
5. La acción predeterminada solo se aplica si nada coincide.

Por eso `DOMAIN,accounts.google.com → SYSTEM` siempre prevalece sobre `DOMAIN-SUFFIX,google.com → en-US`, sea cual sea el orden.

## Suscripciones de reglas

*Opciones ▸ Suscripciones* toma reglas de archivos JSON o YAML en internet (con el formato de *Importar / exportar*) y las mantiene al día: al añadirlas y después cada día (o cada semana, cada mes o nunca), con solicitudes condicionales. Los enlaces a la página de un archivo en GitHub (`github.com/…/blob/…`) o a un gist se convierten en el archivo sin procesar; una dirección que devuelve una página web se rechaza con una explicación. Las reglas de suscripción se guardan aparte de las tuyas y solo se muestran: orden: tus reglas, las de suscripción, tus reglas especiales (GEOSITE y reglas IP) y las especiales de las suscripciones; entre suscripciones gana la que está más arriba. De un archivo solo se lee `rules`; las entradas no válidas se omiten. Si las reglas de una suscripción necesitan GeoSite, GeoIP o ASN y falta ese conjunto de datos, se descarga automáticamente desde la dirección que indica el archivo en `datasets:` o, si no, desde la predeterminada.

## Conjuntos de datos y actualizaciones automáticas

Las reglas `GEOSITE`, `GEOIP` de país e `IP-ASN` necesitan archivos de datos. No se descarga nada salvo que lo pidas: en *Opciones ▸ Conjuntos de datos*, descárgalos desde una URL editable o importa un archivo local.

**Actualizaciones automáticas** (opcionales, desactivadas de forma predeterminada): comprobar los conjuntos de datos descargados al iniciar el navegador y/o cada día, semana o mes. Un **tiempo mínimo** (24 h de forma predeterminada, de 1 a 720 h) limita cada conjunto a un intento automático por periodo, incluidos los fallidos, para que reiniciar el navegador nunca provoque descargas repetidas. Las solicitudes son condicionales; un archivo sin cambios no se vuelve a descargar. Los archivos importados nunca se actualizan automáticamente.

Las reglas IP usan la dirección a la que Chrome se conectó realmente; la extensión no hace consultas DNS.

## Idioma de la interfaz

La ventana emergente y la página de opciones están en English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Русский y Português (Brasil). De forma predeterminada siguen el idioma del navegador; se cambia en *Opciones ▸ Ajustes ▸ Idioma de la interfaz*. Esto nunca cambia lo que ven los sitios.

## Actualizaciones

La versión instalada aparece junto al título de la ventana emergente y al pie de la barra lateral de opciones. *Opciones ▸ Actualizaciones* busca una versión más reciente: solo cuando haces clic en **Comprobar ahora** o activas las comprobaciones automáticas (desactivadas de forma predeterminada, como máximo una cada 12 horas), y solo en la dirección de publicación que se muestra. Si encuentra una versión nueva, la ventana emergente muestra un aviso y la página muestra las notas de la versión, los enlaces de descarga (paquete de diferencias, zip, crx) y los pasos para actualizar. Chrome nunca actualiza una carpeta descomprimida por sí mismo: copia los archivos nuevos sobre la carpeta y haz clic en **Recargar la extensión**. Mientras el repositorio de GitHub sea privado, GitHub responde 404; la página lo explica.

## Privacidad y permisos

Todo se ejecuta localmente. Aparte de las descargas de conjuntos de datos que inicies y de las actualizaciones automáticas que actives (siempre desde la URL mostrada), de las comprobaciones de actualizaciones que inicies o actives en *Actualizaciones* (solo a la dirección de publicación mostrada) y de las suscripciones que añadas en *Suscripciones* (a sus direcciones, más los conjuntos de datos que necesiten sus reglas), la extensión no hace solicitudes de red. Las reglas se guardan en `chrome.storage.local`; el registro de actividad solo está en memoria y solo contiene nombres de host.

Permisos: `debugger` (la propia emulación), `webNavigation` y acceso a sitios, `declarativeNetRequestWithHostAccess` (Accept-Language de la primera solicitud), `webRequest` (direcciones de servidor para reglas IP y si una carga de página puede reiniciarse sin riesgo; solo observación), `alarms` (comprobación programada de actualizaciones, solo si está activada), `storage`.

## Limitaciones

- La extensión no puede ocultar la barra de depuración (ver arriba).
- No se pueden depurar las páginas `chrome://` y `edge://`, la página Nueva pestaña, las tiendas de extensiones ni los sitios bloqueados por políticas.
- Al escribir una URL directamente en una pestaña nueva, los primeros scripts pueden ver la configuración real; el encabezado HTTP sigue siendo correcto y la página puede recargarse automáticamente una vez.
- Solo hay una configuración regional de Intl por proceso de renderizado; los perfiles distintos que comparten proceso aparecen como «Parcial».
- Los service workers y los shared workers no se sustituyen.

Más detalles en [docs/LIMITATIONS.md](../LIMITATIONS.md) y ayuda en [docs/TROUBLESHOOTING.md](../TROUBLESHOOTING.md) (en inglés).

## Licencia

GPL-3.0, ver [LICENSE](../../LICENSE).
