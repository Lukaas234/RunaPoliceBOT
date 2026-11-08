# Run a Police Tickets — despliegue

## Arquitectura para Bot-Hosting.net Free

La aplicación compila el panel web como archivos estáticos y los sirve con Express dentro del mismo proceso Node.js que ejecuta Discord.js. SQLite guarda tickets, eventos, sesiones, categorías y transcripts. La arquitectura evita desplegar un servicio de base de datos separado.

La página pública vigente del hosting anuncia para Free 256 MB de RAM, 25% de CPU, 512 MB de almacenamiento, un deployment, backups cada hora conservados por 24 horas y renovación manual cada cuatro días. MySQL, PostgreSQL, MongoDB y Redis están disponibles como deployments separados y consumen recursos del mismo pool. Por ello un bot más una base de datos dedicada no cabe en el único slot gratuito publicado. Verifica el [plan Free](https://bot-hosting.net/) y la [página de bases de datos](https://bot-hosting.net/database-hosting) antes de desplegar; el producto del hosting puede cambiar.

**Condición de lanzamiento:** antes de usar datos reales, crea un deployment de prueba y confirma desde el panel que `DATABASE_PATH` está en almacenamiento persistente: crea un ticket de prueba, reinicia el deployment, verifica el ticket y restaura un backup. La información pública confirma backups de deployments, pero no describe con suficiente detalle las garantías de durabilidad de SQLite/WAL ni la restauración atómica del archivo. Si el archivo no sobrevive reinicios/restauración de manera consistente, no uses SQLite en ese almacenamiento. La alternativa es contratar un segundo slot/plan con base de datos propia o usar un PostgreSQL gestionado externo con backups comprobables.

El plan gratuito también requiere renovación manual cada cuatro días y mantiene solo 24 horas de puntos de backup. No es una garantía de continuidad o recuperación adecuada para información sensible a largo plazo. Exporta y guarda backups fuera del hosting en un lugar seguro.

## Requisitos

- Node.js 20.11 o posterior.
- Una aplicación de bot en el Discord Developer Portal.
- El bot invitado al servidor Run a Police con `Manage Channels`, `View Channels`, `Send Messages`, `Read Message History`, `Attach Files` y acceso a las categorías/canales que gestionará.
- Para el tablero comunitario, dale `View Channel` y `Read Message History` en el foro `1567353059670233211`, y `View Channel`, `Read Message History`, `Send Messages`, `Embed Links` y `Manage Messages` en el canal `1556538960140959825`.
- Habilita el intent privilegiado **Message Content** en el portal para incluir contenido de mensajes en los transcripts.
- El código solicita `Guild Message Reactions` para detectar votos; es un intent no privilegiado y no requiere otro interruptor en Developer Portal.
- Dominio HTTPS del hosting o subdominio HTTPS `*.apps.bot-hosting.cloud`.

## Despliegue

1. Crea un deployment Node.js desde el repositorio o sube el archivo del proyecto.
2. Usa una versión Node compatible con `engines` de `package.json`.
3. Configura las variables de entorno descritas abajo en el gestor de variables del panel. No subas `.env` ni secretos al repositorio.
4. Sube el paquete de despliegue incluyendo `dist/`. Define `npm start` como inicio. La raíz incluye `index.js`, el punto de entrada que espera el runtime Node.
5. Asigna un puerto HTTP público al deployment. El proceso escucha en `0.0.0.0` y usa `SERVER_PORT` del hosting; localmente acepta `PORT`.
6. Configura un subdominio HTTPS y copia su URL en `APP_BASE_URL` y el callback OAuth.
7. Configura el callback exacto `https://TU-SUBDOMINIO.apps.bot-hosting.cloud/auth/callback` en OAuth2 → Redirects.
8. Inicia el deployment. Al arrancar, el bot inicia sesión y sincroniza los comandos slash de Run a Police.
9. Ejecuta `/ticket-setup`, configura los dos grupos de canales desde Settings y publica `/ticket-panel` con `language: English` o `language: Español` si quieres actualizar cada panel manualmente. Al arrancar, el bot mantiene ambos paneles en sus canales configurados.
10. Comprueba persistencia, restore y backups antes de invitar usuarios a usar el sistema.

La app usa un proceso único; no requiere PM2, Docker, Nginx, SSH ni PostgreSQL local. Bot-Hosting anuncia deployments de Node.js, dominios HTTPS y panel de variables de entorno en sus [páginas de hosting](https://bot-hosting.net/website-hosting) y [bot hosting](https://bot-hosting.net/discord-bot-hosting).

Al cerrar un ticket, se guarda primero la transcripción y luego se elimina su canal de Discord. Los tickets cerrados se pueden reabrir desde el panel o con `/ticket-reopen` indicando el ID; se crea un canal nuevo. Los paneles son independientes: el inglés usa `1568743904868704296`, transcripciones `1568744200168808654` y logs `1568744253507764407`; el español usa `1569038030025523390`, transcripciones `1569038221986365511` y logs `1569038275346178168`. Configura ambos juegos desde **Settings**; el idioma queda guardado en cada ticket y determina los mensajes, categoría, transcripción y canal de logs.

El bot necesita permiso para ver y enviar mensajes en ambos juegos de canales; para adjuntar transcripciones también necesita **Attach Files**. El transcript publicado en Discord lleva un embed con resumen y un HTML comprimido para que Discord no exponga el código fuente en el mensaje. Desde el panel web el transcript HTML se descarga directamente.

El foro de propuestas es `1567353059670233211`; el destino del tablero comunitario es `1556538960140959825`. El bot cuenta todas las reacciones en los mensajes del hilo y reenvía la publicación cuando supera diez. También revisa los hilos activos al iniciar. `/community-create` publica tareas, errores, problemas o sugerencias manualmente y `/community-list` muestra los pendientes. Se muestran como máximo ocho publicaciones pendientes a la vez; las siguientes quedan en cola FIFO y se publican cuando se aprueba una visible. Las publicaciones aprobadas se conservan como historial. Solo el staff puede votar en el tablero y solo el propietario con ID `745348794446643260` puede marcar una publicación como aprobada y terminada.

## Variables de entorno

| Variable | Uso |
|---|---|
| `NODE_ENV` | `production` en hosting público; activa cookies Secure. |
| `SERVER_PORT` | Puerto HTTP asignado por Bot-Hosting. |
| `PORT` | Puerto de fallback para ejecución local. |
| `HOST` | Debe ser `0.0.0.0` en el contenedor. |
| `DATABASE_PATH` | Ruta persistente elegida, por ejemplo `./data/run-a-police.sqlite`. Confirma la durabilidad de esta ruta con la prueba de arriba. |
| `DISCORD_TOKEN` | Token secreto del bot. |
| `DISCORD_CLIENT_ID` | ID de la aplicación de Discord. |
| `DISCORD_CLIENT_SECRET` | Secreto OAuth2. |
| `DISCORD_REDIRECT_URI` | URL HTTPS exacta del callback `/auth/callback`. |
| `DISCORD_GUILD_ID` | ID del único servidor Run a Police. |
| `SESSION_SECRET` | Secreto aleatorio de al menos 32 caracteres. |
| `APP_BASE_URL` | URL HTTPS pública del panel. |
| `BOOTSTRAP_ADMIN_ROLE_IDS` | IDs de roles iniciales de administración, separados por coma. Permite entrar por primera vez al panel. |

Usa `.env.example` como referencia local. El bot debe tener acceso al servidor y OAuth2 debe configurarse con el mismo Client ID y Secret.

## Persistencia, backups y recuperación

- SQLite usa WAL y claves foráneas; el cierre ordenado hace checkpoint WAL.
- Los transcripts HTML se guardan comprimidos en SQLite y el panel los descomprime al descargarlos. Por límites de RAM/CPU, cada transcript incluye como máximo los 2.000 mensajes más recientes; si el canal tiene más, el archivo lo indica.
- Un administrador puede descargar una copia consistente desde **Settings → Download backup** o `GET /api/backup`, e importar un archivo `.sqlite` compatible desde **Settings → Database backup** o `PUT /api/backup`.
- Importar reemplaza tickets, ajustes, notas, transcripts, votos, calificaciones y registros del archivo actual. Las sesiones web activas se conservan.
- El archivo SQLite se mantiene en `DATABASE_PATH` (por defecto `./data/run-a-police.sqlite`). La consola indica la ruta efectiva al iniciar; configura esa carpeta como almacenamiento persistente del hosting. El ZIP de despliegue no contiene la base de datos, así que conserva el directorio `data` al actualizar archivos.
- El deployment del hosting ofrece backups de archivos cada hora con 24 horas de historial en Free. Conserva además una exportación periódica fuera de la cuenta y prueba restaurarla.
- Para exportación manual segura, detén el proceso o usa una herramienta SQLite que haga backup consistente e incluye el archivo principal y estado WAL. No copies únicamente el `.sqlite` mientras el proceso escribe.
- Si SQLite reporta corrupción, detén el deployment, restaura un punto consistente y verifica integridad antes de reabrir tickets.
- Vigila uso de RAM, CPU y almacenamiento. Si el uso se acerca al límite, reduzca la retención de transcripts o sube de plan; no borres la base activa para liberar espacio.

## Actualizaciones y solución de problemas

- Actualiza el repositorio, conserva las variables de entorno y ejecuta un backup verificable antes de reiniciar.
- Si el proceso no inicia, revisa consola por configuración inválida, token Discord, intent Message Content o fallo de compilación de `better-sqlite3`.
- Si OAuth vuelve al login, verifica `DISCORD_REDIRECT_URI`, HTTPS, Client ID/Secret y que el usuario tenga un rol autorizado.
- Si los transcripts no incluyen texto, habilita Message Content Intent y reinicia el bot.
- Si no se crean canales, revisa jerarquía de roles y permisos Manage Channels/View Channel del bot.
- El Free necesita renovación manual cada cuatro días; configura un recordatorio en el propio panel del hosting.

## Límites de esta primera entrega

La app corre como un proceso y expone el bot y el panel en el mismo deployment. Un fallo total del proceso afecta ambos componentes; el reinicio automático del hosting ayuda a recuperarlo, pero no los aísla. Valora disponibilidad y copias externas de acuerdo con el uso real. Esta primera entrega ya incluye primera respuesta basada en el primer mensaje del staff, tiempo de resolución, transferencias desde el panel, valoraciones y backup descargable. El cierre automático por inactividad, exportaciones de estadísticas y recordatorios aún no están implementados.
