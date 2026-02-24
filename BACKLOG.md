# Backlog

Ideas de features para implementar en el futuro.

> **Nota:** Los bugs se gestionan en [GitHub Issues](../../issues), no en este archivo.

---

## Features

### [ ] Publicidad con Google AdSense

**Prioridad:** Baja
**Complejidad:** Fácil (solo cliente)

### Descripción
Mostrar un banner publicitario de Google AdSense en la parte inferior de la pantalla durante las fases de espera del juego. El anuncio se oculta automáticamente durante el turno activo para no distraer a los jugadores.

### Pantallas afectadas

| Pantalla | ¿Muestra anuncio? |
|----------|-------------------|
| `#screen-home` | ✓ Sí |
| `#screen-lobby` | ✓ Sí |
| `#screen-waiting-describer` | ✓ Sí |
| `#screen-turn-describer` | ✗ No (turno activo) |
| `#screen-turn-observer` | ✗ No (turno activo) |
| `#screen-turn-ended` | ✓ Sí |
| `#screen-game-over` | ✓ Sí |

### Implementación técnica

- **Formato:** Anuncio responsive de AdSense (adapta tamaño automáticamente)
- **Posición:** Fixed en la parte inferior de la pantalla
- **Comportamiento:** Se muestra/oculta según la pantalla activa via CSS
- **No requiere cambios en el servidor** — 100% client-side

### Código propuesto

**HTML:**
```html
<!-- Al final del body, antes de los scripts -->
<div id="ad-container" class="ad-container">
  <ins class="adsbygoogle" ... ></ins>
</div>
```

**CSS:**
```css
.ad-container {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  text-align: center;
  background: var(--surface);
  padding: 0.25rem;
  z-index: 100;
}
/* Ocultar durante turno activo */
.screen-turn-active .ad-container { display: none; }
```

### Requisitos previos

1. Crear cuenta de AdSense: https://adsense.google.com
2. Verificar propiedad del sitio en AdSense con el dominio de Render
3. Obtener el código del anuncio

### Notas

- AdSense requiere que el sitio esté en producción con un dominio real
- La aprobación puede tardar 1-2 días
- Los anuncios no se mostrarán hasta que AdSense apruebe el sitio

---
