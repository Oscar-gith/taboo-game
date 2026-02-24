# Bug Management

Gestionar bugs del proyecto Taboo usando GitHub Issues.

## Uso

```
/bug                    # Listar bugs pendientes
/bug report <desc>      # Reportar un nuevo bug
/bug fix <número>       # Resolver un bug específico
```

---

## Modo: Listar Bugs (sin argumentos)

Si el usuario ejecuta `/bug` sin argumentos:

1. Ejecutar `gh issue list --label bug --state open`
2. Mostrar lista formateada de bugs pendientes
3. Si no hay bugs: "No hay bugs abiertos en GitHub Issues."

---

## Modo: Reportar Bug (`/bug report`)

Cuando el usuario reporta un bug:

### Step 1: Recopilar información
Preguntar al usuario (si no proporcionó detalles):
- **¿Qué pasó?** (comportamiento observado)
- **¿Qué debería pasar?** (comportamiento esperado)
- **¿Cómo reproducirlo?** (pasos)
- **¿En qué pantalla/fase del juego?**

### Step 2: Investigar (opcional)
Si el usuario describe el bug pero no sabe la causa:
- Buscar en el código relevante
- Identificar el archivo/función probable
- Formar una hipótesis de la causa raíz

### Step 3: Crear el Issue en GitHub
Usar el comando `gh issue create` con este formato:

```bash
gh issue create \
  --title "[BUG] Título corto del bug" \
  --label bug \
  --body "$(cat <<'EOF'
## Descripción
Qué pasa vs qué debería pasar.

## Pasos para reproducir
1. Paso uno
2. Paso dos
3. ...

## Pantalla/Fase
lobby | playing | turn_active | etc.

## Hipótesis de causa
Archivo y función sospechosos, si se identificaron.

## Archivos relacionados
- `server/gameRoom.js` — función X
- `client/game.js` — handler Y
EOF
)"
```

### Step 4: Confirmar
Mostrar al usuario el número del issue creado y el link.

---

## Modo: Resolver Bug (`/bug fix`)

Cuando el usuario quiere resolver un bug:

### Step 1: Identificar el bug
- Ejecutar `gh issue view <número>` para ver los detalles
- Mostrar los detalles al usuario para confirmar

### Step 2: Investigar la causa raíz
- Leer los archivos relacionados mencionados en el issue
- Reproducir mentalmente el flujo que causa el problema
- Identificar la línea/función exacta del problema

### Step 3: Proponer solución
Antes de escribir código, explicar:
- **Causa raíz identificada:** qué línea/lógica está mal
- **Solución propuesta:** qué cambio se hará
- **Archivos a modificar:** lista

Preguntar: "¿Procedo con el fix?"

### Step 4: Implementar el fix
- Hacer el cambio mínimo necesario para resolver el bug
- NO agregar features nuevas ni refactorizar código no relacionado
- Seguir el estilo de código existente

### Step 5: Verificar
- Si es posible, describir cómo probar que el fix funciona
- Proporcionar test checklist simple:
  ```
  [ ] Reproducir el bug original → ya no ocurre
  [ ] Funcionalidad normal no afectada
  ```

### Step 6: Cerrar el issue
Después de que el fix esté verificado:
```bash
gh issue close <número> --comment "Resuelto en commit <hash>"
```

### Step 7: Commit (si el usuario lo pide)
Usar mensaje de commit:
```
Fix #<número>: Descripción corta del fix

- Causa: explicación breve
- Solución: qué se cambió

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

---

## Prioridades (usar labels)

| Label | Criterio |
|-------|----------|
| `bug` + `priority:high` | Bloquea el juego, crashea, o afecta a todos los usuarios |
| `bug` + `priority:medium` | Afecta la experiencia pero hay workaround |
| `bug` + `priority:low` | Cosmético o edge case raro |

Para agregar prioridad al crear:
```bash
gh issue create --title "[BUG] ..." --label bug --label priority:high --body "..."
```

---

## Ejemplo de uso

**Usuario:** `/bug report` El describer puede hacer click en "Correcto" dos veces seguidas muy rápido y suma doble punto

**Claude debería:**
1. Investigar `client/game.js` → handler de `btn-correct`
2. Investigar `server/gameRoom.js` → `scoreCard()`
3. Crear issue con hipótesis: "Falta debounce en el cliente o validación de cardId en el servidor"
4. Preguntar si resolver ahora
