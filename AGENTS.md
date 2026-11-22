# Repository guidance

Read [the design system](docs/DESIGN_SYSTEM.md) before changing the editor UI.

- Use the local shadcn/ui primitives and semantic theme tokens. Add shared variants in `src/styles/ui.css` and keep editor layout in `src/styles/app.css`.
- Use Lucide for interface icons, Manrope for controls and body text, and Lora for headings. Paths, shortcuts, and numeric measurements use Manrope.
- Keep fonts and styles bundled locally. Preserve the synchronous theme bootstrap in `index.html` and the native window reveal in `src/main.ts`. Review the first visible frame in both themes when changing startup.
- Preserve the existing editor state, Tauri IPC, and keyboard shortcuts when changing presentation.
- Run `npm run build` and `npm test` before handing off frontend changes.
