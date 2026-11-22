# PDF Editor design system

The interface uses shadcn/ui's semantic tokens and component variants, adapted to the editor's TypeScript DOM views. Tailwind CSS compiles the local primitives. The views use native buttons, inputs, and selects.

## Typography and icons

| Role | Typeface and treatment |
| --- | --- |
| Screen and section headings | Lora, semibold, sentence case |
| Body, document names, and controls | Manrope, 13 px by default |
| Secondary text and shortcuts | Manrope, 12 px, muted foreground |
| Zoom and measurements | Manrope with tabular numerals |

Both variable fonts are bundled with Fontsource. Import named Lucide icons and render them with `icon()` from `src/components/ui/icon.ts`. Use 16 px for typical controls and supply an accessible name to every icon-only button.

## Colors and surfaces

`src/styles/theme.css` defines light and dark tokens. Use `background` for the app, `card` for toolbars and panels, `workspace` for the canvas surround, and `popover` for floating controls. Use `primary` for the main action, `accent` for selected tools, and `destructive` for deletion and redaction. Pair them with their corresponding foreground token. Document artwork and annotation colors belong to the PDF.

Use borders for ordinary separation, with modest shadows for floating controls. Use the shared radius and a 4 px spacing grid. Keep labels in sentence case and use plain surfaces and task-focused copy.

## Components

| Primitive | Usage |
| --- | --- |
| `ui-button` + `ui-button--default` | Main action, such as Open file or Apply |
| `ui-button--outline` | Secondary action |
| `ui-button--tool` | Compact toolbar action. Set `aria-pressed` for toggles |
| `ui-button--destructive` | Explicit destructive action |
| `ui-input`, `ui-slider`, `ui-check` | Native form controls with associated labels |
| `ui-badge`, `ui-alert` | Meaningful states and warnings |

Keep focus indicators visible in both themes and preserve keyboard operation when editing a component. Use narrow transitions for interaction feedback and respect reduced motion.

## Document loading

Show the file name while the document opens. Keep page and thumbnail placeholders at the final aspect ratio. Use the shared page raster queue for viewport-prioritized loading and provide a retry when a page fails. While a visible page is pending, animate only the shimmer transform. Keep a static placeholder under reduced motion.

## Startup and theme

The head of `index.html` resolves `pdf_editor_theme` before the stylesheet paints, falling back to the OS color scheme. Its critical background colors must match the `background` tokens. Tauri starts hidden with a dark backing color. The frontend mounts the editor, loads the local heading and body fonts, and reveals the native window after applying the resolved theme. When modifying startup, verify a fresh profile and persisted light and dark preferences, including restarts and an offline launch.

References [shadcn/ui button](https://ui.shadcn.com/docs/components/button), [Manrope](https://fonts.google.com/specimen/Manrope), and [Lora](https://fonts.google.com/specimen/Lora).
