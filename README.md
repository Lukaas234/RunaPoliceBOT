# Run a Police Tickets

Bot de tickets de Discord y panel administrativo para el servidor Run a Police.

## Arquitectura

- **Una aplicación Node.js** ejecuta Discord.js, Express y el frontend estático para ajustarse al único deployment del plan Free.
- **SQLite local** persiste tickets, categorías, sesiones, auditoría, notas, valoraciones y transcripts. Usa WAL, sincronización completa y backups consistentes descargables e importables desde el panel.
- **Discord OAuth2** identifica al usuario; el backend valida que siga en el servidor y verifica sus roles actuales para cada petición.
- **Frontend estático propio** con CSS y JavaScript ligeros, sin segundo servidor ni bundler en producción.

Se eligió Express + TypeScript + Discord.js + better-sqlite3 + Zod. React, Vite, Prisma y Tailwind se dejaron fuera para reducir dependencias, memoria y pasos de build en el plan de 256 MB. Las bases de datos de Bot-Hosting se publican como deployments separados; el plan Free anuncia un solo slot. La durabilidad del archivo SQLite debe comprobarse en el hosting antes de usar datos reales. Las razones y el procedimiento están en [DEPLOYMENT.md](DEPLOYMENT.md).

## Funciones implementadas

- Paneles separados en inglés y español, con categorías configurables y actualización idempotente al iniciar el bot.
- Tickets privados con límite por usuario, roles globales y por categoría, numeración estable y canal dedicado.
- Cierre con motivo, responsable, transcript HTML comprimido, reapertura, prioridad, reclamo, transferencia, alta/baja de participantes y notas internas.
- Valoración de 1 a 5 estrellas con comentario.
- Comandos slash para operaciones principales.
- Panel con OAuth2, permisos diferenciados, dashboard, tickets filtrables, categorías, equipo con métricas, transcripts, estadísticas, auditoría, configuración y exportación SQLite.
- Logs en SQLite y canal configurable de Discord. Errores importantes también se registran.
- Tablero comunitario con `/community-create` y `/community-list`, embeds para tareas, errores, problemas y sugerencias, votos del staff, imágenes y cambios incluidos.
- Reenvío automático desde el foro comunitario al superar diez reacciones en el hilo. Se publican hasta ocho pendientes a la vez y las siguientes esperan en cola hasta que el propietario aprueba una.

## Funciones pendientes

- Cierre automático por inactividad y recordatorios.
- Exportación de estadísticas y más filtros/reportes de equipo.
- Confirmación real del hosting sobre persistencia, restauración y escritura segura de SQLite en el plan Free.
- Prueba de extremo a extremo en el servidor Discord real antes de usar tickets reales.

## Desarrollo local

1. Ejecuta `npm install`.
2. Copia `.env.example` a `.env` y completa los datos de Discord.
3. Habilita **Message Content Intent** en Discord Developer Portal para transcripts y medición de primera respuesta.
4. Ejecuta `npm run dev` para desarrollo o `npm run build && npm start` para modo producción.

Comprobación actual: `npm run build`, `npm test` y `node --check public/app.js`.
