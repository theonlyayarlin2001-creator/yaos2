/**
 * s13-editor-open-remote-edit
 *
 * Device B has a Markdown file open in the editor (CRDT binding active).
 * Device A edits the same file through the normal YAOS path.
 * Device B must converge without duplication or editor/CRDT/disk mismatch.
 *
 * Uses marker content so semantic duplication is detectable, not just hash equality.
 *
 * Acceptance:
 *   - B editorHash == crdtHash == diskHash == expectedHash
 *   - final content has exactly one BASELINE and exactly one REMOTE_EDIT_FROM_A
 */

export const SCENARIO_ID = "s13-editor-open-remote-edit";

export const INITIAL_CONTENT = "# S13 Editor Open Remote Edit\n\nBASELINE\n";
export const FINAL_CONTENT = "# S13 Editor Open Remote Edit\n\nBASELINE\nREMOTE_EDIT_FROM_A\n";
