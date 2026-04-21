// Barrel re-export (WS5). The three template sub-panels now live in
// their own files; this module stays so the TemplatesPage import site
// keeps working while code references migrate.
export { TemplateListPanel } from "./TemplateList.js";
export { TemplateEditorPanel } from "./TemplateEditor.js";
export { TemplatePreviewPanel } from "./TemplatePreview.js";
