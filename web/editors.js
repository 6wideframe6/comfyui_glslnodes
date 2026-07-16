import { app } from "../../scripts/app.js"
import { load_glslnode_css } from "./nodescss.js"
import { getJSON } from "./utils.js"

const glslnodes_root = "extensions/comfyui_glslnodes/"

const GLSL_CODE_CHANGE_DEBOUNCE_MS = 150;

function markGraphDirty(node) {
    try {
        node?.setDirtyCanvas?.(true, true);
    } catch (_) {}

    try {
        node?.graph?.setDirtyCanvas?.(true, true);
    } catch (_) {}

    try {
        app?.graph?.setDirtyCanvas?.(true, true);
    } catch (_) {}

    /*
        This is important for Comfy/LiteGraph graph-state invalidation.
        Some frontend builds expose graph.change(), some mainly use
        beforeChange()/afterChange().
    */
    try {
        node?.graph?.change?.();
    } catch (_) {}

    try {
        node?.graph?.beforeChange?.();
        node?.graph?.afterChange?.();
    } catch (_) {}
}

function markDownstreamDirty(node, visited = new Set()) {
    if (!node || !node.graph || visited.has(node.id)) {
        return;
    }

    visited.add(node.id);

    const outputs = node.outputs || [];
    for (const output of outputs) {
        const links = output?.links || [];

        for (const linkId of links) {
            const link = node.graph.links?.[linkId];
            if (!link) {
                continue;
            }

            const target = node.graph.getNodeById?.(link.target_id);
            if (!target) {
                continue;
            }

            try {
                target.setDirtyCanvas?.(true, true);
            } catch (_) {}

            /*
                These flags are harmless if unused, but useful in some
                Comfy/LiteGraph builds/custom nodes that check dirty state.
            */
            target.__glsl_needs_refresh = true;
            target.__glsl_upstream_changed = Date.now();

            markDownstreamDirty(target, visited);
        }
    }
}

function commitWidgetValueToNode(node, widget) {
    if (!node || !widget) {
        return;
    }

    const idx = node.widgets?.indexOf(widget);
    if (idx >= 0) {
        node.widgets_values = node.widgets_values || [];
        node.widgets_values[idx] = widget.value;
    }

    node.__glsl_code_changed = Date.now();

    markDownstreamDirty(node);
    markGraphDirty(node);
}

export const init_editor = async () => {
    // comfyui will try to load these if we leave them as .js files.
    // but ace wants to load them its own way,
    // so we rename them to .js_ and map the features here
    const features = [
        "mode/glsl", "mode-glsl.js_",
        "theme/tomorrow_night_bright", "theme-tomorrow_night_bright.js_",
        "keyboard/vscode", "keybinding-vscode.js_",
        "ext/language_tools", "ext-language_tools.js_",
    ];
    
    for (let i = 0; i < features.length; i += 2) {
        const feature = features[i];
        const js_ = features[i + 1];
        const response = await fetch(`${glslnodes_root}ace/${js_}`);
        const text = await response.text();
        const blob = new Blob([text], { type: `application/javascript` });
        const url = URL.createObjectURL(blob);
        ace.config.setModuleUrl(`ace/${feature}`, url);
    }
}

const getLygiaCompleter = () => {
    getJSON('https://lygia.xyz/glsl.json', (err, data) => {
        if (err)
            return

        let lygiaFiles = [];
        
        for (let i = 0; i < data.length; i++) {
            const file = data[i];
            lygiaFiles.push({
                name: file,
                value: file,
                score: 300,
                meta: "lygia"
            });
        }
        
        return {
            getCompletions: (editor, session, pos, prefix, callback) => {
                if (prefix.length === 0) {
                    callback(null, []);
                    return;
                }
                // console.log(pos, session.getTokenAt(pos.row, pos.column));
                callback(null, lygiaFiles.map(function(ea) {
                    return ea;
                }))
            }
        };
    });

    return null;
}


export class GlslEditorACE {
    static i_editor = 0

    constructor(...args) {
        const [inputName, opts] = args;
        this.name = inputName;
        this.type = opts[0];
        this.options = opts[1];

        this.selectedPointIndex = null;
        this.value = String(this.value ?? this.options.default ?? "");
        this.size = [400, 300];

        // ACE editor
        this.editor = null;
        this.div_widget = null;

        this._commitTimer = null;
        this._settingEditorValue = false;
    }

    setValue(value) {
        this.value = String(value ?? "");

        if (this.editor && this.editor.getValue() !== this.value) {
            this._settingEditorValue = true;
            this.editor.setValue(this.value, -1);
            this.editor.clearSelection();
            this._settingEditorValue = false;
        }
    }

    async serializeValue(nodeId, widgetIndex) {
        return String(this.value ?? "");
    }

    scheduleCommit(node) {
        if (this._commitTimer) {
            clearTimeout(this._commitTimer);
        }

        this._commitTimer = setTimeout(() => {
            commitWidgetValueToNode(node, this);
        }, GLSL_CODE_CHANGE_DEBOUNCE_MS);
    }

    draw(ctx, node, widgetWidth, widgetY) {
        if (node.editor === undefined) {
            const editor_id = `glslnode_editor_${GlslEditorACE.i_editor++}`;

            const glslnode_div = document.createElement("div");
            glslnode_div.id = `${editor_id}_container`;
            glslnode_div.classList.add("glslnodeEditorContainer");

            const editor_pre = document.createElement("pre");
            editor_pre.id = editor_id;
            editor_pre.classList.add("glslnodeEditorPre");
            editor_pre.style.height = "100%";
            editor_pre.style.overflow = "hidden";
            editor_pre.style.margin = "0";

            glslnode_div.appendChild(editor_pre);

            const div_widget = node.addDOMWidget(
                `${editor_id}_widget`,
                "div",
                glslnode_div
            );

            div_widget.glslnode_div = glslnode_div;
            div_widget.editor_pre = editor_pre;

            let langTools = ace.require("ace/ext/language_tools");

            let editor = ace.edit(editor_pre);
            this.editor = editor;

            editor.session.setMode("ace/mode/glsl");
            editor.setTheme("ace/theme/tomorrow_night_bright");

            editor.setOptions({
                keyboardHandler: "ace/keyboard/vscode",
                selectionStyle: "text",
                showPrintMargin: false,
                hasCssTransforms: true,
                highlightActiveLine: false,
            });

            editor.on("change", () => {
                if (this._settingEditorValue) {
                    return;
                }

                const newValue = editor.getValue();

                if (newValue === this.value) {
                    return;
                }

                this.value = newValue;
                this.scheduleCommit(node);
            });

            this._settingEditorValue = true;
            editor.setValue(String(this.value ?? ""), -1);
            editor.clearSelection();
            this._settingEditorValue = false;

            node.div_widget = div_widget;
            node.editor = editor;

            /*
                Initial commit: makes sure restored workflows have the editor
                widget value synchronized with node.widgets_values.
            */
            commitWidgetValueToNode(node, this);
        }

        node.editor.resize();
        node.editor.renderer.updateFull();
    }
}

app.registerExtension({
    name: "glslnodes.editor",
    init: async (app) => {
        load_glslnode_css(document);
        await init_editor();
    },
    getCustomWidgets: () => {
        return {
            GLSL_STRING:  (node, inputName, inputData, app) => {
                return {
                    widget: node.addCustomWidget(new GlslEditorACE(inputName, inputData), ),
                    minWidth: 600,
                    minHeight: 400,
                }
            }
        }
    },
})